# ==============================================================================
# Evermind — Health Check Script (Windows PowerShell)
# ==============================================================================
# Checks the health status of all Evermind services.
#
# Usage:
#   .\scripts\health-check.ps1           # Check all services
#   .\scripts\health-check.ps1 -Json     # Output as JSON
#
# Exit codes:
#   0 — All checked services are healthy
#   1 — At least one service is unhealthy
# ==============================================================================

param(
    [switch]$Json,
    [switch]$Help
)

$ErrorActionPreference = "Stop"

# ── Paths ─────────────────────────────────────────────────────────────────────
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ProjectRoot = Split-Path -Parent $ScriptDir
$ConfigFile = if ($env:EVERMIND_CONFIG) { $env:EVERMIND_CONFIG } else { Join-Path $ProjectRoot "config.yaml" }

# ── Help ──────────────────────────────────────────────────────────────────────
if ($Help) {
    Write-Host "Usage: .\scripts\health-check.ps1 [-Json] [-Help]"
    Write-Host ""
    Write-Host "Options:"
    Write-Host "  -Json    Output results as JSON"
    Write-Host "  -Help    Show this help message"
    exit 0
}

# ── Helpers ───────────────────────────────────────────────────────────────────

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

function Check-Health {
    param(
        [string]$Url,
        [int]$Timeout = 5
    )
    try {
        $response = Invoke-WebRequest -Uri $Url -TimeoutSec $Timeout -UseBasicParsing -ErrorAction SilentlyContinue
        return [int]$response.StatusCode
    } catch {
        return 0
    }
}

# ── Read config ──────────────────────────────────────────────────────────────

if (-Not (Test-Path $ConfigFile)) {
    Write-Host "Configuration file not found: $ConfigFile" -ForegroundColor Red
    exit 1
}

$BindHost = Read-Config "bind_host"
$BackendPort = Read-Config "backend_port"
$FrontendPort = Read-Config "frontend_port"

if ([string]::IsNullOrEmpty($BindHost))     { $BindHost = "127.0.0.1" }
if ([string]::IsNullOrEmpty($BackendPort))  { $BackendPort = "8000" }
if ([string]::IsNullOrEmpty($FrontendPort)) { $FrontendPort = "3000" }

# ── Check services ───────────────────────────────────────────────────────────

$Results = @{}
$Unhealthy = 0

# Backend
$httpCode = Check-Health "http://${BindHost}:${BackendPort}/health"
if ($httpCode -eq 200) {
    $Results["backend"] = "healthy"
} else {
    $Results["backend"] = "unhealthy (HTTP $httpCode)"
    $Unhealthy++
}

# Frontend
$httpCode = Check-Health "http://${BindHost}:${FrontendPort}"
if ($httpCode -eq 200) {
    $Results["frontend"] = "healthy"
} else {
    $Results["frontend"] = "unhealthy (HTTP $httpCode)"
    $Unhealthy++
}

# LLM servers
foreach ($ServerName in @("chat", "memory", "judge")) {
    $ServerPort = Read-Config "llm_servers.$ServerName.port"
    if ([string]::IsNullOrEmpty($ServerPort)) { $ServerPort = "8081" }

    $httpCode = Check-Health "http://${BindHost}:${ServerPort}/health"
    if ($httpCode -eq 200) {
        $Results["llm-$ServerName"] = "healthy"
    } else {
        $Results["llm-$ServerName"] = "unhealthy (HTTP $httpCode)"
        $Unhealthy++
    }
}

# ── Output ───────────────────────────────────────────────────────────────────

$ServiceOrder = @("backend", "frontend", "llm-chat", "llm-memory", "llm-judge")

if ($Json) {
    $jsonObj = @{}
    foreach ($key in $ServiceOrder) {
        $status = $Results[$key]
        $isHealthy = ($status -eq "healthy")
        $jsonObj[$key] = @{ status = $status; healthy = $isHealthy }
    }
    $jsonObj | ConvertTo-Json
} else {
    Write-Host ""
    Write-Host "=== Evermind — Health Check ===" -ForegroundColor Cyan
    Write-Host ""
    foreach ($key in $ServiceOrder) {
        $status = $Results[$key]
        if ($status -eq "healthy") {
            Write-Host "  + ${key}: $status" -ForegroundColor Green
        } else {
            Write-Host "  x ${key}: $status" -ForegroundColor Red
        }
    }
    Write-Host ""
    if ($Unhealthy -eq 0) {
        Write-Host "  All services are healthy" -ForegroundColor Green
    } else {
        Write-Host "  $Unhealthy service(s) unhealthy" -ForegroundColor Yellow
    }
    Write-Host ""
}

exit $Unhealthy
