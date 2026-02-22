#!/usr/bin/env bash
# ==============================================================================
# Evermind — Start Script (Linux/macOS)
# ==============================================================================
# Starts all Evermind services in the correct order:
#   1) LLM servers (chat, memory, judge) via llama-server
#   2) Backend (FastAPI / Uvicorn)
#   3) Frontend (Next.js)
#
# Usage:
#   ./scripts/start.sh                  # Start all services
#   ./scripts/start.sh --backend-only   # Start only the backend (no LLM/frontend)
#   ./scripts/start.sh --skip-llm       # Start backend + frontend without LLM servers
#
# Environment variables:
#   EVERMIND_CONFIG  — Path to config.yaml (default: auto-detected)
# ==============================================================================

set -euo pipefail

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Colour

# ── Paths ─────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

CONFIG_FILE="${EVERMIND_CONFIG:-${PROJECT_ROOT}/config.yaml}"
PID_FILE="${PROJECT_ROOT}/data/.pids"
LOG_DIR="${PROJECT_ROOT}/logs"

# ── Flags ─────────────────────────────────────────────────────────────────────
BACKEND_ONLY=false
SKIP_LLM=false

for arg in "$@"; do
    case "$arg" in
        --backend-only) BACKEND_ONLY=true ;;
        --skip-llm)    SKIP_LLM=true ;;
        --help|-h)
            echo "Usage: $0 [--backend-only] [--skip-llm] [--help]"
            echo ""
            echo "Options:"
            echo "  --backend-only   Start only the backend API server"
            echo "  --skip-llm       Start backend + frontend without LLM servers"
            echo "  --help, -h       Show this help message"
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown option: $arg${NC}"
            exit 1
            ;;
    esac
done

# ── Helpers ───────────────────────────────────────────────────────────────────

log_info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
log_ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }

# Read a value from config.yaml using Python (no extra dependencies).
read_config() {
    python3 -c "
import yaml, sys
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

# Wait for an HTTP endpoint to respond 200 OK.
# Arguments: url name timeout [pid]
# If pid is provided, the function checks that the process is still running
# on each iteration and returns immediately if it has exited.
wait_for_health() {
    local url="$1"
    local name="$2"
    local timeout="${3:-60}"
    local pid="${4:-}"
    local elapsed=0

    while [ "$elapsed" -lt "$timeout" ]; do
        if curl -sf --max-time 2 "${url}" > /dev/null 2>&1; then
            return 0
        fi
        # If a PID was provided, check that the process is still alive
        if [ -n "${pid}" ] && ! kill -0 "${pid}" 2>/dev/null; then
            wait "${pid}" 2>/dev/null
            local exit_code=$?
            # wait returns 127 if the PID is not a child of this shell
            if [ "${exit_code}" -eq 127 ]; then
                exit_code="unknown"
            fi
            log_error "${name} process (PID ${pid}) exited unexpectedly with code ${exit_code}."
            return 2
        fi
        sleep 2
        elapsed=$((elapsed + 2))
    done
    return 1
}

# Check if a port is already in use.
check_port_free() {
    local port="$1"
    if command -v ss > /dev/null 2>&1; then
        if ss -tlnp 2>/dev/null | grep -q ":${port} "; then
            return 1
        fi
    elif command -v lsof > /dev/null 2>&1; then
        if lsof -i ":${port}" > /dev/null 2>&1; then
            return 1
        fi
    fi
    return 0
}

# Detect whether a compatible GPU is available.
check_gpu_available() {
    # Check for Vulkan support (preferred backend)
    if command -v vulkaninfo > /dev/null 2>&1; then
        if vulkaninfo --summary 2>/dev/null | grep -qi 'gpu'; then
            return 0
        fi
    fi
    # Fallback: check for NVIDIA GPU via nvidia-smi
    if command -v nvidia-smi > /dev/null 2>&1; then
        if nvidia-smi > /dev/null 2>&1; then
            return 0
        fi
    fi
    # Fallback: check for GPU render devices
    if [ -d /dev/dri ] && ls /dev/dri/renderD* > /dev/null 2>&1; then
        return 0
    fi
    return 1
}

# ── Pre-flight checks ────────────────────────────────────────────────────────

echo ""
echo -e "${CYAN}=== Evermind — Démarrage ===${NC}"
echo ""

# Check config file exists
if [ ! -f "${CONFIG_FILE}" ]; then
    log_error "Configuration file not found: ${CONFIG_FILE}"
    log_error "Run './scripts/setup.sh' first or set EVERMIND_CONFIG."
    exit 1
fi
log_ok "Configuration: ${CONFIG_FILE}"

# Check if already running
if [ -f "${PID_FILE}" ]; then
    log_warn "PID file already exists: ${PID_FILE}"
    log_warn "Evermind may already be running. Use './scripts/stop.sh' first."
    exit 1
fi

# Read configuration values
BIND_HOST=$(read_config "bind_host")
BACKEND_PORT=$(read_config "backend_port")
FRONTEND_PORT=$(read_config "frontend_port")

BIND_HOST="${BIND_HOST:-127.0.0.1}"
BACKEND_PORT="${BACKEND_PORT:-8000}"
FRONTEND_PORT="${FRONTEND_PORT:-3000}"

# Create required directories
mkdir -p "${PROJECT_ROOT}/data"
mkdir -p "${LOG_DIR}"
mkdir -p "${PROJECT_ROOT}/models/chat"
mkdir -p "${PROJECT_ROOT}/models/memory"
mkdir -p "${PROJECT_ROOT}/models/judge"
mkdir -p "${PROJECT_ROOT}/models/embeddings"

log_ok "Directories verified"

# Check required ports
PORTS_TO_CHECK=("${BACKEND_PORT}")
if [ "${BACKEND_ONLY}" = false ]; then
    PORTS_TO_CHECK+=("${FRONTEND_PORT}")
fi

for port in "${PORTS_TO_CHECK[@]}"; do
    if ! check_port_free "${port}"; then
        log_error "Port ${port} is already in use."
        exit 1
    fi
done
log_ok "Required ports are available"

# ── Track PIDs ────────────────────────────────────────────────────────────────
declare -a PIDS=()
declare -a PID_LABELS=()

save_pids() {
    : > "${PID_FILE}"
    for i in "${!PIDS[@]}"; do
        echo "${PID_LABELS[$i]}=${PIDS[$i]}" >> "${PID_FILE}"
    done
}

cleanup_on_error() {
    log_error "Startup failed — stopping already-launched services..."
    for pid in "${PIDS[@]}"; do
        kill "${pid}" 2>/dev/null || true
    done
    rm -f "${PID_FILE}"
    exit 1
}

# ── Step 1: Start LLM servers ────────────────────────────────────────────────

STEP=1
TOTAL_STEPS=3
if [ "${BACKEND_ONLY}" = true ]; then
    TOTAL_STEPS=1
elif [ "${SKIP_LLM}" = true ]; then
    TOTAL_STEPS=2
fi

if [ "${BACKEND_ONLY}" = false ] && [ "${SKIP_LLM}" = false ]; then
    LLAMA_SERVER="${PROJECT_ROOT}/bin/llama-server"

    if [ ! -x "${LLAMA_SERVER}" ]; then
        log_warn "llama-server binary not found at ${LLAMA_SERVER}"
        log_warn "Skipping LLM server startup. Ensure LLM servers are started externally."
    else
        # Verify the binary can execute at all (catches missing libs / arch mismatch)
        if ! "${LLAMA_SERVER}" --help > /dev/null 2>&1; then
            log_error "llama-server binary failed to execute: ${LLAMA_SERVER}"
            log_error "The binary may be incompatible with your system or missing shared libraries."
            log_error "Try running '${LLAMA_SERVER} --help' manually to diagnose."
            exit 1
        fi
        log_ok "llama-server binary verified"

        # Detect GPU availability once before starting servers
        GPU_DETECTED=false
        if check_gpu_available; then
            GPU_DETECTED=true
            log_ok "GPU detected — GPU offloading enabled"
        else
            log_info "No compatible GPU detected — LLM servers will run on CPU"
        fi

        for SERVER_NAME in chat memory judge; do
            SERVER_PORT=$(read_config "llm_servers.${SERVER_NAME}.port")
            MODEL_PATH=$(read_config "llm_servers.${SERVER_NAME}.model_path")
            CTX=$(read_config "llm_servers.${SERVER_NAME}.ctx")
            N_GPU_LAYERS=$(read_config "llm_servers.${SERVER_NAME}.n_gpu_layers")
            THREADS=$(read_config "llm_servers.${SERVER_NAME}.threads")

            SERVER_PORT="${SERVER_PORT:-8081}"
            CTX="${CTX:-8192}"
            N_GPU_LAYERS="${N_GPU_LAYERS:-"-1"}"
            THREADS="${THREADS:-4}"

            # If GPU was not detected, force CPU-only mode
            if [ "${GPU_DETECTED}" = false ] && [ "${N_GPU_LAYERS}" != "0" ]; then
                N_GPU_LAYERS="0"
            fi

            FULL_MODEL_PATH="${PROJECT_ROOT}/${MODEL_PATH}"

            if [ ! -f "${FULL_MODEL_PATH}" ]; then
                log_warn "Model file not found for ${SERVER_NAME}: ${FULL_MODEL_PATH}"
                log_warn "Skipping ${SERVER_NAME} server."
                continue
            fi

            if ! check_port_free "${SERVER_PORT}"; then
                log_warn "Port ${SERVER_PORT} in use — skipping ${SERVER_NAME} server."
                continue
            fi

            log_info "[${STEP}/${TOTAL_STEPS}] Starting LLM server: ${SERVER_NAME} (port ${SERVER_PORT})..."
            log_info "  Command: ${LLAMA_SERVER} --model ${FULL_MODEL_PATH} --host ${BIND_HOST} --port ${SERVER_PORT} --ctx-size ${CTX} --n-gpu-layers ${N_GPU_LAYERS} --threads ${THREADS}"

            "${LLAMA_SERVER}" \
                --model "${FULL_MODEL_PATH}" \
                --host "${BIND_HOST}" \
                --port "${SERVER_PORT}" \
                --ctx-size "${CTX}" \
                --n-gpu-layers "${N_GPU_LAYERS}" \
                --threads "${THREADS}" \
                > "${LOG_DIR}/llm-${SERVER_NAME}.log" 2>&1 &

            LLM_PID=$!
            PIDS+=("${LLM_PID}")
            PID_LABELS+=("llm-${SERVER_NAME}")

            # Wait for health (also checks process liveness)
            health_result=0
            wait_for_health "http://${BIND_HOST}:${SERVER_PORT}/health" "${SERVER_NAME}" 60 "${LLM_PID}" || health_result=$?

            # GPU fallback: if startup failed and GPU layers were requested, try
            # partial offloading first, then fall back to CPU-only.
            if [ $health_result -ne 0 ] && [ "${N_GPU_LAYERS}" != "0" ]; then
                # Build a list of fallback values to try before giving up.
                # When the user requested all layers (-1), try a partial offload
                # (32 layers covers most mid-size models) then CPU-only.
                FALLBACK_VALUES=()
                if [ "${N_GPU_LAYERS}" = "-1" ]; then
                    FALLBACK_VALUES=(32 0)
                else
                    FALLBACK_VALUES=(0)
                fi

                PREV_NGL="${N_GPU_LAYERS}"
                for FALLBACK_NGL in "${FALLBACK_VALUES[@]}"; do
                    if [ "${FALLBACK_NGL}" = "0" ]; then
                        log_warn "GPU mode failed for '${SERVER_NAME}' — retrying with --n-gpu-layers 0 (CPU-only)..."
                    else
                        log_warn "Full GPU offload failed for '${SERVER_NAME}' — retrying with --n-gpu-layers ${FALLBACK_NGL} (partial)..."
                    fi
                    kill "${LLM_PID}" 2>/dev/null || true
                    wait "${LLM_PID}" 2>/dev/null || true
                    # Preserve the previous attempt's log for diagnostics
                    mv "${LOG_DIR}/llm-${SERVER_NAME}.log" "${LOG_DIR}/llm-${SERVER_NAME}-gpu-failed-ngl${PREV_NGL}.log" 2>/dev/null || true
                    # Wait for the port to be released before retrying
                    port_wait=0
                    while [ $port_wait -lt 10 ] && ! check_port_free "${SERVER_PORT}"; do
                        sleep 1
                        port_wait=$((port_wait + 1))
                    done

                    "${LLAMA_SERVER}" \
                        --model "${FULL_MODEL_PATH}" \
                        --host "${BIND_HOST}" \
                        --port "${SERVER_PORT}" \
                        --ctx-size "${CTX}" \
                        --n-gpu-layers "${FALLBACK_NGL}" \
                        --threads "${THREADS}" \
                        > "${LOG_DIR}/llm-${SERVER_NAME}.log" 2>&1 &

                    LLM_PID=$!
                    PIDS[${#PIDS[@]}-1]="${LLM_PID}"

                    health_result=0
                    wait_for_health "http://${BIND_HOST}:${SERVER_PORT}/health" "${SERVER_NAME}" 60 "${LLM_PID}" || health_result=$?
                    if [ $health_result -eq 0 ]; then
                        if [ "${FALLBACK_NGL}" = "0" ]; then
                            log_ok "LLM server '${SERVER_NAME}' is healthy in CPU-only mode (PID ${LLM_PID})"
                            log_warn "GPU offloading failed — '${SERVER_NAME}' is running on CPU (this will be slower)."
                        else
                            log_ok "LLM server '${SERVER_NAME}' is healthy with --n-gpu-layers ${FALLBACK_NGL} (PID ${LLM_PID})"
                            log_warn "Full GPU offload failed — '${SERVER_NAME}' is running with partial GPU offloading."
                        fi
                        break
                    fi
                    PREV_NGL="${FALLBACK_NGL}"
                done

                if [ $health_result -eq 0 ]; then
                    continue
                fi
            fi

            if [ $health_result -eq 0 ]; then
                log_ok "LLM server '${SERVER_NAME}' is healthy (PID ${LLM_PID})"
            else
                if [ $health_result -ne 2 ]; then
                    log_error "LLM server '${SERVER_NAME}' failed to start within 60 seconds."
                fi
                LOG_FILE="${LOG_DIR}/llm-${SERVER_NAME}.log"
                if [ -s "${LOG_FILE}" ]; then
                    log_error "Last 20 lines of ${LOG_FILE}:"
                    tail -n 20 "${LOG_FILE}" | while IFS= read -r line; do
                        echo "         ${line}"
                    done
                else
                    log_error "Log file is empty: ${LOG_FILE}"
                    log_error "The server process may have crashed before producing output."
                    log_error "Verify that the llama-server binary is compatible with your system."
                fi
                cleanup_on_error
            fi
        done
    fi

    STEP=$((STEP + 1))
fi

# ── Step 2: Start Backend ────────────────────────────────────────────────────

log_info "[${STEP}/${TOTAL_STEPS}] Starting backend (port ${BACKEND_PORT})..."

cd "${PROJECT_ROOT}/backend"
python3 -m uvicorn app.main:app \
    --host "${BIND_HOST}" \
    --port "${BACKEND_PORT}" \
    > "${LOG_DIR}/backend.log" 2>&1 &

BACKEND_PID=$!
PIDS+=("${BACKEND_PID}")
PID_LABELS+=("backend")
cd "${PROJECT_ROOT}"

backend_result=0
wait_for_health "http://${BIND_HOST}:${BACKEND_PORT}/health" "backend" 30 "${BACKEND_PID}" || backend_result=$?
if [ $backend_result -eq 0 ]; then
    log_ok "Backend is healthy (PID ${BACKEND_PID})"
else
    if [ $backend_result -ne 2 ]; then
        log_error "Backend failed to start within 30 seconds."
    fi
    log_error "Check logs: ${LOG_DIR}/backend.log"
    cleanup_on_error
fi

STEP=$((STEP + 1))

# ── Step 3: Start Frontend ───────────────────────────────────────────────────

if [ "${BACKEND_ONLY}" = false ]; then
    log_info "[${STEP}/${TOTAL_STEPS}] Starting frontend (port ${FRONTEND_PORT})..."

    FRONTEND_DIR="${PROJECT_ROOT}/frontend"

    # next start requires a production build (.next directory)
    if [ ! -d "${FRONTEND_DIR}/.next" ]; then
        log_info "Frontend build not found — running 'npm run build'..."
        cd "${FRONTEND_DIR}"
        if npm run build > "${LOG_DIR}/frontend-build.log" 2>&1; then
            log_ok "Frontend build completed"
        else
            log_error "Frontend build failed. Check logs: ${LOG_DIR}/frontend-build.log"
            cleanup_on_error
        fi
    fi

    cd "${FRONTEND_DIR}"
    npm run start -- --port "${FRONTEND_PORT}" \
        > "${LOG_DIR}/frontend.log" 2>&1 &

    FRONTEND_PID=$!
    PIDS+=("${FRONTEND_PID}")
    PID_LABELS+=("frontend")
    cd "${PROJECT_ROOT}"

    # Frontend takes longer to start — give it more time
    if wait_for_health "http://${BIND_HOST}:${FRONTEND_PORT}" "frontend" 60 "${FRONTEND_PID}"; then
        log_ok "Frontend is healthy (PID ${FRONTEND_PID})"
    else
        log_warn "Frontend may still be starting — check logs: ${LOG_DIR}/frontend.log"
    fi
fi

# ── Save PIDs & summary ──────────────────────────────────────────────────────

save_pids

echo ""
echo -e "${GREEN}=== Evermind is running! ===${NC}"
echo ""
echo -e "  Backend:  ${CYAN}http://${BIND_HOST}:${BACKEND_PORT}${NC}"
if [ "${BACKEND_ONLY}" = false ]; then
    echo -e "  Frontend: ${CYAN}http://${BIND_HOST}:${FRONTEND_PORT}${NC}"
fi
echo -e "  API docs: ${CYAN}http://${BIND_HOST}:${BACKEND_PORT}/docs${NC}"
echo ""
echo -e "  PIDs:     ${PID_FILE}"
echo -e "  Logs:     ${LOG_DIR}/"
echo ""
echo -e "  Stop:     ${CYAN}./scripts/stop.sh${NC}"
echo ""
