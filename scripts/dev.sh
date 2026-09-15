#!/usr/bin/env bash
# Launch Evermind in dev mode (backend + frontend).
#   ./scripts/dev.sh        local only
#   ./scripts/dev.sh --lan  frontend reachable from the local network
#
# Ports come from .env or the environment:
#   PORT                    the web interface           (default 3000)
#   EVERMIND_BACKEND_PORT   the API behind it           (default 8000)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAN=""
[ "${1:-}" = "--lan" ] && LAN=":lan"

# Next only reads .env files sitting next to itself, and it runs from frontend/.
# Without this the repository's .env is silently ignored here.
if [ -f "$ROOT/.env" ]; then
    while IFS='=' read -r key value || [ -n "$key" ]; do
        case "$key" in ''|'#'*) continue ;; esac
        key="$(printf '%s' "$key" | tr -d '[:space:]')"
        # Whatever is already in the environment wins over the file.
        [ -n "${!key:-}" ] && continue
        export "$key=$value"
    done < "$ROOT/.env"
fi

PORT="${PORT:-3000}"
BACKEND_PORT="${EVERMIND_BACKEND_PORT:-8000}"
export PORT
export EVERMIND_BACKEND_URL="${EVERMIND_BACKEND_URL:-http://127.0.0.1:${BACKEND_PORT}}"

# Dependencies are installed again whenever the file they come from changes, not
# only on the first run. Otherwise an update that moves one, a security fix for
# instance, leaves the old copy in place to go on running.
# A failed install stops here (set -e), before the copy that marks it as done.
if [ ! -d "$ROOT/backend/.venv" ]; then
    echo "First run: creating the Python environment..."
    python3 -m venv "$ROOT/backend/.venv"
fi
PY_INSTALLED="$ROOT/backend/.venv/.installed-pyproject.toml"
if ! cmp -s "$ROOT/backend/pyproject.toml" "$PY_INSTALLED"; then
    echo "Installing backend dependencies..."
    rm -f "$PY_INSTALLED"
    "$ROOT/backend/.venv/bin/python" -m pip install -q -e "$ROOT/backend[dev]"
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

# The backend always stays on the loopback: the frontend proxies /api to it,
# and that proxy is what the password gate protects.
echo "Backend  -> http://127.0.0.1:${BACKEND_PORT} (this machine only)"
echo "Frontend -> http://localhost:${PORT}"
if [ -n "$LAN" ]; then
    IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
    [ -n "$IP" ] && echo "            http://${IP}:${PORT}  (from the local network)"
    if [ -z "${EVERMIND_GATE_PASSWORD:-}" ]; then
        echo ""
        echo "  No password is set, so anyone on this network can read your conversations."
        echo "  Put EVERMIND_GATE_PASSWORD in .env to be asked for one."
    fi
fi

(cd "$ROOT/backend" && exec .venv/bin/python -m uvicorn app.main:app \
    --host 127.0.0.1 --port "$BACKEND_PORT") &
BACKEND_PID=$!
trap 'kill $BACKEND_PID 2>/dev/null || true' EXIT

# `next dev` moves to a free port by itself, so only the API needs saying.
cd "$ROOT/frontend"
if ! npm run "dev${LAN}"; then
    status=$?
    echo "" >&2
    echo "If the error above mentions port ${BACKEND_PORT}, set EVERMIND_BACKEND_PORT" >&2
    echo "to a free port in .env and run this again." >&2
    exit "$status"
fi
