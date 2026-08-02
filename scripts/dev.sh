#!/usr/bin/env bash
# Launch Evermind in dev mode (backend + frontend).
#   ./scripts/dev.sh        local only
#   ./scripts/dev.sh --lan  frontend reachable from the local network
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAN=""
[ "${1:-}" = "--lan" ] && LAN=":lan"

# Next only reads .env files sitting next to itself, and it runs from frontend/.
# Without this the repository's .env is silently ignored here.
if [ -f "$ROOT/.env" ]; then
    while IFS='=' read -r key value || [ -n "$key" ]; do
        case "$key" in ''|'#'*) continue ;; esac
        export "$(printf '%s' "$key" | tr -d '[:space:]')=$value"
    done < "$ROOT/.env"
fi

if [ ! -d "$ROOT/backend/.venv" ]; then
    echo "First run: creating the Python environment..."
    python3 -m venv "$ROOT/backend/.venv"
    "$ROOT/backend/.venv/bin/python" -m pip install -q -e "$ROOT/backend[dev]"
fi
if [ ! -d "$ROOT/frontend/node_modules" ]; then
    echo "First run: installing frontend dependencies..."
    (cd "$ROOT/frontend" && npm install)
fi

# The backend always stays on the loopback: the frontend proxies /api to it,
# and that proxy is what the password gate protects.
echo "Backend  -> http://127.0.0.1:8000 (this machine only)"
echo "Frontend -> http://localhost:3000"
if [ -n "$LAN" ]; then
    IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
    [ -n "$IP" ] && echo "            http://${IP}:3000  (from the local network)"
    if [ -z "${EVERMIND_GATE_PASSWORD:-}" ]; then
        echo ""
        echo "  No password is set, so anyone on this network can read your conversations."
        echo "  Put EVERMIND_GATE_PASSWORD in .env to be asked for one."
    fi
fi

(cd "$ROOT/backend" && exec .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000) &
BACKEND_PID=$!
trap 'kill $BACKEND_PID 2>/dev/null || true' EXIT

cd "$ROOT/frontend" && npm run "dev${LAN}"
