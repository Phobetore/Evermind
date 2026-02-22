# ==============================================================================
# Evermind — Start Script (Windows PowerShell)
# ==============================================================================
# Starts all Evermind services in the correct order:
#   1) LLM servers (chat, memory, judge) via llama-server
#   2) Backend (FastAPI / Uvicorn)
#   3) Frontend (Next.js)
#
# Usage:
#   .\scripts\start.ps1                  # Start all services
#   .\scripts\start.ps1 -BackendOnly     # Start only the backend
#   .\scripts\start.ps1 -SkipLLM         # Start backend + frontend without LLM
# ==============================================================================

param(
    [switch]$BackendOnly,
    [switch]$SkipLLM,
    [switch]$Help
)

$ErrorActionPreference = "Stop"

# ── Paths ─────────────────────────────────────────────────────────────────────
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ProjectRoot = Split-Path -Parent $ScriptDir
$ConfigFile = if ($env:EVERMIND_CONFIG) { $env:EVERMIND_CONFIG } else { Join-Path $ProjectRoot "config.yaml" }
$PidFile = Join-Path $ProjectRoot "data\.pids"
$LogDir = Join-Path $ProjectRoot "logs"

# ── Help ──────────────────────────────────────────────────────────────────────
if ($Help) {
    Write-Host "Usage: .\scripts\start.ps1 [-BackendOnly] [-SkipLLM] [-Help]"
    Write-Host ""
    Write-Host "Options:"
    Write-Host "  -BackendOnly   Start only the backend API server"
    Write-Host "  -SkipLLM       Start backend + frontend without LLM servers"
    Write-Host "  -Help          Show this help message"
    exit 0
}

# ── Helpers ───────────────────────────────────────────────────────────────────

function Log-Info  { param([string]$Msg) Write-Host "[INFO]  $Msg" -ForegroundColor Cyan }
function Log-Ok    { param([string]$Msg) Write-Host "[OK]    $Msg" -ForegroundColor Green }
function Log-Warn  { param([string]$Msg) Write-Host "[WARN]  $Msg" -ForegroundColor Yellow }
function Log-Error { param([string]$Msg) Write-Host "[ERROR] $Msg" -ForegroundColor Red }

function Read-Config {
    param([string]$KeyPath)
    $configPath = $ConfigFile -replace '\\', '/'
    $result = python3 -c @"
import yaml, sys
with open('$configPath') as f:
    cfg = yaml.safe_load(f)
keys = '$KeyPath'.split('.')
val = cfg
for k in keys:
    if isinstance(val, dict):
        val = val.get(k)
    else:
        val = None
        break
print(val if val is not None else '')
"@
    return $result.Trim()
}

function Wait-ForHealth {
    param(
        [string]$Url,
        [string]$Name,
        [int]$Timeout = 60,
        [System.Diagnostics.Process]$Process = $null
    )
    $script:HealthFailureReason = "timeout"
    $elapsed = 0
    while ($elapsed -lt $Timeout) {
        try {
            $response = Invoke-WebRequest -Uri $Url -TimeoutSec 2 -UseBasicParsing -ErrorAction SilentlyContinue
            if ($response.StatusCode -eq 200) { return $true }
        } catch { }
        # If a process was provided, check that it is still running
        if ($null -ne $Process -and $Process.HasExited) {
            $Process.WaitForExit()
            $exitCode = if ($null -ne $Process.ExitCode) { $Process.ExitCode } else { "unknown" }
            Log-Error "$Name process (PID $($Process.Id)) exited unexpectedly with code $exitCode."
            $script:HealthFailureReason = "exited"
            return $false
        }
        Start-Sleep -Seconds 2
        $elapsed += 2
    }
    return $false
}

function Test-PortFree {
    param([int]$Port)
    $conn = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue
    return ($null -eq $conn)
}

function Test-GpuAvailable {
    # Check for Vulkan support via vulkaninfo (most reliable for Vulkan-backed llama.cpp)
    try {
        $vkOutput = & vulkaninfo --summary 2>$null
        if ($LASTEXITCODE -eq 0 -and $vkOutput -match 'GPU') {
            return $true
        }
    } catch { }
    # Fallback: check for a dedicated GPU via WMI
    try {
        $gpus = Get-CimInstance -ClassName Win32_VideoController -ErrorAction SilentlyContinue
        foreach ($gpu in $gpus) {
            if ($gpu.AdapterRAM -gt 1GB -and $gpu.Name -notmatch 'Microsoft Basic|Remote Desktop') {
                return $true
            }
        }
    } catch { }
    return $false
}

# ── Pre-flight checks ────────────────────────────────────────────────────────

Write-Host ""
Write-Host "=== Evermind -- Demarrage ===" -ForegroundColor Cyan
Write-Host ""

# Check config file
if (-Not (Test-Path $ConfigFile)) {
    Log-Error "Configuration file not found: $ConfigFile"
    Log-Error "Run '.\scripts\setup.sh' (Linux) or ensure config.yaml exists, then set EVERMIND_CONFIG."
    exit 1
}
Log-Ok "Configuration: $ConfigFile"

# Check if already running
if (Test-Path $PidFile) {
    Log-Warn "PID file already exists: $PidFile"
    Log-Warn "Evermind may already be running. Use '.\scripts\stop.ps1' first."
    exit 1
}

# Read config
$BindHost = Read-Config "bind_host"
$BackendPort = Read-Config "backend_port"
$FrontendPort = Read-Config "frontend_port"

if ([string]::IsNullOrEmpty($BindHost))     { $BindHost = "127.0.0.1" }
if ([string]::IsNullOrEmpty($BackendPort))  { $BackendPort = "8000" }
if ([string]::IsNullOrEmpty($FrontendPort)) { $FrontendPort = "3000" }

# Create required directories
New-Item -ItemType Directory -Force -Path (Join-Path $ProjectRoot "data") | Out-Null
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $ProjectRoot "models\chat") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $ProjectRoot "models\memory") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $ProjectRoot "models\judge") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $ProjectRoot "models\embeddings") | Out-Null

Log-Ok "Directories verified"

# Check ports
if (-Not (Test-PortFree $BackendPort)) {
    Log-Error "Port $BackendPort is already in use."
    exit 1
}
if ((-Not $BackendOnly) -and (-Not (Test-PortFree $FrontendPort))) {
    Log-Error "Port $FrontendPort is already in use."
    exit 1
}
Log-Ok "Required ports are available"

# ── Track PIDs ────────────────────────────────────────────────────────────────
$Pids = @()

function Save-Pids {
    $Pids | Out-File -FilePath $PidFile -Encoding utf8
}

function Cleanup-OnError {
    Log-Error "Startup failed -- stopping already-launched services..."
    foreach ($entry in $Pids) {
        $parts = $entry -split "="
        $processId = [int]$parts[1]
        try { Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue } catch { }
    }
    Remove-Item -Path $PidFile -Force -ErrorAction SilentlyContinue
    exit 1
}

# ── Step 1: Start LLM servers ────────────────────────────────────────────────

$Step = 1
$TotalSteps = 3
if ($BackendOnly) { $TotalSteps = 1 }
elseif ($SkipLLM) { $TotalSteps = 2 }

if ((-Not $BackendOnly) -and (-Not $SkipLLM)) {
    $LlamaServer = Join-Path $ProjectRoot "bin\llama-server.exe"

    if (-Not (Test-Path $LlamaServer)) {
        Log-Warn "llama-server.exe not found at $LlamaServer"
        Log-Warn "Skipping LLM server startup. Ensure LLM servers are started externally."
    } else {
        # Verify the binary can execute at all (catches missing DLLs / arch mismatch)
        try {
            $testProc = Start-Process -FilePath $LlamaServer -ArgumentList "--help" `
                -Wait -PassThru -NoNewWindow `
                -RedirectStandardOutput (Join-Path $LogDir "llm-preflight.log") `
                -RedirectStandardError (Join-Path $LogDir "llm-preflight-err.log")
            if ($null -ne $testProc.ExitCode -and $testProc.ExitCode -ne 0) {
                throw "llama-server --help exited with code $($testProc.ExitCode)"
            }
        } catch {
            Log-Error "llama-server.exe failed to execute: $LlamaServer"
            Log-Error "The binary may be incompatible with your system or missing DLLs."
            Log-Error "Try running '$LlamaServer --help' manually to diagnose."
            Remove-Item (Join-Path $LogDir "llm-preflight.log") -Force -ErrorAction SilentlyContinue
            Remove-Item (Join-Path $LogDir "llm-preflight-err.log") -Force -ErrorAction SilentlyContinue
            exit 1
        }
        Remove-Item (Join-Path $LogDir "llm-preflight.log") -Force -ErrorAction SilentlyContinue
        Remove-Item (Join-Path $LogDir "llm-preflight-err.log") -Force -ErrorAction SilentlyContinue
        Log-Ok "llama-server binary verified"

        # Detect GPU availability once before starting servers
        $GpuDetected = Test-GpuAvailable
        if ($GpuDetected) {
            Log-Ok "GPU detected -- GPU offloading enabled"
        } else {
            Log-Info "No compatible GPU detected -- LLM servers will run on CPU"
        }

        foreach ($ServerName in @("chat", "memory", "judge")) {
            $ServerPort = Read-Config "llm_servers.$ServerName.port"
            $ModelPath  = Read-Config "llm_servers.$ServerName.model_path"
            $Ctx        = Read-Config "llm_servers.$ServerName.ctx"
            $NGpuLayers = Read-Config "llm_servers.$ServerName.n_gpu_layers"
            $Threads    = Read-Config "llm_servers.$ServerName.threads"

            if ([string]::IsNullOrEmpty($ServerPort)) { $ServerPort = "8081" }
            if ([string]::IsNullOrEmpty($Ctx))        { $Ctx = "8192" }
            if ([string]::IsNullOrEmpty($NGpuLayers))  { $NGpuLayers = "-1" }
            if ([string]::IsNullOrEmpty($Threads))     { $Threads = "4" }

            # If GPU was not detected, force CPU-only mode
            if ((-Not $GpuDetected) -and ($NGpuLayers -ne "0")) {
                $NGpuLayers = "0"
            }

            $FullModelPath = Join-Path $ProjectRoot $ModelPath

            if (-Not (Test-Path $FullModelPath)) {
                Log-Warn "Model file not found for ${ServerName}: $FullModelPath"
                Log-Warn "Skipping $ServerName server."
                continue
            }

            if (-Not (Test-PortFree $ServerPort)) {
                Log-Warn "Port $ServerPort in use -- skipping $ServerName server."
                continue
            }

            Log-Info "[$Step/$TotalSteps] Starting LLM server: $ServerName (port $ServerPort)..."
            Log-Info "  Command: $LlamaServer --model `"$FullModelPath`" --host $BindHost --port $ServerPort --ctx-size $Ctx --n-gpu-layers $NGpuLayers --threads $Threads"

            $proc = Start-Process -FilePath $LlamaServer `
                -ArgumentList "--model `"$FullModelPath`" --host $BindHost --port $ServerPort --ctx-size $Ctx --n-gpu-layers $NGpuLayers --threads $Threads" `
                -PassThru -NoNewWindow `
                -RedirectStandardOutput (Join-Path $LogDir "llm-$ServerName.log") `
                -RedirectStandardError (Join-Path $LogDir "llm-$ServerName-err.log")

            $Pids += "llm-$ServerName=$($proc.Id)"

            $healthOk = Wait-ForHealth "http://${BindHost}:${ServerPort}/health" $ServerName 60 $proc

            # GPU fallback: if startup failed and GPU layers were requested, try
            # partial offloading first, then fall back to CPU-only.
            if ((-Not $healthOk) -and ($NGpuLayers -ne "0")) {
                # Build a list of fallback values to try before giving up.
                # When the user requested all layers (-1), try a partial offload
                # (32 layers covers most mid-size models) then CPU-only.
                if ($NGpuLayers -eq "-1") {
                    $FallbackValues = @(32, 0)
                } else {
                    $FallbackValues = @(0)
                }

                $prevNgl = $NGpuLayers
                foreach ($FallbackNgl in $FallbackValues) {
                    if ($FallbackNgl -eq 0) {
                        Log-Warn "GPU mode failed for '$ServerName' -- retrying with --n-gpu-layers 0 (CPU-only)..."
                    } else {
                        Log-Warn "Full GPU offload failed for '$ServerName' -- retrying with --n-gpu-layers $FallbackNgl (partial)..."
                    }
                    try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch { }
                    # Wait for the process to fully exit
                    try { $null = $proc.WaitForExit(10000) } catch { }
                    # Preserve the previous attempt's logs for diagnostics
                    $gpuStdout = Join-Path $LogDir "llm-$ServerName.log"
                    $gpuStderr = Join-Path $LogDir "llm-$ServerName-err.log"
                    if (Test-Path $gpuStdout) { Move-Item $gpuStdout (Join-Path $LogDir "llm-$ServerName-gpu-failed-ngl$prevNgl.log") -Force -ErrorAction SilentlyContinue }
                    if (Test-Path $gpuStderr) { Move-Item $gpuStderr (Join-Path $LogDir "llm-$ServerName-gpu-failed-ngl$prevNgl-err.log") -Force -ErrorAction SilentlyContinue }
                    # Wait for the port to be released before retrying
                    $portWait = 0
                    while (($portWait -lt 10) -and (-Not (Test-PortFree $ServerPort))) {
                        Start-Sleep -Seconds 1
                        $portWait++
                    }

                    $proc = Start-Process -FilePath $LlamaServer `
                        -ArgumentList "--model `"$FullModelPath`" --host $BindHost --port $ServerPort --ctx-size $Ctx --n-gpu-layers $FallbackNgl --threads $Threads" `
                        -PassThru -NoNewWindow `
                        -RedirectStandardOutput (Join-Path $LogDir "llm-$ServerName.log") `
                        -RedirectStandardError (Join-Path $LogDir "llm-$ServerName-err.log")

                    $Pids[$Pids.Count - 1] = "llm-$ServerName=$($proc.Id)"

                    $healthOk = Wait-ForHealth "http://${BindHost}:${ServerPort}/health" $ServerName 60 $proc
                    if ($healthOk) {
                        if ($FallbackNgl -eq 0) {
                            Log-Ok "LLM server '$ServerName' is healthy in CPU-only mode (PID $($proc.Id))"
                            Log-Warn "GPU offloading failed -- '$ServerName' is running on CPU (this will be slower)."
                        } else {
                            Log-Ok "LLM server '$ServerName' is healthy with --n-gpu-layers $FallbackNgl (PID $($proc.Id))"
                            Log-Warn "Full GPU offload failed -- '$ServerName' is running with partial GPU offloading."
                        }
                        break
                    }
                    $prevNgl = $FallbackNgl
                }

                if ($healthOk) {
                    continue
                }
            }

            if ($healthOk) {
                Log-Ok "LLM server '$ServerName' is healthy (PID $($proc.Id))"
            } else {
                if ($script:HealthFailureReason -eq "timeout") {
                    Log-Error "LLM server '$ServerName' failed to start within 60 seconds."
                }
                $stdoutLog = Join-Path $LogDir "llm-$ServerName.log"
                $stderrLog = Join-Path $LogDir "llm-$ServerName-err.log"
                $hasOutput = $false
                if ((Test-Path $stderrLog) -and (Get-Item $stderrLog).Length -gt 0) {
                    Log-Error "Last 20 lines of ${stderrLog}:"
                    Get-Content $stderrLog -Tail 20 | ForEach-Object { Write-Host "         $_" }
                    $hasOutput = $true
                }
                if ((Test-Path $stdoutLog) -and (Get-Item $stdoutLog).Length -gt 0) {
                    Log-Error "Last 20 lines of ${stdoutLog}:"
                    Get-Content $stdoutLog -Tail 20 | ForEach-Object { Write-Host "         $_" }
                    $hasOutput = $true
                }
                if (-Not $hasOutput) {
                    Log-Error "Log files are empty."
                    Log-Error "The server process may have crashed before producing output."
                    Log-Error "Verify that the llama-server binary is compatible with your system."
                }
                Cleanup-OnError
            }
        }
    }
    $Step++
}

# ── Step 2: Start Backend ────────────────────────────────────────────────────

Log-Info "[$Step/$TotalSteps] Starting backend (port $BackendPort)..."

$backendProc = Start-Process -FilePath "python3" `
    -ArgumentList "-m uvicorn app.main:app --host $BindHost --port $BackendPort" `
    -WorkingDirectory (Join-Path $ProjectRoot "backend") `
    -PassThru -NoNewWindow `
    -RedirectStandardOutput (Join-Path $LogDir "backend.log") `
    -RedirectStandardError (Join-Path $LogDir "backend-err.log")

$Pids += "backend=$($backendProc.Id)"

if (Wait-ForHealth "http://${BindHost}:${BackendPort}/health" "backend" 30 $backendProc) {
    Log-Ok "Backend is healthy (PID $($backendProc.Id))"
} else {
    if ($script:HealthFailureReason -eq "timeout") {
        Log-Error "Backend failed to start within 30 seconds."
    }
    Log-Error "Check logs: $(Join-Path $LogDir 'backend.log')"
    Cleanup-OnError
}
$Step++

# ── Step 3: Start Frontend ───────────────────────────────────────────────────

if (-Not $BackendOnly) {
    Log-Info "[$Step/$TotalSteps] Starting frontend (port $FrontendPort)..."

    $FrontendDir = Join-Path $ProjectRoot "frontend"
    $NextBin = Join-Path $FrontendDir "node_modules\next\dist\bin\next"

    if (-Not (Test-Path $NextBin)) {
        Log-Error "Next.js binary not found: $NextBin"
        Log-Error "Run 'cd frontend && npm install' first."
        Cleanup-OnError
    }

    # next start requires a production build (.next/BUILD_ID is created by 'next build')
    $NextBuildId = Join-Path (Join-Path $FrontendDir ".next") "BUILD_ID"
    if (-Not (Test-Path $NextBuildId)) {
        Log-Info "Frontend build not found -- running 'npm run build'..."
        if (-Not (Get-Command npm -ErrorAction SilentlyContinue)) {
            Log-Error "npm not found in PATH. Ensure Node.js/npm is installed."
            Cleanup-OnError
        }
        $buildProc = Start-Process -FilePath "cmd.exe" `
            -ArgumentList "/c", "cd /d `"$FrontendDir`" && npm run build" `
            -WorkingDirectory $FrontendDir `
            -Wait -PassThru -NoNewWindow `
            -RedirectStandardOutput (Join-Path $LogDir "frontend-build.log") `
            -RedirectStandardError (Join-Path $LogDir "frontend-build-err.log")
        if ($null -eq $buildProc.ExitCode -or $buildProc.ExitCode -ne 0) {
            Log-Error "Frontend build failed. Check logs: $(Join-Path $LogDir 'frontend-build.log')"
            Cleanup-OnError
        }
        if (-Not (Test-Path $NextBuildId)) {
            Log-Error "Build completed but .next/BUILD_ID was not created in: $FrontendDir"
            Log-Error "Check logs: $(Join-Path $LogDir 'frontend-build.log')"
            Cleanup-OnError
        }
        Log-Ok "Frontend build completed"
    }

    $frontendProc = Start-Process -FilePath "node" `
        -ArgumentList "`"$NextBin`"", "start", "`"$FrontendDir`"", "--port", "$FrontendPort", "--hostname", "$BindHost" `
        -WorkingDirectory $FrontendDir `
        -PassThru -NoNewWindow `
        -RedirectStandardOutput (Join-Path $LogDir "frontend.log") `
        -RedirectStandardError (Join-Path $LogDir "frontend-err.log")

    $Pids += "frontend=$($frontendProc.Id)"

    if (Wait-ForHealth "http://${BindHost}:${FrontendPort}" "frontend" 60 $frontendProc) {
        Log-Ok "Frontend is healthy (PID $($frontendProc.Id))"
    } else {
        Log-Warn "Frontend may still be starting -- check logs: $(Join-Path $LogDir 'frontend.log')"
    }
}

# ── Save PIDs & summary ──────────────────────────────────────────────────────

Save-Pids

Write-Host ""
Write-Host "=== Evermind is running! ===" -ForegroundColor Green
Write-Host ""
Write-Host "  Backend:  http://${BindHost}:${BackendPort}" -ForegroundColor Cyan
if (-Not $BackendOnly) {
    Write-Host "  Frontend: http://${BindHost}:${FrontendPort}" -ForegroundColor Cyan
}
Write-Host "  API docs: http://${BindHost}:${BackendPort}/docs" -ForegroundColor Cyan
Write-Host ""
Write-Host "  PIDs:     $PidFile"
Write-Host "  Logs:     $LogDir\"
Write-Host ""
Write-Host "  Stop:     .\scripts\stop.ps1" -ForegroundColor Cyan
Write-Host ""
