# Launch Evermind in dev mode (backend + frontend).
#   .\scripts\dev.ps1        local only
#   .\scripts\dev.ps1 -Lan   frontend reachable from the local network
#
# Messages stay ASCII-only: PowerShell 5.1 reads .ps1 as ANSI, and accented
# characters saved as UTF-8 would show up as mojibake in the console.
param([switch]$Lan)

$root = Split-Path -Parent $PSScriptRoot

if (-not (Test-Path "$root\backend\.venv")) {
    Write-Host "Premier lancement : creation de l'environnement Python..."
    python -m venv "$root\backend\.venv"
    & "$root\backend\.venv\Scripts\python" -m pip install -q -e "$root\backend[dev]"
}
if (-not (Test-Path "$root\frontend\node_modules")) {
    Write-Host "Premier lancement : installation des dependances frontend..."
    Push-Location "$root\frontend"; npm install; Pop-Location
}

# The backend always stays on the loopback: the frontend proxies /api to it,
# and that proxy is what the password gate protects.
Write-Host "Backend  -> http://127.0.0.1:8000 (local uniquement)"
Write-Host "Frontend -> http://localhost:3000"

if ($Lan) {
    # Address of the adapter carrying the default route. Taking the first
    # non-loopback address instead would pick a WSL/Hyper-V/VirtualBox virtual
    # adapter, whose address is only reachable from this machine.
    $idx = (Get-NetRoute -DestinationPrefix "0.0.0.0/0" -ErrorAction SilentlyContinue |
            Sort-Object RouteMetric | Select-Object -First 1).InterfaceIndex
    $net = Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $idx -ErrorAction SilentlyContinue |
           Select-Object -First 1
    $adapter = (Get-NetAdapter -InterfaceIndex $idx -ErrorAction SilentlyContinue).Name

    if ($net) {
        Write-Host "            http://$($net.IPAddress):3000  (depuis le reseau, via '$adapter')"
        Write-Host "            les autres appareils doivent etre dans le sous-reseau $($net.IPAddress)/$($net.PrefixLength)"
    } else {
        Write-Host "Aucune carte reseau active detectee." -ForegroundColor Yellow
    }

    # Windows blocks inbound connections by default: without this rule the port
    # stays unreachable from every other device, whatever the address used.
    $allowed = Get-NetFirewallPortFilter -ErrorAction SilentlyContinue |
               Where-Object { $_.LocalPort -eq 3000 } |
               Get-NetFirewallRule -ErrorAction SilentlyContinue |
               Where-Object { $_.Direction -eq "Inbound" -and $_.Action -eq "Allow" -and $_.Enabled -eq "True" }
    if (-not $allowed) {
        Write-Host ""
        Write-Host "Pare-feu : aucune regle n'autorise le port 3000 en entree." -ForegroundColor Yellow
        Write-Host "Dans un PowerShell administrateur, executez une fois :" -ForegroundColor Yellow
        Write-Host "  New-NetFirewallRule -DisplayName 'Evermind (3000)' -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow" -ForegroundColor Cyan
    }

    # Next silently falls back to another port, which would make the URLs wrong.
    if (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue) {
        Write-Host ""
        Write-Host "Attention : le port 3000 est deja occupe, Next va en choisir un autre." -ForegroundColor Yellow
    }
}

$backend = Start-Process -PassThru -NoNewWindow "$root\backend\.venv\Scripts\python" `
    -ArgumentList "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8000" `
    -WorkingDirectory "$root\backend"
try {
    Push-Location "$root\frontend"
    if ($Lan) { npm run dev:lan } else { npm run dev }
} finally {
    Pop-Location
    if ($backend -and -not $backend.HasExited) { Stop-Process -Id $backend.Id -Force }
}
