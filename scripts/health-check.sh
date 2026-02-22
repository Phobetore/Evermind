#!/usr/bin/env bash
# ==============================================================================
# Evermind — Health Check Script (Linux/macOS)
# ==============================================================================
# Checks the health status of all Evermind services.
#
# Usage:
#   ./scripts/health-check.sh           # Check all services
#   ./scripts/health-check.sh --json    # Output as JSON
#
# Exit codes:
#   0 — All checked services are healthy
#   1 — At least one service is unhealthy
# ==============================================================================

set -euo pipefail

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# ── Paths ─────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CONFIG_FILE="${EVERMIND_CONFIG:-${PROJECT_ROOT}/config.yaml}"

# ── Flags ─────────────────────────────────────────────────────────────────────
JSON_OUTPUT=false

for arg in "$@"; do
    case "$arg" in
        --json) JSON_OUTPUT=true ;;
        --help|-h)
            echo "Usage: $0 [--json] [--help]"
            echo ""
            echo "Options:"
            echo "  --json    Output results as JSON"
            echo "  --help    Show this help message"
            exit 0
            ;;
        *) echo -e "${RED}Unknown option: $arg${NC}"; exit 1 ;;
    esac
done

# ── Helpers ───────────────────────────────────────────────────────────────────

read_config() {
    python3 -c "
import yaml
with open('${CONFIG_FILE}') as f:
    cfg = yaml.safe_load(f)
keys = '$1'.split('.')
val = cfg
for k in keys:
    if isinstance(val, dict):
        val = val.get(k)
    else:
        val = None
        break
print(val if val is not None else '')
"
}

check_health() {
    local url="$1"
    local timeout="${2:-5}"

    local http_code
    http_code=$(curl -sf --max-time "${timeout}" -o /dev/null -w "%{http_code}" "${url}" 2>/dev/null) || http_code="000"
    echo "${http_code}"
}

# ── Read config ──────────────────────────────────────────────────────────────

if [ ! -f "${CONFIG_FILE}" ]; then
    echo -e "${RED}Configuration file not found: ${CONFIG_FILE}${NC}" >&2
    exit 1
fi

BIND_HOST=$(read_config "bind_host")
BACKEND_PORT=$(read_config "backend_port")
FRONTEND_PORT=$(read_config "frontend_port")

BIND_HOST="${BIND_HOST:-127.0.0.1}"
BACKEND_PORT="${BACKEND_PORT:-8000}"
FRONTEND_PORT="${FRONTEND_PORT:-3000}"

# ── Check services ───────────────────────────────────────────────────────────

declare -A RESULTS=()
UNHEALTHY=0

# Backend
HTTP_CODE=$(check_health "http://${BIND_HOST}:${BACKEND_PORT}/health")
if [ "${HTTP_CODE}" = "200" ]; then
    RESULTS[backend]="healthy"
else
    RESULTS[backend]="unhealthy (HTTP ${HTTP_CODE})"
    UNHEALTHY=$((UNHEALTHY + 1))
fi

# Frontend
HTTP_CODE=$(check_health "http://${BIND_HOST}:${FRONTEND_PORT}")
if [ "${HTTP_CODE}" = "200" ]; then
    RESULTS[frontend]="healthy"
else
    RESULTS[frontend]="unhealthy (HTTP ${HTTP_CODE})"
    UNHEALTHY=$((UNHEALTHY + 1))
fi

# LLM servers
for SERVER_NAME in chat memory judge; do
    SERVER_PORT=$(read_config "llm_servers.${SERVER_NAME}.port")
    SERVER_PORT="${SERVER_PORT:-8081}"

    HTTP_CODE=$(check_health "http://${BIND_HOST}:${SERVER_PORT}/health")
    if [ "${HTTP_CODE}" = "200" ]; then
        RESULTS["llm-${SERVER_NAME}"]="healthy"
    else
        RESULTS["llm-${SERVER_NAME}"]="unhealthy (HTTP ${HTTP_CODE})"
        UNHEALTHY=$((UNHEALTHY + 1))
    fi
done

# ── Output ───────────────────────────────────────────────────────────────────

if [ "${JSON_OUTPUT}" = true ]; then
    echo "{"
    FIRST=true
    for KEY in backend frontend llm-chat llm-memory llm-judge; do
        STATUS="${RESULTS[${KEY}]}"
        if [ "${FIRST}" = true ]; then
            FIRST=false
        else
            echo ","
        fi
        IS_HEALTHY="false"
        [[ "${STATUS}" == "healthy" ]] && IS_HEALTHY="true"
        printf '  "%s": {"status": "%s", "healthy": %s}' "${KEY}" "${STATUS}" "${IS_HEALTHY}"
    done
    echo ""
    echo "}"
else
    echo ""
    echo -e "${CYAN}=== Evermind — Health Check ===${NC}"
    echo ""
    for KEY in backend frontend llm-chat llm-memory llm-judge; do
        STATUS="${RESULTS[${KEY}]}"
        if [[ "${STATUS}" == "healthy" ]]; then
            echo -e "  ${GREEN}✔${NC} ${KEY}: ${GREEN}${STATUS}${NC}"
        else
            echo -e "  ${RED}✘${NC} ${KEY}: ${RED}${STATUS}${NC}"
        fi
    done
    echo ""
    if [ "${UNHEALTHY}" -eq 0 ]; then
        echo -e "  ${GREEN}All services are healthy${NC}"
    else
        echo -e "  ${YELLOW}${UNHEALTHY} service(s) unhealthy${NC}"
    fi
    echo ""
fi

exit "${UNHEALTHY}"
