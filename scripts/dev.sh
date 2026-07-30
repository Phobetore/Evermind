#!/usr/bin/env bash
# Launch Evermind in dev mode (backend + frontend).
#   ./scripts/dev.sh        local only
#   ./scripts/dev.sh --lan  frontend reachable from the local network
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAN=""
[ "${1:-}" = "--lan" ] && LAN=":lan"

if [ ! -d "$ROOT/backend/.venv" ]; then
    echo "Premier lancement : création de l'environnement Python…"
    python3 -m venv "$ROOT/backend/.venv"
    "$ROOT/backend/.venv/bin/python" -m pip install -q -e "$ROOT/backend[dev]"
fi
if [ ! -d "$ROOT/frontend/node_modules" ]; then
    echo "Premier lancement : installation des dépendances frontend…"
    (cd "$ROOT/frontend" && npm install)
fi

# The backend always stays on the loopback: the frontend proxies /api to it,
# and that proxy is what the password gate protects.
echo "Backend  → http://127.0.0.1:8000 (local uniquement)"
echo "Frontend → http://localhost:3000"
if [ -n "$LAN" ]; then
    IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
    [ -n "$IP" ] && echo "           http://${IP}:3000  (depuis le réseau, mot de passe requis)"
fi

(cd "$ROOT/backend" && exec .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000) &
BACKEND_PID=$!
trap 'kill $BACKEND_PID 2>/dev/null || true' EXIT

cd "$ROOT/frontend" && npm run "dev${LAN}"
