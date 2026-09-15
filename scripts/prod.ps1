# Launch Evermind in production mode (optimized build, no hot reload).
#   .\scripts\prod.ps1             build then serve, local only
#   .\scripts\prod.ps1 -Lan        also reachable from the local network
#   .\scripts\prod.ps1 -SkipBuild  serve the existing build (fast restart)
#
# Ports come from .env or the environment:
#   PORT                    the web interface   (default 3000)
#   EVERMIND_BACKEND_PORT   the API behind it   (default 8000)
#
# Messages stay ASCII-only: PowerShell 5.1 reads .ps1 as ANSI, and accented
# characters saved as UTF-8 would show up as mojibake in the console.
param([switch]$Lan, [switch]$SkipBuild)

$root = Split-Path -Parent $PSScriptRoot

# Next only reads .env files sitting next to itself, and it runs from frontend\.
# Without this the repository's .env is silently ignored here, which matters most
# for EVERMIND_GATE_PASSWORD: the password would appear to be set and would not
# actually be asked for.
$envFile = Join-Path $root ".env"
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
            $name = $Matches[1]
            # Whatever is already in the environment wins over the file.
            if (-not (Get-Item -Path "Env:$name" -ErrorAction SilentlyContinue).Value) {
                Set-Item -Path "Env:$name" -Value $Matches[2].Trim()
            }
        }
    }
}

if (-not $env:PORT) { $env:PORT = "3000" }
$backendPort = $env:EVERMIND_BACKEND_PORT
if (-not $backendPort) { $backendPort = "8000" }
# Next resolves rewrites() during `next build`, so this has to be set before the
# build for the interface to know where the API lives.
if (-not $env:EVERMIND_BACKEND_URL) { $env:EVERMIND_BACKEND_URL = "http://127.0.0.1:$backendPort" }

# `next start` refuses to move: an occupied port kills it outright. Checked before
# anything else, because the likeliest occupant is Evermind itself, still running
# while it is being updated, and nothing below should happen underneath it.
if (Get-NetTCPConnection -LocalPort $env:PORT -State Listen -ErrorAction SilentlyContinue) {
    Write-Host ""
    Write-Host "Port $($env:PORT) is already in use, and the interface will not start on it." -ForegroundColor Red
    Write-Host "If Evermind is still running, stop it and run this again. Otherwise put a" -ForegroundColor Yellow
    Write-Host "free port in .env next to this script, then run it again:" -ForegroundColor Yellow
    Write-Host "  PORT=3001" -ForegroundColor Cyan
    Write-Host "EVERMIND_BACKEND_PORT does the same for the API, currently $backendPort." -ForegroundColor Yellow
    exit 1
}

# Dependencies are installed again whenever the file they come from changes, not
# only on the first run. Otherwise an update that moves one, a security fix for
# instance, leaves the old copy in place to be built and served as before.
if (-not (Test-Path "$root\backend\.venv")) {
    Write-Host "First run: creating the Python environment..."
    python -m venv "$root\backend\.venv"
}
$pyproject = "$root\backend\pyproject.toml"
$pyInstalled = "$root\backend\.venv\.installed-pyproject.toml"
if (-not (Test-Path $pyInstalled) -or (Get-FileHash $pyproject).Hash -ne (Get-FileHash $pyInstalled).Hash) {
    Write-Host "Installing backend dependencies..."
    Remove-Item $pyInstalled -ErrorAction SilentlyContinue
    & "$root\backend\.venv\Scripts\python" -m pip install -q -e "$root\backend[dev]"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Installing the backend dependencies failed. Nothing was started." -ForegroundColor Red
        exit 1
    }
    Copy-Item $pyproject $pyInstalled
}
$lock = "$root\frontend\package-lock.json"
$lockInstalled = "$root\frontend\node_modules\.installed-package-lock.json"
if (-not (Test-Path $lockInstalled) -or (Get-FileHash $lock).Hash -ne (Get-FileHash $lockInstalled).Hash) {
    Write-Host "Installing frontend dependencies (a minute or two)..."
    Remove-Item $lockInstalled -ErrorAction SilentlyContinue
    Push-Location "$root\frontend"
    # ci, not install: exactly what the lockfile says, and the lockfile is never
    # rewritten into a local change that would make the next `git pull` refuse.
    npm ci
    $installFailed = $LASTEXITCODE -ne 0
    Pop-Location
    if ($installFailed) {
        Write-Host "Installing the frontend dependencies failed. Nothing was started." -ForegroundColor Red
        exit 1
    }
    Copy-Item $lock $lockInstalled
}

if ($SkipBuild) {
    if (-not (Test-Path "$root\frontend\.next\BUILD_ID")) {
        Write-Host "No build found. Run once without -SkipBuild first." -ForegroundColor Red
        exit 1
    }
    Write-Host "Reusing the existing build (-SkipBuild)."
    if ($backendPort -ne "8000") {
        Write-Host "  Note: the API address is baked into that build. If you have just" -ForegroundColor Yellow
        Write-Host "  changed EVERMIND_BACKEND_PORT, rebuild without -SkipBuild." -ForegroundColor Yellow
    }
} else {
    Write-Host "Building the frontend (a minute or two)..."
    Push-Location "$root\frontend"
    npm run build
    $buildFailed = $LASTEXITCODE -ne 0
    Pop-Location
    if ($buildFailed) {
        Write-Host "The build failed. Nothing was started." -ForegroundColor Red
        exit 1
    }
}

# `next start` refuses to move: an occupied port kills it outright, so this is
# worth catching before anything is launched.
if (Get-NetTCPConnection -LocalPort $env:PORT -State Listen -ErrorAction SilentlyContinue) {
    Write-Host ""
    Write-Host "Port $($env:PORT) is already in use, and the interface will not start on it." -ForegroundColor Red
    Write-Host "Put a free port in .env next to this script, then run it again:" -ForegroundColor Yellow
    Write-Host "  PORT=3001" -ForegroundColor Cyan
    Write-Host "EVERMIND_BACKEND_PORT does the same for the API, currently $backendPort." -ForegroundColor Yellow
    exit 1
}

# The backend always stays on the loopback: the frontend proxies /api to it,
# and that proxy is what the password gate protects.
Write-Host ""
Write-Host "Backend  -> http://127.0.0.1:$backendPort (this machine only)"
Write-Host "Frontend -> http://localhost:$($env:PORT)"

if ($Lan) {
    # Address of the adapter carrying the default route (not a WSL/Hyper-V one).
    $idx = (Get-NetRoute -DestinationPrefix "0.0.0.0/0" -ErrorAction SilentlyContinue |
            Sort-Object RouteMetric | Select-Object -First 1).InterfaceIndex
    $net = Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $idx -ErrorAction SilentlyContinue |
           Select-Object -First 1
    $adapter = (Get-NetAdapter -InterfaceIndex $idx -ErrorAction SilentlyContinue).Name

    if ($net) {
        Write-Host "            http://$($net.IPAddress):$($env:PORT)  (from the network, via '$adapter')"
        Write-Host "            other devices must be on the $($net.IPAddress)/$($net.PrefixLength) subnet"
    } else {
        Write-Host "No active network adapter found." -ForegroundColor Yellow
    }

    if (-not $env:EVERMIND_GATE_PASSWORD) {
        Write-Host ""
        Write-Host "No password is set, so anyone on this network can read your conversations." -ForegroundColor Yellow
        Write-Host "Put EVERMIND_GATE_PASSWORD in .env to be asked for one." -ForegroundColor Yellow
    }

    $allowed = Get-NetFirewallPortFilter -ErrorAction SilentlyContinue |
               Where-Object { $_.LocalPort -eq $env:PORT } |
               Get-NetFirewallRule -ErrorAction SilentlyContinue |
               Where-Object { $_.Direction -eq "Inbound" -and $_.Action -eq "Allow" -and $_.Enabled -eq "True" }
    if (-not $allowed) {
        Write-Host ""
        Write-Host "Firewall: no rule allows inbound traffic on port $($env:PORT)." -ForegroundColor Yellow
        Write-Host "In an administrator PowerShell, run this once:" -ForegroundColor Yellow
        Write-Host "  New-NetFirewallRule -DisplayName 'Evermind ($($env:PORT))' -Direction Inbound -Protocol TCP -LocalPort $($env:PORT) -Action Allow" -ForegroundColor Cyan
    }
}

# Single uvicorn worker on purpose: the memory-maintenance lock and SQLite
# writes are per-process; multiple workers would race each other.
$backend = Start-Process -PassThru -NoNewWindow "$root\backend\.venv\Scripts\python" `
    -ArgumentList "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", $backendPort `
    -WorkingDirectory "$root\backend"
try {
    Push-Location "$root\frontend"
    if ($Lan) { npm run start:lan } else { npm run start }
} finally {
    Pop-Location
    if ($backend -and -not $backend.HasExited) { Stop-Process -Id $backend.Id -Force }
}
