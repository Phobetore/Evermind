# ==============================================================================
# Evermind — Stop Script (Windows PowerShell)
# ==============================================================================
# Gracefully stops all Evermind services using the PID file.
#
# Usage:
#   .\scripts\stop.ps1
# ==============================================================================

$ErrorActionPreference = "Stop"

# ── Paths ─────────────────────────────────────────────────────────────────────
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ProjectRoot = Split-Path -Parent $ScriptDir
$PidFile = Join-Path $ProjectRoot "data\.pids"

# ── Helpers ───────────────────────────────────────────────────────────────────

function Log-Info  { param([string]$Msg) Write-Host "[INFO]  $Msg" -ForegroundColor Cyan }
function Log-Ok    { param([string]$Msg) Write-Host "[OK]    $Msg" -ForegroundColor Green }
function Log-Warn  { param([string]$Msg) Write-Host "[WARN]  $Msg" -ForegroundColor Yellow }
function Log-Error { param([string]$Msg) Write-Host "[ERROR] $Msg" -ForegroundColor Red }

Write-Host ""
Write-Host "=== Evermind -- Arret ===" -ForegroundColor Cyan
Write-Host ""

# ── Check PID file ───────────────────────────────────────────────────────────

if (-Not (Test-Path $PidFile)) {
    Log-Warn "PID file not found: $PidFile"
    Log-Warn "Evermind may not be running (or was started externally)."
    exit 0
}

# ── Stop services (reverse order) ────────────────────────────────────────────

$Lines = Get-Content $PidFile
$Stopped = 0
$Failed = 0

# Reverse to stop in LIFO order (frontend → backend → LLM)
[array]::Reverse($Lines)

foreach ($Line in $Lines) {
    $Line = $Line.Trim()
    if ([string]::IsNullOrEmpty($Line)) { continue }

    $parts = $Line -split "=", 2
    $Label = $parts[0]
    $Pid = [int]$parts[1]

    $proc = Get-Process -Id $Pid -ErrorAction SilentlyContinue

    if ($null -ne $proc) {
        Log-Info "Stopping $Label (PID $Pid)..."

        try {
            Stop-Process -Id $Pid -ErrorAction SilentlyContinue
        } catch { }

        # Wait up to 10 seconds for graceful shutdown
        $elapsed = 0
        while ($elapsed -lt 10) {
            $proc = Get-Process -Id $Pid -ErrorAction SilentlyContinue
            if ($null -eq $proc) { break }
            Start-Sleep -Seconds 1
            $elapsed++
        }

        # Force-kill if still running
        $proc = Get-Process -Id $Pid -ErrorAction SilentlyContinue
        if ($null -ne $proc) {
            Log-Warn "$Label did not stop gracefully -- force-killing..."
            try {
                Stop-Process -Id $Pid -Force -ErrorAction SilentlyContinue
            } catch { }
            Start-Sleep -Seconds 1
        }

        $proc = Get-Process -Id $Pid -ErrorAction SilentlyContinue
        if ($null -eq $proc) {
            Log-Ok "$Label stopped"
            $Stopped++
        } else {
            Log-Error "Failed to stop $Label (PID $Pid)"
            $Failed++
        }
    } else {
        Log-Warn "$Label (PID $Pid) is not running"
    }
}

# ── Clean up PID file ────────────────────────────────────────────────────────

Remove-Item -Path $PidFile -Force -ErrorAction SilentlyContinue

Write-Host ""
if ($Failed -eq 0) {
    Write-Host "=== Evermind stopped ($Stopped services) ===" -ForegroundColor Green
} else {
    Write-Host "=== Evermind stopped with issues ($Stopped ok, $Failed failed) ===" -ForegroundColor Yellow
}
Write-Host ""
