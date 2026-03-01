# Evermind

Application web locale de type "AI companion" — multi-personnages, mémoire longue durée, texte uniquement.

## Quick Start

```bash
# Install all dependencies and create directories
make setup

# Start all services (production mode)
make start

# Stop all services
make stop
```

Open [http://localhost:3000](http://localhost:3000).

## Scripts

| Script | Description |
|--------|-------------|
| `scripts/setup.sh` | Install dependencies, create directories, validate config |
| `scripts/start.sh` | Start all services (LLM servers, backend, frontend) |
| `scripts/stop.sh` | Gracefully stop all services |
| `scripts/health-check.sh` | Check health status of all services |
| `scripts/setup.ps1` | Windows equivalent of `setup.sh` |
| `scripts/start.ps1` | Windows equivalent of `start.sh` |
| `scripts/stop.ps1` | Windows equivalent of `stop.sh` |
| `scripts/health-check.ps1` | Windows equivalent of `health-check.sh` |

### Start script options

```bash
./scripts/start.sh                  # Start all services
./scripts/start.sh --backend-only   # Start only the backend API
./scripts/start.sh --skip-llm       # Start backend + frontend without LLM servers
```

## Makefile

Run `make help` to see all available commands:

```
make setup           Install dependencies and create directories
make dev             Start backend + frontend (dev mode with hot reload)
make start           Start all services (production)
make stop            Stop all services
make test            Run all tests
make lint            Run linters
make health          Check health of all services
make validate-config Validate config.yaml
make clean           Remove logs and caches
make reset-db        Delete the database (recreated on next start)
```

## Database

The SQLite database lives at `data/app.db`. Migrations are applied automatically
on every start.

### Reset the database

```bash
# Via make (works on Linux, macOS, and Windows/PowerShell)
make reset-db

# Or manually in PowerShell
Remove-Item data\app.db, data\app.db-wal, data\app.db-shm -Force -ErrorAction SilentlyContinue

# Or manually on Linux / macOS
rm -f data/app.db data/app.db-wal data/app.db-shm
```

The database will be recreated with all migrations on the next `make dev` or
`make start`.

## Configuration

All services are configured via `config.yaml` at the project root. See the
[infrastructure roadmap](docs/roadmaps/infrastructure-team.md) for the full schema.

Override the config file location with the `EVERMIND_CONFIG` environment variable.

### Validate configuration

```bash
# Quick validation
make validate-config

# Detailed validation (from backend directory)
cd backend
python -m app.validate_config ../config.yaml
python -m app.validate_config --check-dirs --check-ports ../config.yaml
```

## Project Structure

```
Evermind/
├── backend/          # FastAPI + SQLite
│   ├── app/          # Application source
│   ├── migrations/   # SQL migration files
│   └── tests/        # pytest test suite
├── frontend/         # Next.js + TypeScript
│   └── src/          # Application source
├── scripts/          # Start/stop/setup scripts (Linux + Windows)
├── docs/             # Roadmaps & specifications
├── models/           # LLM model files (git-ignored)
│   ├── chat/         # Chat model (e.g. Gemma-3 12B)
│   ├── memory/       # Memory extraction model (e.g. Qwen3-4B)
│   ├── judge/        # Judge/scoring model (e.g. Qwen3-4B)
│   └── embeddings/   # Sentence-transformer cache
├── data/             # Runtime data (SQLite DB, PID files)
├── logs/             # Service log files
├── config.yaml       # Shared configuration
├── Makefile          # Common operations
└── README.md
```

## Documentation

- **[Roadmaps Équipes](docs/roadmaps/README.md)** — Roadmaps détaillées par équipe (Frontend, Backend, AI & Mémoire, Infrastructure, Database)
- **[Addendum v1.1](docs/roadmaps/addendum-v1.1.md)** — Diagramme de séquence, spécification `meta`, templates prompts finalisés, conventions timing & tokens
