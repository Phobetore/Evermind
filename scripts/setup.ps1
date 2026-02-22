# ==============================================================================
# Evermind — Setup Script (Windows PowerShell)
# ==============================================================================
# Initializes the project environment:
#   - Creates required directories (models/, logs/, data/)
#   - Validates config.yaml
#   - Checks system dependencies (Python, Node.js, pip, npm)
#   - Installs backend & frontend dependencies
#
# Usage:
#   .\scripts\setup.ps1              # Full setup
#   .\scripts\setup.ps1 -CheckOnly   # Only check dependencies (no install)
# ==============================================================================

param(
    [switch]$CheckOnly,
    [switch]$Help
)

$ErrorActionPreference = "Stop"

# ── Paths ─────────────────────────────────────────────────────────────────────
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ProjectRoot = Split-Path -Parent $ScriptDir
$ConfigFile = if ($env:EVERMIND_CONFIG) { $env:EVERMIND_CONFIG } else { Join-Path $ProjectRoot "config.yaml" }

# ── Help ──────────────────────────────────────────────────────────────────────
if ($Help) {
    Write-Host "Usage: .\scripts\setup.ps1 [-CheckOnly] [-Help]"
    Write-Host ""
    Write-Host "Options:"
    Write-Host "  -CheckOnly   Only check dependencies (no install)"
    Write-Host "  -Help        Show this help message"
    exit 0
}

# ── Helpers ───────────────────────────────────────────────────────────────────

function Log-Info  { param([string]$Msg) Write-Host "[INFO]  $Msg" -ForegroundColor Cyan }
function Log-Ok    { param([string]$Msg) Write-Host "[OK]    $Msg" -ForegroundColor Green }
function Log-Warn  { param([string]$Msg) Write-Host "[WARN]  $Msg" -ForegroundColor Yellow }
function Log-Error { param([string]$Msg) Write-Host "[ERROR] $Msg" -ForegroundColor Red }

$script:Errors = 0

function Check-Command {
    param(
        [string]$Cmd,
        [string]$Name
    )
    $found = Get-Command $Cmd -ErrorAction SilentlyContinue
    if ($found) {
        try {
            $version = & $Cmd --version 2>&1 | Select-Object -First 1
            Log-Ok "${Name}: $version"
        } catch {
            Log-Ok "${Name}: found"
        }
    } else {
        Log-Error "${Name} not found (command: $Cmd)"
        $script:Errors++
    }
}

Write-Host ""
Write-Host "=== Evermind -- Setup ===" -ForegroundColor Cyan
Write-Host ""

# ── 1. Check system dependencies ─────────────────────────────────────────────

Write-Host "--- Checking dependencies ---" -ForegroundColor Cyan
Write-Host ""

Check-Command "python3" "Python 3"
Check-Command "pip3" "pip"
Check-Command "node" "Node.js"
Check-Command "npm" "npm"

# Optional: check for llama-server
$LlamaServer = Join-Path $ProjectRoot "bin\llama-server.exe"
if (Test-Path $LlamaServer) {
    Log-Ok "llama-server: $LlamaServer"
} else {
    Log-Warn "llama-server not found at $LlamaServer (optional -- for LLM serving)"
}

Write-Host ""

if ($script:Errors -gt 0) {
    Log-Error "$($script:Errors) required dependency/ies missing. Please install them first."
    exit 1
}

# ── 2. Validate config.yaml ──────────────────────────────────────────────────

Write-Host "--- Validating configuration ---" -ForegroundColor Cyan
Write-Host ""

if (-Not (Test-Path $ConfigFile)) {
    Log-Error "Configuration file not found: $ConfigFile"
    exit 1
}

$backendPath = ($ProjectRoot -replace '\\', '/') + '/backend'
$configPath = $ConfigFile -replace '\\', '/'
$validationResult = python3 -c @"
import sys
sys.path.insert(0, '$backendPath')
from app.config import load_config
from pathlib import Path
try:
    cfg = load_config(Path('$configPath'))
    servers = list(cfg.llm_servers.keys())
    profiles = list(cfg.profiles.keys())
    sep = ','
    s_str = sep.join(servers)
    p_str = sep.join(profiles)
    print(f'OK|servers={len(servers)}({s_str})|profiles={len(profiles)}({p_str})|embeddings={cfg.embeddings.model_name}')
except Exception as e:
    print(f'ERROR|{e}')
"@

if ($validationResult -match "^OK") {
    Log-Ok "config.yaml is valid"
    $parts = $validationResult -split '\|'
    foreach ($part in $parts[1..($parts.Length - 1)]) {
        Log-Info "  $part"
    }
} else {
    Log-Error "config.yaml validation failed: $validationResult"
    exit 1
}

Write-Host ""

if ($CheckOnly) {
    Write-Host "=== All checks passed ===" -ForegroundColor Green
    Write-Host ""
    exit 0
}

# ── 3. Create directories ────────────────────────────────────────────────────

Write-Host "--- Creating directories ---" -ForegroundColor Cyan
Write-Host ""

$dirs = @(
    (Join-Path $ProjectRoot "data"),
    (Join-Path $ProjectRoot "logs"),
    (Join-Path $ProjectRoot "models\chat"),
    (Join-Path $ProjectRoot "models\memory"),
    (Join-Path $ProjectRoot "models\judge"),
    (Join-Path $ProjectRoot "models\embeddings")
)

foreach ($dir in $dirs) {
    if (-Not (Test-Path $dir)) {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        $relative = $dir.Substring($ProjectRoot.Length + 1)
        Log-Ok "Created: $relative"
    } else {
        $relative = $dir.Substring($ProjectRoot.Length + 1)
        Log-Info "Exists:  $relative"
    }
}

Write-Host ""

# ── 4. Install backend dependencies ──────────────────────────────────────────

Write-Host "--- Installing backend dependencies ---" -ForegroundColor Cyan
Write-Host ""

Push-Location (Join-Path $ProjectRoot "backend")
pip3 install -e ".[dev]" --quiet 2>&1 | Select-Object -Last 2
if ($LASTEXITCODE -ne 0) {
    Log-Error "Backend dependency installation failed (exit code $LASTEXITCODE)"
    Pop-Location
    exit 1
}
Log-Ok "Backend dependencies installed"
Pop-Location

Write-Host ""

# ── 5. Install frontend dependencies ─────────────────────────────────────────

Write-Host "--- Installing frontend dependencies ---" -ForegroundColor Cyan
Write-Host ""

Push-Location (Join-Path $ProjectRoot "frontend")
npm install --silent 2>&1 | Select-Object -Last 2
if ($LASTEXITCODE -ne 0) {
    Log-Error "Frontend dependency installation failed (exit code $LASTEXITCODE)"
    Pop-Location
    exit 1
}
Log-Ok "Frontend dependencies installed"
Pop-Location

Write-Host ""

# ── Summary ───────────────────────────────────────────────────────────────────

Write-Host "=== Setup complete ===" -ForegroundColor Green
Write-Host ""
Write-Host "  Start:  .\scripts\start.ps1" -ForegroundColor Cyan
Write-Host "  Test:   cd backend; python -m pytest" -ForegroundColor Cyan
Write-Host "  Lint:   cd backend; ruff check ." -ForegroundColor Cyan
Write-Host ""
