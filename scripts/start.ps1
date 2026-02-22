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
    $result = python3 -c @"
import yaml, sys
with open('$ConfigFile') as f:
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
        [int]$Timeout = 60
    )
    $elapsed = 0
    while ($elapsed -lt $Timeout) {
        try {
            $response = Invoke-WebRequest -Uri $Url -TimeoutSec 2 -UseBasicParsing -ErrorAction SilentlyContinue
            if ($response.StatusCode -eq 200) { return $true }
        } catch { }
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

# ── Pre-flight checks ────────────────────────────────────────────────────────

Write-Host ""
Write-Host "=== Evermind — Demarrage ===" -ForegroundColor Cyan
Write-Host ""

# Check config file
if (-Not (Test-Path $ConfigFile)) {
    Log-Error "Configuration file not found: $ConfigFile"
    Log-Error "Run '.\scripts\setup.sh' first or set EVERMIND_CONFIG."
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
    Log-Error "Startup failed — stopping already-launched services..."
    foreach ($entry in $Pids) {
        $parts = $entry -split "="
        $pid = [int]$parts[1]
        try { Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue } catch { }
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

            $FullModelPath = Join-Path $ProjectRoot $ModelPath

            if (-Not (Test-Path $FullModelPath)) {
                Log-Warn "Model file not found for ${ServerName}: $FullModelPath"
                Log-Warn "Skipping $ServerName server."
                continue
            }

            if (-Not (Test-PortFree $ServerPort)) {
                Log-Warn "Port $ServerPort in use — skipping $ServerName server."
                continue
            }

            Log-Info "[$Step/$TotalSteps] Starting LLM server: $ServerName (port $ServerPort)..."

            $proc = Start-Process -FilePath $LlamaServer `
                -ArgumentList "--model `"$FullModelPath`" --port $ServerPort --ctx-size $Ctx --n-gpu-layers $NGpuLayers --threads $Threads" `
                -PassThru -NoNewWindow `
                -RedirectStandardOutput (Join-Path $LogDir "llm-$ServerName.log") `
                -RedirectStandardError (Join-Path $LogDir "llm-$ServerName-err.log")

            $Pids += "llm-$ServerName=$($proc.Id)"

            if (Wait-ForHealth "http://${BindHost}:${ServerPort}/health" $ServerName 60) {
                Log-Ok "LLM server '$ServerName' is healthy (PID $($proc.Id))"
            } else {
                Log-Error "LLM server '$ServerName' failed to start within 60 seconds."
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

if (Wait-ForHealth "http://${BindHost}:${BackendPort}/health" "backend" 30) {
    Log-Ok "Backend is healthy (PID $($backendProc.Id))"
} else {
    Log-Error "Backend failed to start within 30 seconds."
    Log-Error "Check logs: $(Join-Path $LogDir 'backend.log')"
    Cleanup-OnError
}
$Step++

# ── Step 3: Start Frontend ───────────────────────────────────────────────────

if (-Not $BackendOnly) {
    Log-Info "[$Step/$TotalSteps] Starting frontend (port $FrontendPort)..."

    $frontendProc = Start-Process -FilePath "npm" `
        -ArgumentList "run start -- --port $FrontendPort" `
        -WorkingDirectory (Join-Path $ProjectRoot "frontend") `
        -PassThru -NoNewWindow `
        -RedirectStandardOutput (Join-Path $LogDir "frontend.log") `
        -RedirectStandardError (Join-Path $LogDir "frontend-err.log")

    $Pids += "frontend=$($frontendProc.Id)"

    if (Wait-ForHealth "http://${BindHost}:${FrontendPort}" "frontend" 60) {
        Log-Ok "Frontend is healthy (PID $($frontendProc.Id))"
    } else {
        Log-Warn "Frontend may still be starting — check logs: $(Join-Path $LogDir 'frontend.log')"
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
