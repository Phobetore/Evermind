# ==============================================================================
# Evermind — Makefile
# ==============================================================================
# Common operations for development, testing, and deployment.
#
# Usage:
#   make setup        Install all dependencies and create directories
#   make dev          Start backend + frontend in development mode
#   make start        Start all services (production)
#   make stop         Stop all services
#   make test         Run all tests
#   make lint         Run linters
#   make health       Check service health
#   make clean        Remove generated files (logs, caches)
# ==============================================================================

.PHONY: help setup dev start stop test lint lint-fix health clean \
        test-backend lint-backend lint-backend-fix \
        dev-backend dev-frontend build-frontend \
        check validate-config

# ── OS detection ──────────────────────────────────────────────────────────────
ifeq ($(OS),Windows_NT)
    SHELL_CMD = powershell -ExecutionPolicy Bypass -File
else
    SHELL_CMD =
endif

# Default target
help:
	@echo ""
	@echo "  Evermind — Available commands"
	@echo "  ─────────────────────────────────────────────────"
	@echo ""
	@echo "  Setup & dependencies:"
	@echo "    make setup           Install dependencies and create directories"
	@echo "    make check           Check system dependencies (no install)"
	@echo ""
	@echo "  Development:"
	@echo "    make dev             Start backend + frontend (dev mode)"
	@echo "    make dev-backend     Start backend only (dev mode with reload)"
	@echo "    make dev-frontend    Start frontend only (dev mode)"
	@echo ""
	@echo "  Production:"
	@echo "    make start           Start all services"
	@echo "    make stop            Stop all services"
	@echo "    make health          Check health of all services"
	@echo ""
	@echo "  Quality:"
	@echo "    make test            Run all tests"
	@echo "    make test-backend    Run backend tests only"
	@echo "    make lint            Run all linters"
	@echo "    make lint-backend    Run backend linter (ruff)"
	@echo "    make lint-fix        Auto-fix lint issues"
	@echo ""
	@echo "  Build:"
	@echo "    make build-frontend  Build frontend for production"
	@echo "    make validate-config Validate config.yaml"
	@echo ""
	@echo "  Maintenance:"
	@echo "    make clean           Remove logs and caches"
	@echo ""

# ── Setup ─────────────────────────────────────────────────────────────────────

ifeq ($(OS),Windows_NT)
setup:
	@$(SHELL_CMD) scripts/setup.ps1

check:
	@$(SHELL_CMD) scripts/setup.ps1 -CheckOnly
else
setup:
	@./scripts/setup.sh

check:
	@./scripts/setup.sh --check
endif

# ── Development ───────────────────────────────────────────────────────────────

dev-backend:
	cd backend && python3 -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload

dev-frontend:
	cd frontend && npm run dev

dev:
	@echo "Starting development servers..."
	@echo "Backend:  http://127.0.0.1:8000"
	@echo "Frontend: http://127.0.0.1:3000"
	@echo ""
	@echo "Press Ctrl+C to stop."
	@$(MAKE) -j2 dev-backend dev-frontend

# ── Production ────────────────────────────────────────────────────────────────

ifeq ($(OS),Windows_NT)
start:
	@$(SHELL_CMD) scripts/start.ps1

stop:
	@$(SHELL_CMD) scripts/stop.ps1

health:
	@$(SHELL_CMD) scripts/health-check.ps1
else
start:
	@./scripts/start.sh

stop:
	@./scripts/stop.sh

health:
	@./scripts/health-check.sh
endif

# ── Quality ───────────────────────────────────────────────────────────────────

test: test-backend

test-backend:
	cd backend && python3 -m pytest tests/ -v

lint: lint-backend

lint-backend:
	cd backend && ruff check .

lint-fix: lint-backend-fix

lint-backend-fix:
	cd backend && ruff check --fix .

# ── Build ─────────────────────────────────────────────────────────────────────

build-frontend:
	cd frontend && npm run build

validate-config:
	@python3 -c "\
	import sys; \
	sys.path.insert(0, 'backend'); \
	from app.config import load_config; \
	from pathlib import Path; \
	cfg = load_config(Path('config.yaml')); \
	print('Config OK — servers:', list(cfg.llm_servers.keys()), '— profiles:', list(cfg.profiles.keys())); \
	"

# ── Maintenance ───────────────────────────────────────────────────────────────

ifeq ($(OS),Windows_NT)
clean:
	@echo Cleaning generated files...
	@powershell -Command "Remove-Item -Path 'logs\*.log' -Force -ErrorAction SilentlyContinue"
	@powershell -Command "Remove-Item -Path 'backend\__pycache__','backend\app\__pycache__' -Recurse -Force -ErrorAction SilentlyContinue"
	@powershell -Command "Remove-Item -Path 'frontend\.next' -Recurse -Force -ErrorAction SilentlyContinue"
	@powershell -Command "Remove-Item -Path 'data\.pids' -Force -ErrorAction SilentlyContinue"
	@echo Done.
else
clean:
	@echo "Cleaning generated files..."
	rm -rf logs/*.log
	rm -rf backend/__pycache__ backend/app/__pycache__ backend/app/**/__pycache__
	rm -rf frontend/.next
	rm -f data/.pids
	@echo "Done."
endif
