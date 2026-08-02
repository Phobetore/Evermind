# Launch Evermind in production mode (optimized build, no hot reload).
#   .\scripts\prod.ps1             build then serve, local only
#   .\scripts\prod.ps1 -Lan        also reachable from the local network
#   .\scripts\prod.ps1 -SkipBuild  serve the existing build (fast restart)
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
            Set-Item -Path "Env:$($Matches[1])" -Value $Matches[2].Trim()
        }
    }
}

if (-not (Test-Path "$root\backend\.venv")) {
    Write-Host "First run: creating the Python environment..."
    python -m venv "$root\backend\.venv"
    & "$root\backend\.venv\Scripts\python" -m pip install -q -e "$root\backend[dev]"
}
if (-not (Test-Path "$root\frontend\node_modules")) {
    Write-Host "First run: installing frontend dependencies..."
    Push-Location "$root\frontend"; npm install; Pop-Location
}

if ($SkipBuild) {
    if (-not (Test-Path "$root\frontend\.next\BUILD_ID")) {
        Write-Host "No build found. Run once without -SkipBuild first." -ForegroundColor Red
        exit 1
    }
    Write-Host "Reusing the existing build (-SkipBuild)."
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

# The backend always stays on the loopback: the frontend proxies /api to it,
# and that proxy is what the password gate protects.
Write-Host ""
Write-Host "Backend  -> http://127.0.0.1:8000 (this machine only)"
Write-Host "Frontend -> http://localhost:3000"

if ($Lan) {
    # Address of the adapter carrying the default route (not a WSL/Hyper-V one).
    $idx = (Get-NetRoute -DestinationPrefix "0.0.0.0/0" -ErrorAction SilentlyContinue |
            Sort-Object RouteMetric | Select-Object -First 1).InterfaceIndex
    $net = Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $idx -ErrorAction SilentlyContinue |
           Select-Object -First 1
    $adapter = (Get-NetAdapter -InterfaceIndex $idx -ErrorAction SilentlyContinue).Name

    if ($net) {
        Write-Host "            http://$($net.IPAddress):3000  (from the network, via '$adapter')"
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
               Where-Object { $_.LocalPort -eq 3000 } |
               Get-NetFirewallRule -ErrorAction SilentlyContinue |
               Where-Object { $_.Direction -eq "Inbound" -and $_.Action -eq "Allow" -and $_.Enabled -eq "True" }
    if (-not $allowed) {
        Write-Host ""
        Write-Host "Firewall: no rule allows inbound traffic on port 3000." -ForegroundColor Yellow
        Write-Host "In an administrator PowerShell, run this once:" -ForegroundColor Yellow
        Write-Host "  New-NetFirewallRule -DisplayName 'Evermind (3000)' -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow" -ForegroundColor Cyan
    }
}

if (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue) {
    Write-Host ""
    Write-Host "Warning: port 3000 is already in use, Next will pick another one." -ForegroundColor Yellow
}

# Single uvicorn worker on purpose: the memory-maintenance lock and SQLite
# writes are per-process; multiple workers would race each other.
$backend = Start-Process -PassThru -NoNewWindow "$root\backend\.venv\Scripts\python" `
    -ArgumentList "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8000" `
    -WorkingDirectory "$root\backend"
try {
    Push-Location "$root\frontend"
    if ($Lan) { npm run start:lan } else { npm run start }
} finally {
    Pop-Location
    if ($backend -and -not $backend.HasExited) { Stop-Process -Id $backend.Id -Force }
}
