#!/usr/bin/env bash
# Launch Evermind in production mode (optimized build, no hot reload).
#   ./scripts/prod.sh                build then serve, local only
#   ./scripts/prod.sh --lan          also reachable from the local network
#   ./scripts/prod.sh --skip-build   serve the existing build (fast restart)
#
# Ports come from .env or the environment:
#   PORT                    the web interface           (default 3000)
#   EVERMIND_BACKEND_PORT   the API behind it           (default 8000)
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

# Next only reads .env files sitting next to itself, and it runs from frontend/.
# Without this the repository's .env is silently ignored here, which matters most
# for EVERMIND_GATE_PASSWORD: the password would appear to be set and would not
# actually be asked for.
if [ -f "$ROOT/.env" ]; then
    while IFS='=' read -r key value || [ -n "$key" ]; do
        case "$key" in ''|'#'*) continue ;; esac
        key="$(printf '%s' "$key" | tr -d '[:space:]')"
        # Whatever is already in the environment wins: PORT=3001 ./scripts/prod.sh
        # should not be quietly overruled by the file.
        [ -n "${!key:-}" ] && continue
        export "$key=$value"
    done < "$ROOT/.env"
fi

PORT="${PORT:-3000}"
BACKEND_PORT="${EVERMIND_BACKEND_PORT:-8000}"
export PORT
# Next resolves rewrites() during `next build`, so this has to be set before the
# build for the interface to know where the API lives. Hence the warning further
# down when someone changes it and then skips the build.
export EVERMIND_BACKEND_URL="${EVERMIND_BACKEND_URL:-http://127.0.0.1:${BACKEND_PORT}}"

if [ ! -d "$ROOT/backend/.venv" ]; then
    echo "First run: creating the Python environment..."
    python3 -m venv "$ROOT/backend/.venv"
    "$ROOT/backend/.venv/bin/python" -m pip install -q -e "$ROOT/backend[dev]"
fi
if [ ! -d "$ROOT/frontend/node_modules" ]; then
    echo "First run: installing frontend dependencies..."
    (cd "$ROOT/frontend" && npm install)
fi

if [ "$SKIP_BUILD" = 1 ]; then
    if [ ! -f "$ROOT/frontend/.next/BUILD_ID" ]; then
        echo "No build found. Run once without --skip-build first." >&2
        exit 1
    fi
    echo "Reusing the existing build (--skip-build)."
    if [ "$BACKEND_PORT" != "8000" ]; then
        echo "  Note: the API address is baked into that build. If you have just" >&2
        echo "  changed EVERMIND_BACKEND_PORT, rebuild without --skip-build." >&2
    fi
else
    echo "Building the frontend (a minute or two)..."
    (cd "$ROOT/frontend" && npm run build)
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

# Single uvicorn worker on purpose: the memory-maintenance lock and SQLite
# writes are per-process; multiple workers would race each other.
(cd "$ROOT/backend" && exec .venv/bin/python -m uvicorn app.main:app \
    --host 127.0.0.1 --port "$BACKEND_PORT") &
BACKEND_PID=$!
trap 'kill $BACKEND_PID 2>/dev/null || true' EXIT

# Guidance rather than a pre-flight check: telling someone their port is free
# when it is not would be worse than saying nothing, and there is no way to test
# a port that is reliable everywhere this script runs without extra tools.
cd "$ROOT/frontend"
if ! npm run "start${LAN}"; then
    status=$?
    echo "" >&2
    echo "The interface did not start. If the error above says EADDRINUSE," >&2
    echo "port ${PORT} is already taken by something else. Put a free port in" >&2
    echo ".env next to this script and run it again:" >&2
    echo "" >&2
    echo "    PORT=3001" >&2
    echo "" >&2
    echo "EVERMIND_BACKEND_PORT does the same for the API, currently ${BACKEND_PORT}." >&2
    exit "$status"
fi
