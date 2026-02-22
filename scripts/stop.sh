#!/usr/bin/env bash
# ==============================================================================
# Evermind — Stop Script (Linux/macOS)
# ==============================================================================
# Gracefully stops all Evermind services using the PID file.
#
# Usage:
#   ./scripts/stop.sh
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
PID_FILE="${PROJECT_ROOT}/data/.pids"

# ── Helpers ───────────────────────────────────────────────────────────────────

log_info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
log_ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }

echo ""
echo -e "${CYAN}=== Evermind — Arrêt ===${NC}"
echo ""

# ── Check PID file ───────────────────────────────────────────────────────────

if [ ! -f "${PID_FILE}" ]; then
    log_warn "PID file not found: ${PID_FILE}"
    log_warn "Evermind may not be running (or was started externally)."
    exit 0
fi

# ── Stop services (reverse order: frontend → backend → LLM) ─────────────────

STOPPED=0
FAILED=0

# Read PIDs and stop in reverse order (last started = first stopped)
mapfile -t LINES < "${PID_FILE}"

for ((i=${#LINES[@]}-1; i>=0; i--)); do
    LINE="${LINES[$i]}"
    [ -z "${LINE}" ] && continue

    LABEL="${LINE%%=*}"
    PID="${LINE##*=}"

    if [ -z "${PID}" ] || [ -z "${LABEL}" ]; then
        continue
    fi

    if kill -0 "${PID}" 2>/dev/null; then
        log_info "Stopping ${LABEL} (PID ${PID})..."
        kill "${PID}" 2>/dev/null || true

        # Wait for graceful shutdown (up to 10 seconds)
        ELAPSED=0
        while kill -0 "${PID}" 2>/dev/null && [ "${ELAPSED}" -lt 10 ]; do
            sleep 1
            ELAPSED=$((ELAPSED + 1))
        done

        if kill -0 "${PID}" 2>/dev/null; then
            log_warn "${LABEL} did not stop gracefully — sending SIGKILL..."
            kill -9 "${PID}" 2>/dev/null || true
            sleep 1
        fi

        if ! kill -0 "${PID}" 2>/dev/null; then
            log_ok "${LABEL} stopped"
            STOPPED=$((STOPPED + 1))
        else
            log_error "Failed to stop ${LABEL} (PID ${PID})"
            FAILED=$((FAILED + 1))
        fi
    else
        log_warn "${LABEL} (PID ${PID}) is not running"
    fi
done

# ── Clean up PID file ────────────────────────────────────────────────────────

rm -f "${PID_FILE}"

echo ""
if [ "${FAILED}" -eq 0 ]; then
    echo -e "${GREEN}=== Evermind stopped (${STOPPED} services) ===${NC}"
else
    echo -e "${YELLOW}=== Evermind stopped with issues (${STOPPED} ok, ${FAILED} failed) ===${NC}"
fi
echo ""
