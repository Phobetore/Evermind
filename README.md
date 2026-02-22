# Evermind

Application web locale de type "AI companion" — multi-personnages, mémoire longue durée, texte uniquement.

## Prérequis

| Outil | Version minimum | Notes |
|-------|----------------|-------|
| **Python** | ≥ 3.11 | Backend FastAPI |
| **Node.js** | ≥ 18 | Frontend Next.js |
| **llama.cpp** (`llama-server`) | Build récent | Compilé avec `-DGGML_VULKAN=ON` — voir [llama.cpp](https://github.com/ggml-org/llama.cpp) |
| **Drivers Vulkan** | — | GPU Vulkan compatible (testé sur AMD Radeon 16 Go VRAM) |

## Modèles GGUF

Téléchargez les modèles GGUF depuis HuggingFace et placez-les dans l'arborescence `models/` à la racine du projet :

```
models/
├── chat/
│   └── gemma-3-12b-it-heretic.gguf        # p-e-w/gemma-3-12b-it-heretic (~7-8 Go Q4_K_M)
├── memory/
│   └── qwen3-4b-heretic.gguf              # p-e-w/Qwen3-4B-Instruct-2507-heretic (~2.5 Go Q4_K_M)
└── judge/
    └── qwen3-4b-heretic.gguf              # p-e-w/Qwen3-4B-Instruct-2507-heretic (~2.5 Go Q4_K_M)
```

Les noms de fichiers et chemins doivent correspondre à ceux définis dans `config.yaml` (section `llm_servers`).

> **Embeddings :** le modèle `intfloat/e5-small-v2` est téléchargé automatiquement au premier lancement (CPU, ~100 Mo).

## Configuration

Le fichier [`config.yaml`](config.yaml) à la racine contient les ports, chemins des modèles, profils de génération et paramètres de logging. Consultez la [documentation Infrastructure](docs/roadmaps/infrastructure-team.md) pour le détail du schéma.

## Quick Start

### 1. Serveurs LLM

Lancez au minimum le serveur **chat** (les serveurs mémoire et juge sont nécessaires à partir de la v0.2) :

```bash
llama-server --model models/chat/gemma-3-12b-it-heretic.gguf \
    --port 8081 --ctx-size 8192 --n-gpu-layers -1
```

### 2. Backend

```bash
cd backend
pip install -e ".[dev]"
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

### 3. Frontend

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