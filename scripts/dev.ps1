# Launch Evermind in dev mode: the API restarts on every change, and the
# interface comes from the Vite dev server with hot reload.
#   .\scripts\dev.ps1        local only
#   .\scripts\dev.ps1 -Lan   reachable from the local network
#
# Settings come from .env or the environment (see .env.example):
#   PORT                    the interface, served by Vite    (default 3000)
#   EVERMIND_BACKEND_PORT   the API behind it                (default 8000)
# Vite and `python -m app` each read them, so this script only gets everything
# ready and starts the two.
#
# Messages stay ASCII-only: PowerShell 5.1 reads .ps1 as ANSI, and accented
# characters saved as UTF-8 would show up as mojibake in the console.
param([switch]$Lan)

$root = Split-Path -Parent $PSScriptRoot
$python = "$root\backend\.venv\Scripts\python"
$appArgs = @("-m", "app", "--dev")
if ($Lan) { $appArgs += "--lan" }

# Dependencies are installed again whenever the file they come from changes, not
# only on the first run. Otherwise an update that moves one, a security fix for
# instance, leaves the old copy in place to go on running.
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

# Asked before the interface is installed, because the API exiting right after
# it starts (its port taken, a settings file that cannot be read) would leave
# Vite running against nothing, and the likeliest reason for the port to be
# taken is a previous run of this script that is still going. The API makes the
# same check itself when it starts, so this is what it would say, said first.
Push-Location "$root\backend"
$null = & $python -m app --check --dev
$checkFailed = $LASTEXITCODE -ne 0
Pop-Location
if ($checkFailed) {
    Write-Host "Nothing was started." -ForegroundColor Red
    Write-Host "In development the API's port is EVERMIND_BACKEND_PORT: if it is the one taken, set that in .env, instead of PORT." -ForegroundColor Yellow
    exit 1
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
        # Windows will not delete a file a running program has open, and a dev
        # server holds the compiler's binary open for as long as it runs.
        Write-Host "Installing the frontend dependencies failed. Nothing was started." -ForegroundColor Red
        Write-Host "If Evermind is still running, stop it and run this again." -ForegroundColor Yellow
        exit 1
    }
    Copy-Item $lock $lockInstalled
}

if ($Lan) {
    # Vite is what the network sees, and the port it is asked for is PORT, which
    # is what --check --lan reads (with --dev it would give the API's port
    # instead).
    Push-Location "$root\backend"
    $port = & $python -m app --check --lan
    $portTaken = $LASTEXITCODE -ne 0
    Pop-Location
    if ($portTaken) {
        # It said why. Vite does not stop for a port that is taken, and may end
        # up on another one, so the port for the firewall is not known yet.
        Write-Host ""
        Write-Host "Starting anyway: Vite may end up on another port, so go by the address it prints." -ForegroundColor Yellow
        Write-Host "Windows blocks inbound connections by default. In an administrator PowerShell, allow that port once:" -ForegroundColor Yellow
        Write-Host "  New-NetFirewallRule -DisplayName 'Evermind (dev)' -Direction Inbound -Protocol TCP -LocalPort <the port Vite prints> -Action Allow" -ForegroundColor Cyan
    } else {
        # Windows blocks inbound connections by default: without this rule the
        # port stays unreachable from every other device, whatever the address
        # used.
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
}

# The API only listens on the loopback: the dev server is what the network sees,
# and it forwards /api here.
$backend = Start-Process -PassThru -NoNewWindow $python `
    -ArgumentList $appArgs `
    -WorkingDirectory "$root\backend"
try {
    Push-Location "$root\frontend"
    if ($Lan) { npm run dev:lan } else { npm run dev }
} finally {
    Pop-Location
    # The whole tree: the reloader runs the server in a child process, which
    # would be left holding the port if only its parent were stopped.
    if ($backend -and -not $backend.HasExited) { taskkill /PID $backend.Id /T /F | Out-Null }
}
