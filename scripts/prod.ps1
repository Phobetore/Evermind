# Build the interface once and serve it with the API, on one port. A stock Windows runs no
# script unless it is told to, hence the Bypass:
#   powershell -ExecutionPolicy Bypass -File .\scripts\prod.ps1        local only
#   powershell -ExecutionPolicy Bypass -File .\scripts\prod.ps1 -Lan   also reachable from the local network
# Fast restart, without the build: backend\.venv\Scripts\python -m app, from backend\.
# The port, the password and the other settings come from .env or the environment
# (see .env.example); `python -m app` reads them.
#
# Messages stay ASCII-only: PowerShell 5.1 reads .ps1 as ANSI, and accented
# characters saved as UTF-8 would show up as mojibake in the console.
param([switch]$Lan)

$root = Split-Path -Parent $PSScriptRoot
$python = "$root\backend\.venv\Scripts\python.exe"
$appArgs = if ($Lan) { @("--lan") } else { @() }
$here = Get-Location

function Stop-Here($why) {
    Write-Host ("$why Nothing was started.").Trim() -ForegroundColor Red
    exit 1
}
# Dependencies are installed again whenever the file they come from changes.
function Changed($file, $stamp) {
    -not (Test-Path $stamp) -or (Get-FileHash $file).Hash -ne (Get-FileHash $stamp).Hash
}

# The environment exists when its pip answers: an interrupted creation leaves a
# folder without one, which --clear starts over.
$works = $false
if (Test-Path $python) { & $python -m pip --version *> $null; $works = $LASTEXITCODE -eq 0 }
if (-not $works) {
    Write-Host "First run: creating the Python environment..."
    try { python -m venv --clear "$root\backend\.venv" } catch { Write-Host $_.Exception.Message }
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $python)) {
        Stop-Here "Creating the Python environment failed: Python 3.11 or newer has to be on the PATH as python."
    }
}
$pyStamp = "$root\backend\.venv\.installed-pyproject.toml"
if (Changed "$root\backend\pyproject.toml" $pyStamp) {
    Write-Host "Installing backend dependencies..."
    Remove-Item $pyStamp -ErrorAction SilentlyContinue
    & $python -m pip install -q -e "$root\backend"
    # Windows will not replace a file a running program has open.
    if ($LASTEXITCODE -ne 0) { Stop-Here "Installing the backend dependencies failed; if Evermind is still running, stop it." }
    Copy-Item "$root\backend\pyproject.toml" $pyStamp
}

# However what follows ends, Ctrl+C included, the window goes back to the folder it started in.
try {
    # Asked before the interface is installed or built: the likeliest reason for a taken
    # port is Evermind itself, still running while it is updated.
    Set-Location "$root\backend"
    & $python -m app --check @appArgs | Out-Null
    if ($LASTEXITCODE -ne 0) { Stop-Here "" }

    $lock = "$root\frontend\package-lock.json"
    $lockStamp = "$root\frontend\node_modules\.installed-package-lock.json"
    Set-Location "$root\frontend"
    if (Changed $lock $lockStamp) {
        Write-Host "Installing frontend dependencies (a minute or two)..."
        Remove-Item $lockStamp -ErrorAction SilentlyContinue
        npm ci   # exactly the lockfile, never a local change that would stop `git pull`
        if ($LASTEXITCODE -ne 0) { Stop-Here "Installing the frontend dependencies failed." }
        Copy-Item $lock $lockStamp
    }
    Write-Host "Building the frontend (a minute or two)..."
    npm run build
    if ($LASTEXITCODE -ne 0) { Stop-Here "The build failed." }
    Set-Location "$root\backend"
    & $python -m app @appArgs
} finally {
    Set-Location -LiteralPath $here
}
exit $LASTEXITCODE
