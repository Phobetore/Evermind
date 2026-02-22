#!/usr/bin/env bash
# ==============================================================================
# Evermind — Setup Script (Linux/macOS)
# ==============================================================================
# Initializes the project environment:
#   - Creates required directories (models/, logs/, data/)
#   - Validates config.yaml
#   - Checks system dependencies (Python, Node.js, pip, npm)
#   - Installs backend & frontend dependencies
#
# Usage:
#   ./scripts/setup.sh              # Full setup
#   ./scripts/setup.sh --check      # Only check dependencies (no install)
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
CHECK_ONLY=false

for arg in "$@"; do
    case "$arg" in
        --check) CHECK_ONLY=true ;;
        --help|-h)
            echo "Usage: $0 [--check] [--help]"
            echo ""
            echo "Options:"
            echo "  --check    Only check dependencies (no install)"
            echo "  --help     Show this help message"
            exit 0
            ;;
        *) echo -e "${RED}Unknown option: $arg${NC}"; exit 1 ;;
    esac
done

# ── Helpers ───────────────────────────────────────────────────────────────────

log_info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
log_ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }

ERRORS=0

check_command() {
    local cmd="$1"
    local name="$2"
    local min_version="${3:-}"

    if command -v "${cmd}" > /dev/null 2>&1; then
        local version
        version=$("${cmd}" --version 2>&1 | head -1)
        log_ok "${name}: ${version}"
    else
        log_error "${name} not found (command: ${cmd})"
        ERRORS=$((ERRORS + 1))
    fi
}

echo ""
echo -e "${CYAN}=== Evermind — Setup ===${NC}"
echo ""

# ── 1. Check system dependencies ─────────────────────────────────────────────

echo -e "${CYAN}--- Checking dependencies ---${NC}"
echo ""

check_command "python3" "Python 3"
check_command "pip3" "pip"
check_command "node" "Node.js"
check_command "npm" "npm"

# curl is used for health checks
check_command "curl" "curl"

# Optional: check for llama-server
LLAMA_SERVER="${PROJECT_ROOT}/bin/llama-server"
if [ -x "${LLAMA_SERVER}" ]; then
    log_ok "llama-server: ${LLAMA_SERVER}"
else
    log_warn "llama-server not found at ${LLAMA_SERVER} (optional — for LLM serving)"
fi

echo ""

if [ "${ERRORS}" -gt 0 ]; then
    log_error "${ERRORS} required dependency/ies missing. Please install them first."
    exit 1
fi

# ── 2. Validate config.yaml ──────────────────────────────────────────────────

echo -e "${CYAN}--- Validating configuration ---${NC}"
echo ""

if [ ! -f "${CONFIG_FILE}" ]; then
    log_error "Configuration file not found: ${CONFIG_FILE}"
    exit 1
fi

# Use the backend's own config parser for validation
VALIDATION_RESULT=$(python3 << PYEOF
import sys
sys.path.insert(0, "${PROJECT_ROOT}/backend")
from app.config import load_config
from pathlib import Path
try:
    cfg = load_config(Path("${CONFIG_FILE}"))
    servers = list(cfg.llm_servers.keys())
    profiles = list(cfg.profiles.keys())
    sep = ","
    s_str = sep.join(servers)
    p_str = sep.join(profiles)
    print(f"OK|servers={len(servers)}({s_str})|profiles={len(profiles)}({p_str})|embeddings={cfg.embeddings.model_name}")
except Exception as e:
    print(f"ERROR|{e}")
PYEOF
)

if [[ "${VALIDATION_RESULT}" == OK* ]]; then
    log_ok "config.yaml is valid"
    IFS='|' read -ra PARTS <<< "${VALIDATION_RESULT}"
    for part in "${PARTS[@]:1}"; do
        log_info "  ${part}"
    done
else
    log_error "config.yaml validation failed: ${VALIDATION_RESULT}"
    exit 1
fi

echo ""

if [ "${CHECK_ONLY}" = true ]; then
    echo -e "${GREEN}=== All checks passed ===${NC}"
    echo ""
    exit 0
fi

# ── 3. Create directories ────────────────────────────────────────────────────

echo -e "${CYAN}--- Creating directories ---${NC}"
echo ""

DIRS=(
    "${PROJECT_ROOT}/data"
    "${PROJECT_ROOT}/logs"
    "${PROJECT_ROOT}/models/chat"
    "${PROJECT_ROOT}/models/memory"
    "${PROJECT_ROOT}/models/judge"
    "${PROJECT_ROOT}/models/embeddings"
)

for dir in "${DIRS[@]}"; do
    if [ ! -d "${dir}" ]; then
        mkdir -p "${dir}"
        log_ok "Created: ${dir#"${PROJECT_ROOT}/"}"
    else
        log_info "Exists:  ${dir#"${PROJECT_ROOT}/"}"
    fi
done

echo ""

# ── 4. Install backend dependencies ──────────────────────────────────────────

echo -e "${CYAN}--- Installing backend dependencies ---${NC}"
echo ""

cd "${PROJECT_ROOT}/backend"
pip3 install -e ".[dev]" --quiet 2>&1 | tail -2
log_ok "Backend dependencies installed"
cd "${PROJECT_ROOT}"

echo ""

# ── 5. Install frontend dependencies ─────────────────────────────────────────

echo -e "${CYAN}--- Installing frontend dependencies ---${NC}"
echo ""

cd "${PROJECT_ROOT}/frontend"
npm install --silent 2>&1 | tail -2
log_ok "Frontend dependencies installed"
cd "${PROJECT_ROOT}"

echo ""

# ── Summary ───────────────────────────────────────────────────────────────────

echo -e "${GREEN}=== Setup complete ===${NC}"
echo ""
echo -e "  Start:  ${CYAN}./scripts/start.sh${NC}"
echo -e "  Test:   ${CYAN}cd backend && python -m pytest${NC}"
echo -e "  Lint:   ${CYAN}cd backend && ruff check .${NC}"
echo ""
