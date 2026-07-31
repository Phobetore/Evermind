# Developing Evermind

Technical notes for people working on the code. If you only want to *use*
Evermind, read [INSTALL.md](../INSTALL.md) instead.

## Layout

```
backend/   FastAPI + SQLite (aiosqlite, plain SQL migrations)
  app/cards/       Character Card V2 codec (JSON + PNG "chara" chunk)
  app/prompting/   prompt engine ({{char}}/{{user}} macros, context budget, RP rules)
                   embeddings.py + retrieval.py: optional semantic memory
  app/providers/   LLM connectors (openai-compatible, anthropic), normalized SSE
  app/services/    chat_service: one turn = one streamed call (send / regenerate / continue)
                   memory_service: fact extraction, rolling summary, consolidation
  migrations/      NNN_name.sql, applied in filename order
frontend/  Next.js 16 + React 19 + Tailwind v4, proxies /api to the backend
  src/i18n/        homemade i18n: JSON dictionaries + useT() hook (en, fr, de, es)
library/   starter cards shipped with the repo
data/      SQLite database + uploaded media (created at first run, never committed)
```

## Running it

```bash
# development, with hot reload
scripts\dev.ps1            # Windows
./scripts/dev.sh           # macOS / Linux

# production build, much faster to actually play on
scripts\prod.ps1 [-SkipBuild] [-Lan]
./scripts/prod.sh [--skip-build] [--lan]
```

The backend deliberately runs a **single uvicorn worker**: the memory-maintenance
lock and the SQLite writes are per-process, so multiple workers would race.

No real model to hand? `python scripts/mock_llm.py` serves an OpenAI-compatible
endpoint on `http://localhost:5599/v1` that streams placeholder roleplay text,
plus valid JSON for the memory and card-assistant prompts.

## Tests

```bash
cd backend && .venv/Scripts/python -m pytest    # 150+ tests
cd backend && .venv/Scripts/python -m ruff check app tests
cd frontend && npx tsc --noEmit
cd frontend && npm run build
```

The backend suite covers the whole API through mocked providers, so it never
needs a model or a network. The frontend has no unit-test framework; typecheck
and build are the gate.

## Main API surface

- `POST /api/chat`: SSE stream, modes `send` / `regenerate` / `continue`
- CRUD on `characters`, `personas`, `connections`, `conversations`, `memories`, `lore`
- `POST /api/characters/import`, `GET /api/characters/{id}/export?format=json|png`
- `POST /api/characters/assist`: drafts a card from a free-form brief
- `POST /api/conversations/{id}/summarize`, `.../memories/extract`, `.../memories/consolidate`
- `GET /api/library`, `POST /api/library/{filename}/install`

Responses are plain dicts shaped by the repositories; Pydantic is used for input
validation only. User-facing messages are English.

## How a turn is built

`prompting/engine.py::build_chat_payload` is the heart of the project and is a
pure function: no I/O, fully unit-tested. In order it assembles the system prompt
(card, persona, rolling summary, keyword-triggered lore, established facts, RP
rules), then the raw history as native user/assistant turns, then a post-history
block re-stating the guardrails and the player's scene directive as close to
generation as possible.

Two things are worth knowing before changing it:

- **Facts whose source turn is still visible are dropped.** Re-stating a message
  the model can already see is pure echo, and was a leading cause of repetition
  loops on long chats.
- **`stats["oldest_visible"]` is the true oldest rendered turn**, not the
  provisional estimate used internally for the anti-echo filter. Passage recall
  relies on that exactness to avoid injecting something already on screen.

## Optional semantic memory

Installing the `semantic` extra swaps recency-based recall for meaning-based
recall, on both established facts and old message passages:

```bash
cd backend && .venv/Scripts/python -m pip install -e ".[semantic]"
```

It pulls in `sentence-transformers` (a few GB with torch) and downloads
`intfloat/multilingual-e5-small` once, then works offline. Without the extra
every call degrades silently to the previous recency behaviour: `embed()` returns
`None`, vectors stay `NULL`, `rank()` returns `None`. Nothing raises, and the
model is only ever loaded from the startup warmup task, so no user request can
trigger a download.

## Translations

Dictionaries live in `frontend/src/i18n/locales/{en,fr,de,es}.json` and must all
carry exactly the same keys; `en` is the fallback, so it has to be complete.
Interpolation placeholders (`{count}`, `{name}`) and card macros (`{{char}}`,
`{{user}}`) must survive translation untouched.

Quick parity check:

```bash
cd frontend && node -e "const L=['fr','en','de','es'].map(l=>require('./src/i18n/locales/'+l+'.json'));const f=(o,p='')=>Object.entries(o).flatMap(([k,v])=>v&&typeof v==='object'?f(v,p+k+'.'):[p+k]);const F=new Set(f(L[0]));L.forEach((d,i)=>{const S=new Set(f(d));console.log(['fr','en','de','es'][i],S.size,[...F].filter(k=>!S.has(k)).length===0?'OK':'MISSING')})"
```

## Docker

Both images build from the **repository root** as context (the backend needs
`library/`). Only the root `.dockerignore` applies. The frontend bakes
`EVERMIND_BACKEND_URL` at build time because Next resolves `rewrites()` during
`next build`; `EVERMIND_GATE_PASSWORD` on the other hand is read at runtime, so
the password can be changed without rebuilding.

## Cutting a release

1. Bump the version in `backend/pyproject.toml`, `frontend/package.json` and the
   two project entries in `frontend/package-lock.json`. `/api/health` reads its
   number from the installed distribution, so nothing else needs touching.
2. Push a `v*` tag. That builds both images for amd64 and arm64, pushes them to
   ghcr.io, and attaches `docker-compose.yml` and `env.example` to the release,
   creating an empty release first if the tag arrived before it.
3. Write the notes.

The attached files are not decoration: INSTALL.md tells people to install by
downloading `releases/latest/download/docker-compose.yml` and nothing else, so a
release missing them breaks the documented path for everyone who follows it.

## Conventions

- Migrations are append-only; never edit one that has shipped.
- Repositories return dicts, never ORM objects; there is no ORM.
- Bytes columns (`embedding`) must never reach a JSON response. The `to_out`
  helpers strip them.
- Commit messages in English, present tense, explaining the *why* when it is not
  obvious from the diff.
