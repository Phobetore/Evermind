#!/usr/bin/env bash
# Launch Evermind in production mode: the interface is built once and served
# together with the API, on one port.
#   ./scripts/prod.sh                build then serve, local only
#   ./scripts/prod.sh --lan          also reachable from the local network
#   ./scripts/prod.sh --skip-build   serve the existing build (fast restart)
#
# The port, the password and the other settings come from .env or the
# environment (see .env.example). `python -m app` reads them, so this script only
# gets everything ready and starts it.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON="$ROOT/backend/.venv/bin/python"

# Left unquoted where it is used: empty has to mean no argument at all.
LAN=""
SKIP_BUILD=0
for arg in "$@"; do
    case "$arg" in
        --lan) LAN="--lan" ;;
        --skip-build) SKIP_BUILD=1 ;;
    esac
done

# Dependencies are installed again whenever the file they come from changes, not
# only on the first run. Otherwise an update that moves one, a security fix for
# instance, leaves the old copy in place to be built and served as before.
# A failed install stops here (set -e), before the copy that marks it as done.
#
# Whether the environment exists is decided by whether its pip answers, not by
# the folder being there. A creation that fails (on Debian and Ubuntu,
# python3-venv not installed yet) or is interrupted leaves half an environment,
# without pip, that a test on the folder would take for a finished one on every
# later run. --clear starts such a folder over instead of building on it.
if ! "$PYTHON" -m pip --version > /dev/null 2>&1; then
    echo "First run: creating the Python environment..."
    # Python says by itself what to install when it is a package that is missing.
    python3 -m venv --clear "$ROOT/backend/.venv" || {
        echo "Creating the Python environment failed. Nothing was started." >&2
        exit 1
    }
fi
PY_INSTALLED="$ROOT/backend/.venv/.installed-pyproject.toml"
if ! cmp -s "$ROOT/backend/pyproject.toml" "$PY_INSTALLED"; then
    echo "Installing backend dependencies..."
    rm -f "$PY_INSTALLED"
    "$PYTHON" -m pip install -q -e "$ROOT/backend[dev]"
    cp "$ROOT/backend/pyproject.toml" "$PY_INSTALLED"
fi

# Asked before anything is installed or built, because the likeliest reason for
# the port to be taken is Evermind itself, still running while it is being
# updated, and nothing below should happen underneath it. It explains a failure
# on its own; the port it prints on success is not needed here.
if ! (cd "$ROOT/backend" && "$PYTHON" -m app --check $LAN > /dev/null); then
    echo "Nothing was started." >&2
    exit 1
fi

LOCK_INSTALLED="$ROOT/frontend/node_modules/.installed-package-lock.json"
if ! cmp -s "$ROOT/frontend/package-lock.json" "$LOCK_INSTALLED"; then
    echo "Installing frontend dependencies (a minute or two)..."
    rm -f "$LOCK_INSTALLED"
    # ci, not install: exactly what the lockfile says, and the lockfile is never
    # rewritten into a local change that would make the next `git pull` refuse.
    (cd "$ROOT/frontend" && npm ci)
    cp "$ROOT/frontend/package-lock.json" "$LOCK_INSTALLED"
fi

if [ "$SKIP_BUILD" = 1 ]; then
    if [ ! -f "$ROOT/frontend/dist/index.html" ]; then
        echo "No build found. Run once without --skip-build first." >&2
        exit 1
    fi
    echo "Reusing the existing build (--skip-build)."
else
    echo "Building the frontend (a minute or two)..."
    (cd "$ROOT/frontend" && npm run build)
fi

# python -m app prints the addresses and the no-password warning itself.
cd "$ROOT/backend"
exec "$PYTHON" -m app $LAN
