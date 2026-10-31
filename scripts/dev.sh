#!/usr/bin/env bash
# Launch Evermind in dev mode: the API restarts on every change, and the
# interface comes from the Vite dev server with hot reload.
#   ./scripts/dev.sh        local only
#   ./scripts/dev.sh --lan  reachable from the local network
#
# Settings come from .env or the environment (see .env.example):
#   PORT                    the interface, served by Vite    (default 3000)
#   EVERMIND_BACKEND_PORT   the API behind it                (default 8000)
# Vite and `python -m app` each read them, so this script only gets everything
# ready and starts the two.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON="$ROOT/backend/.venv/bin/python"

# Left unquoted where it is used: empty has to mean no argument at all.
LAN=""
DEV_SCRIPT="dev"
if [ "${1:-}" = "--lan" ]; then
    LAN="--lan"
    DEV_SCRIPT="dev:lan"
fi

# Dependencies are installed again whenever the file they come from changes, not
# only on the first run. Otherwise an update that moves one, a security fix for
# instance, leaves the old copy in place to go on running.
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
LOCK_INSTALLED="$ROOT/frontend/node_modules/.installed-package-lock.json"
if ! cmp -s "$ROOT/frontend/package-lock.json" "$LOCK_INSTALLED"; then
    echo "Installing frontend dependencies (a minute or two)..."
    rm -f "$LOCK_INSTALLED"
    # ci, not install: exactly what the lockfile says, and the lockfile is never
    # rewritten into a local change that would make the next `git pull` refuse.
    (cd "$ROOT/frontend" && npm ci)
    cp "$ROOT/frontend/package-lock.json" "$LOCK_INSTALLED"
fi

# The API only listens on the loopback: the dev server is what the network sees,
# and it forwards /api here.
(cd "$ROOT/backend" && exec "$PYTHON" -m app --dev $LAN) &
BACKEND_PID=$!
trap 'kill $BACKEND_PID 2>/dev/null || true' EXIT

cd "$ROOT/frontend"
npm run "$DEV_SCRIPT"
