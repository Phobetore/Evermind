#!/usr/bin/env bash
# Launch Evermind in production mode (optimized build, no hot reload).
#   ./scripts/prod.sh                build then serve, local only
#   ./scripts/prod.sh --lan          also reachable from the local network
#   ./scripts/prod.sh --skip-build   serve the existing build (fast restart)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

LAN=""
SKIP_BUILD=0
for arg in "$@"; do
    case "$arg" in
        --lan) LAN=":lan" ;;
        --skip-build) SKIP_BUILD=1 ;;
    esac
done

if [ ! -d "$ROOT/backend/.venv" ]; then
    echo "Premier lancement : création de l'environnement Python…"
    python3 -m venv "$ROOT/backend/.venv"
    "$ROOT/backend/.venv/bin/python" -m pip install -q -e "$ROOT/backend[dev]"
fi
if [ ! -d "$ROOT/frontend/node_modules" ]; then
    echo "Premier lancement : installation des dépendances frontend…"
    (cd "$ROOT/frontend" && npm install)
fi

if [ "$SKIP_BUILD" = 1 ]; then
    if [ ! -f "$ROOT/frontend/.next/BUILD_ID" ]; then
        echo "Aucun build trouvé : lancez d'abord sans --skip-build." >&2
        exit 1
    fi
    echo "Build existant réutilisé (--skip-build)."
else
    echo "Compilation du frontend (une à deux minutes)…"
    (cd "$ROOT/frontend" && npm run build)
fi

# The backend always stays on the loopback: the frontend proxies /api to it,
# and that proxy is what the password gate protects.
echo "Backend  → http://127.0.0.1:8000 (local uniquement)"
echo "Frontend → http://localhost:3000"
if [ -n "$LAN" ]; then
    IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
    [ -n "$IP" ] && echo "           http://${IP}:3000  (depuis le réseau, mot de passe requis)"
fi

# Single uvicorn worker on purpose: the memory-maintenance lock and SQLite
# writes are per-process; multiple workers would race each other.
(cd "$ROOT/backend" && exec .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000) &
BACKEND_PID=$!
trap 'kill $BACKEND_PID 2>/dev/null || true' EXIT

cd "$ROOT/frontend" && npm run "start${LAN}"
