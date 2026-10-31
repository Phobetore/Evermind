# Launch Evermind in production mode: the interface is built once and served
# together with the API, on one port.
#   .\scripts\prod.ps1             build then serve, local only
#   .\scripts\prod.ps1 -Lan        also reachable from the local network
#   .\scripts\prod.ps1 -SkipBuild  serve the existing build (fast restart)
#
# The port, the password and the other settings come from .env or the
# environment (see .env.example). `python -m app` reads them, so this script only
# gets everything ready and starts it.
#
# Messages stay ASCII-only: PowerShell 5.1 reads .ps1 as ANSI, and accented
# characters saved as UTF-8 would show up as mojibake in the console.
param([switch]$Lan, [switch]$SkipBuild)

$root = Split-Path -Parent $PSScriptRoot
$python = "$root\backend\.venv\Scripts\python"
$appArgs = @()
if ($Lan) { $appArgs += "--lan" }

# Dependencies are installed again whenever the file they come from changes, not
# only on the first run. Otherwise an update that moves one, a security fix for
# instance, leaves the old copy in place to be built and served as before.
#
# Whether the environment exists is decided by whether its pip answers, not by
# the folder being there. A creation that is interrupted leaves half an
# environment, without pip, that a test on the folder would take for a finished
# one on every later run. --clear starts such a folder over instead of building
# on it.
$venvWorks = $false
if (Test-Path "$python.exe") {
    & $python -m pip --version *> $null
    $venvWorks = $LASTEXITCODE -eq 0
}
if (-not $venvWorks) {
    Write-Host "First run: creating the Python environment..."
    $created = $false
    try {
        python -m venv --clear "$root\backend\.venv"
        $created = $LASTEXITCODE -eq 0
    } catch {
        # No python on the PATH at all.
        Write-Host $_.Exception.Message
    }
    if (-not $created) {
        Write-Host "Creating the Python environment failed. Nothing was started." -ForegroundColor Red
        Write-Host "Python 3.11 or newer has to be installed and reachable as python (python.org)." -ForegroundColor Yellow
        exit 1
    }
}
$pyproject = "$root\backend\pyproject.toml"
$pyInstalled = "$root\backend\.venv\.installed-pyproject.toml"
if (-not (Test-Path $pyInstalled) -or (Get-FileHash $pyproject).Hash -ne (Get-FileHash $pyInstalled).Hash) {
    Write-Host "Installing backend dependencies..."
    Remove-Item $pyInstalled -ErrorAction SilentlyContinue
    & $python -m pip install -q -e "$root\backend[dev]"
    if ($LASTEXITCODE -ne 0) {
        # Windows will not replace a file a running program has open.
        Write-Host "Installing the backend dependencies failed. Nothing was started." -ForegroundColor Red
        Write-Host "If Evermind is still running, stop it and run this again." -ForegroundColor Yellow
        exit 1
    }
    Copy-Item $pyproject $pyInstalled
}

# Asked before anything is installed or built, because the likeliest reason for
# the port to be taken is Evermind itself, still running while it is being
# updated, and nothing below should happen underneath it. --check prints the port
# and nothing else, and explains a failure on its own.
Push-Location "$root\backend"
$port = & $python -m app --check @appArgs
$checkFailed = $LASTEXITCODE -ne 0
Pop-Location
if ($checkFailed) { exit 1 }

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
    if (-not (Test-Path "$root\frontend\dist\index.html")) {
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

if ($Lan) {
    # Windows blocks inbound connections by default: without this rule the port
    # stays unreachable from every other device, whatever the address used.
    $allowed = Get-NetFirewallPortFilter -ErrorAction SilentlyContinue |
               Where-Object { $_.LocalPort -eq $port } |
               Get-NetFirewallRule -ErrorAction SilentlyContinue |
               Where-Object { $_.Direction -eq "Inbound" -and $_.Action -eq "Allow" -and $_.Enabled -eq "True" }
    if (-not $allowed) {
        Write-Host ""
        Write-Host "Firewall: no rule allows inbound traffic on port $port." -ForegroundColor Yellow
        Write-Host "In an administrator PowerShell, run this once:" -ForegroundColor Yellow
        Write-Host "  New-NetFirewallRule -DisplayName 'Evermind ($port)' -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow" -ForegroundColor Cyan
    }
}

# python -m app prints the addresses and the no-password warning itself.
Push-Location "$root\backend"
try {
    & $python -m app @appArgs
} finally {
    Pop-Location
}
exit $LASTEXITCODE
