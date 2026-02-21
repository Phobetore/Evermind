# Evermind

Application web locale de type "AI companion" — multi-personnages, mémoire longue durée, texte uniquement.

## Quick Start

### Backend

```bash
cd backend
pip install -e ".[dev]"
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Project Structure

```
Evermind/
├── backend/          # FastAPI + SQLite
│   ├── app/          # Application source
│   ├── migrations/   # SQL migration files
│   └── tests/        # pytest test suite
├── frontend/         # Next.js + TypeScript
│   └── src/          # Application source
├── docs/             # Roadmaps & specifications
├── config.yaml       # Shared configuration
└── README.md
```

## Documentation

- **[Roadmaps Équipes](docs/roadmaps/README.md)** — Roadmaps détaillées par équipe (Frontend, Backend, AI & Mémoire, Infrastructure, Database)
- **[Addendum v1.1](docs/roadmaps/addendum-v1.1.md)** — Diagramme de séquence, spécification `meta`, templates prompts finalisés, conventions timing & tokens