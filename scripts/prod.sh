#!/usr/bin/env bash
# Build the interface once and serve it with the API, on one port.
#   ./scripts/prod.sh          local only
#   ./scripts/prod.sh --lan    also reachable from the local network
# Fast restart, without the build: backend/.venv/bin/python -m app, from backend/.
# The port, the password and the other settings come from .env or the environment
# (see .env.example); `python -m app` reads them.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON="$ROOT/backend/.venv/bin/python"

# The environment exists when its pip answers: an interrupted creation leaves a
# folder without one, which --clear starts over.
if ! "$PYTHON" -m pip --version > /dev/null 2>&1; then
    echo "First run: creating the Python environment..."
    python3 -m venv --clear "$ROOT/backend/.venv"
fi
# Dependencies are installed again whenever the file they come from changes. A
# failed install stops here (set -e), before the copy that marks it as done.
PY_STAMP="$ROOT/backend/.venv/.installed-pyproject.toml"
if ! cmp -s "$ROOT/backend/pyproject.toml" "$PY_STAMP"; then
    echo "Installing backend dependencies..."
    rm -f "$PY_STAMP"
    "$PYTHON" -m pip install -q -e "$ROOT/backend"
    cp "$ROOT/backend/pyproject.toml" "$PY_STAMP"
fi

# Asked before the interface is installed or built: the likeliest reason for a taken
# port is Evermind itself, still running while it is updated.
cd "$ROOT/backend"
"$PYTHON" -m app --check "$@" > /dev/null || { echo "Nothing was started." >&2; exit 1; }

# ci, not install: exactly what the lockfile says, and never a local change that
# would make the next `git pull` refuse.
LOCK_STAMP="$ROOT/frontend/node_modules/.installed-package-lock.json"
if ! cmp -s "$ROOT/frontend/package-lock.json" "$LOCK_STAMP"; then
    echo "Installing frontend dependencies (a minute or two)..."
    rm -f "$LOCK_STAMP"
    (cd "$ROOT/frontend" && npm ci)
    cp "$ROOT/frontend/package-lock.json" "$LOCK_STAMP"
fi
echo "Building the frontend (a minute or two)..."
(cd "$ROOT/frontend" && npm run build)

exec "$PYTHON" -m app "$@"
