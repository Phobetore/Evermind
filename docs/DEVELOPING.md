# Developing Evermind

Technical notes for people working on the code. If you only want to *use*
Evermind, read [INSTALL.md](../INSTALL.md) instead.

## Layout

```
backend/   FastAPI + SQLite (aiosqlite, plain SQL migrations)
  app/__main__.py  python -m app: reads .env, checks the port, starts the server
  app/ui.py        serves the built interface wherever no route answers, and
                   redirects the old paths
  app/gate.py      a middleware: the access password (one session per device),
                   the refusal of writes from other origins, the host names
  app/prompting/   prompt engine ({{char}}/{{user}} macros, context budget, RP rules)
                   embeddings.py + retrieval.py: optional semantic memory
  app/providers/   LLM connectors (openai-compatible, anthropic), normalized SSE
  app/services/    chat_service: one turn = one streamed call (send / regenerate / continue)
                   memory_service: fact extraction, rolling summary, consolidation
  migrations/      NNN_name.sql, applied in filename order
frontend/  Vite + React 19 + Tailwind v4, a single-page app routed by hash
  src/pages/       one page per route
  src/router.tsx   the routes, which live after the "#" of the address
  src/data/        index.ts: `data`, every call the interface makes to the server
  src/lib/cards.ts Character Card V2 codec (JSON + PNG "chara" chunk), in the browser
  src/components/  layout/Access.tsx keeps the pages behind the access password
  src/i18n/        homemade i18n: JSON dictionaries + useT() hook (en, fr, de, es)
  e2e/             Playwright tests, run against the real server
library/   starter cards shipped with the repo
data/      SQLite database + uploaded media (created at first run, never committed)
```

## Running it

```bash
# production: build the interface, then one server for the interface and the API
scripts\prod.ps1 [-Lan]        # Windows
./scripts/prod.sh [--lan]      # macOS / Linux

# development, with hot reload, in two terminals
cd backend && .venv/Scripts/python -m app --dev   # the API, restarted on every change
cd frontend && npm run dev                        # the interface (npm run dev:lan: on the network)
```

The environment's Python is `.venv/Scripts/python` on Windows, as written here,
and `.venv/bin/python` elsewhere. The scripts create `backend/.venv` when it has
no working pip, install the dependencies again when `backend/pyproject.toml` or
`frontend/package-lock.json` has changed (the backend without its test tools:
`pip install -e "backend[dev]"` once, to run the tests), ask
`python -m app --check` whether the port is free before the interface is
installed or built, build it (Vite 8 needs **Node.js 22.12 or newer**), and start
`python -m app`, which is all a restart without the build needs, from `backend/`.

`python -m app [--lan] [--dev] [--check] [--no-env-file]` is how Evermind starts,
from the scripts, the container and the end-to-end suite alike. It reads `.env` at
the repository root, values as written, quotes included (one saved by Notepad or
PowerShell reads the same as a plain one), and **the environment wins** over the
file. `BIND` (default `127.0.0.1`) and `PORT` (default `3000`) say where to
listen, `--lan` is `BIND=0.0.0.0`, and the data folder is `EVERMIND_DATA_DIR`. It
first checks that the port is free: `--check` stops there and prints the port.
`--no-env-file` leaves `.env` out (the container and the end-to-end suite use
it). Outside a container it then prints its addresses and, when it listens beyond
this computer, warns if no password is set and, on Windows, prints the firewall
rule other devices need.

**In production there is one process and one port.** FastAPI answers `/api/` and
serves the built interface (`frontend/dist`, or `EVERMIND_UI_DIR`) for everything
else. Its routes live after the `#` (`/#/chat/<id>`), so one page answers every
route and the same build works wherever it is put; the paths of the 2.x interface
(`/chat/<id>`, `/characters/...`, `/personas`, `/settings`, `/login`) redirect to
their hash form. Files under `/assets/` carry a hash in their name and are cached
for good; `index.html` is always revalidated, which is how a phone picks up a new
build.

**In development there are two.** `python -m app --dev` serves the API alone, on
the loopback, on `EVERMIND_BACKEND_PORT` (default `8000`, unused outside this
mode), and restarts whenever `backend/app` changes. Vite serves the interface on
`PORT` and relays `/api` to the API with the browser's own `Host`
(`changeOrigin: false`), which the API compares with a write's `Origin`. With
`npm run dev:lan`, Vite listens on the network and the API stays behind it
(`python -m app --dev --lan` then warns if no password is set).

The backend deliberately runs a **single uvicorn worker**: the replies being
written, the memory-maintenance lock and the count of wrong passwords are
per-process, so multiple workers would race.

No real model to hand? `python scripts/mock_llm.py` serves an OpenAI-compatible
endpoint on `http://localhost:5599/v1` that streams placeholder roleplay text,
plus valid JSON for the memory and card-assistant prompts.

## Tests

```bash
cd backend && .venv/Scripts/python -m pytest
cd backend && .venv/Scripts/python -m ruff check app tests
cd frontend && npx tsc --noEmit
cd frontend && npm run lint
cd frontend && npm test                         # Vitest, no browser
cd frontend && npm run build
cd frontend && npm run test:e2e                 # a real browser, both sizes
```

CI runs all of them. The backend suite covers the whole API through mocked
providers, so it never needs a model or a network, and no test reads your `.env`
or the password in your environment.

`npm run test:e2e` builds the interface into `frontend/dist-e2e`, never
`frontend/dist`, so a run cannot replace the interface of an Evermind you are
using. Playwright then starts a mock model and two `python -m app` servers from
`backend/.venv`, one behind an access password, each on a port and a data
directory of its own. None reads `.env`, and the suite removes `EVERMIND_*`,
`BIND`, `PORT`, `SEMANTIC`, `FORWARDED_ALLOW_IPS` and the proxy variables from
what they inherit; the rest of your environment, `PATH` for one, still reaches
them. It needs the browser once: `npx playwright install chromium`.
`npm run test:e2e:ui` opens Playwright's runner.

The servers listen on this computer's network address, as for a phone (an
insecure context), so the first run may make Windows ask whether Python may
accept connections. Answer **Allow access**. Cancel, or closing the prompt, makes
Windows create rules that block `python.exe`, and a block rule beats every allow
rule, the port rule Evermind prints included. An Evermind started from the source
runs as that same `python.exe`, so a phone could no longer reach it until those
rules are deleted (`wf.msc`, Inbound Rules).

Each test in `e2e/` is written against a fault that typecheck and build cannot
see, such as a button off the side of a phone or an API the browser withholds
outside a secure context, and should be checked to fail when that fault is put
back: a test that passes either way reads like cover.

## Main API surface

- `POST /api/chat`: modes `send` / `regenerate` / `continue`, answered once the message is saved;
  `GET /api/conversations/{id}/turn` says how the reply stands and the messages' `revision`, which
  the conversation carries too, `.../turn/stream` follows it (SSE) and `DELETE .../turn` stops it
- CRUD on `characters` (each with its whole lorebook), `personas`, `connections`,
  `conversations`, `memories`
- `POST /api/characters/assist`: drafts a card from a free-form brief
- `POST /api/conversations/{id}/memories/extract`, `.../memories/consolidate`
- `GET /api/library`: the cards in `library/`. The browser reads and writes card
  files itself (`frontend/src/lib/cards.ts`), and installs or imports a card by
  creating a character
- `GET /api/gate`: whether a password is set and whether this device is past it,
  and if it is, its cookie again for another 400 days; `POST /api/gate` signs in
  and sets the session cookie; `DELETE /api/gate` signs this device out;
  `DELETE /api/gate/sessions` signs every device out

A sign-in whose body is over 4096 bytes, or that does not give its length as four
digits at most in `Content-Length`, is refused unread: `413` with
`"kind": "too_large"`. With a password set, everything under `/api/` except
`/api/health` and `/api/gate` answers `401` with `"kind": "locked"` until the
device has signed in. A path under `/api/` that no route answers gets the API's
own JSON 404, never the interface's page.

Password or not, a request under `/api/` other than `GET` or `HEAD` whose
`Origin` does not name the `Host` it arrived with answers `403` with
`"kind": "cross_origin"`; one without `Origin`, from curl or a script, goes
through. Without a password, a `Host` that is not an address or `localhost`
answers `403` with `"kind": "unknown_host"`.
[SECURITY.md](../SECURITY.md#requests-from-other-sites) says why. The Vite dev
server checks `Host` by its own default, which lets addresses and `localhost`
through.

An error is `{"error": "<English sentence>", "kind": "<name>"}`, and a `not_found`
adds `"resource"` (`character`, `conversation`, `message`, `persona`,
`connection`, `fact`, `illustration`, `file`). The sentence is for whoever reads
the API; the interface shows its own text for the `kind`, and for how a reply
failed, which `GET /api/conversations/{id}/turn` tells, in the person's language
(`frontend/src/lib/errors.ts`, sentences under `errors` in the locale files). A
new `AppError` needs a `kind`, and a test fails without one.

When a model's server is what failed (a `ProviderError`, `502`), the kind says how:
`unreachable` (nothing answered at its address, or the address is not one),
`model_connection_lost` (the connection broke off or went quiet),
`model_auth_refused`, `model_not_found` or `model_rate_limited` (an error status
401, 404 or 429), or `model_error` (any other error status, or an error inside its
stream). The `error` is then what that server said (`HTTP <status>` when it said
nothing), the address that could not be reached, or how the connection broke,
which the interface quotes after its own sentence. A model that answers with
nothing is `model_empty` (`model_no_text` for the benchmark), and an answer that
cannot be read is `model_unreadable`. The connection test and the benchmark fail
the same way.

FastAPI's own answers have no `kind`: `{"detail": ...}` for a route that does not
exist (`404`), a method a route does not take (`405`) or a body that does not
validate (`422`, each problem's `type`, `loc` and `msg`, never what was sent).
Neither has a proxy's, often not JSON, which the request layer gives the kind
`http_error` and the message `HTTP <status>`. The interface shows a sentence of
its own for their status, never their words. A kind it does not know yet shows
the server's English sentence until it gets a line in `errors.ts` and a sentence
in the four languages.

## Serving under a path prefix

Evermind works behind a reverse proxy that serves it under a path such as
`/evermind/` and removes the prefix before passing the request on. With nginx:

```nginx
location /evermind/ {
    proxy_pass http://127.0.0.1:3000/;
    # As the browser sent it, port included. Without it every write is refused
    # as cross_origin (see above), since Origin and Host differ.
    proxy_set_header Host $http_host;
    # Who the client is and how it came, in the proxy's own words: what the
    # client sent as X-Forwarded-For is replaced, never passed along.
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    # An address of its own, since a browser on this computer connects from
    # 127.0.0.1. Only for a proxy_pass to this computer, as here. macOS needs
    # "sudo ifconfig lo0 alias 127.0.0.2" first, until it restarts.
    proxy_bind 127.0.0.2;
}
```

Evermind's `.env` then names that address, `FORWARDED_ALLOW_IPS=127.0.0.2`, the
only one it believes those two headers from.
[SECURITY.md](../SECURITY.md#behind-a-reverse-proxy) says why, and what to name
in other setups, Docker's among them.

The prefix needs nothing more, since nothing is addressed from the root of the
host: the build uses relative asset paths (`base: "./"`) and routes after the
`#`, so the address of the page, without the fragment, is the root of the app;
every call in `frontend/src/data/index.ts` is for `api/...`, without a leading
slash, resolved against that address; and the server writes the addresses of
images the same way, `api/media/<file>`. The one thing that does not follow the
prefix is the redirect of an old 2.x bookmark such as `/chat/<id>`, to
`/#/chat/<id>` at the root of the host. The Vite dev server and the end-to-end
servers run at the root of their host, where `api/...` is `/api/...`.

## How a turn is built

`prompting/engine.py::build_chat_payload` is the heart of the project and is a
pure function: no I/O, fully unit-tested. In order it assembles the system prompt
(card, persona, rolling summary, keyword-triggered lore, established facts, RP
rules), then the raw history as native user/assistant turns, then a post-history
block re-stating the guardrails and the player's scene directive as close to
generation as possible.

Three things are worth knowing before changing it:

- **Facts whose source turn is still visible are dropped.** Re-stating a message
  the model can already see is pure echo, and was a leading cause of repetition
  loops on long chats.
- **`stats["oldest_visible"]` is the true oldest rendered turn**, not the
  provisional estimate used internally for the anti-echo filter. Passage recall
  relies on that exactness to avoid injecting something already on screen.
- **A conversation opens on an assistant turn** when the character has a
  greeting, since the character then speaks first. Some chat templates refuse
  that shape and stream zero tokens, or an error inside a stream already begun
  (which gets the same retry, unlike an error status), so the first message of a
  first conversation fails or dies in silence.
  `chat_service` retries once with `fold_leading_assistant=True`, which moves the
  leading assistant turns into the system prompt and leaves a list that starts
  with the player. It is the weaker shape, since the model reads its own opening
  as instruction rather than as its voice, so it is only ever a fallback.
  Observed on `rocinante-x-12b-v1`; `snowpiercer-15b-v4` handles either.

## Recorded cases

`backend/tests/cases/` holds cases `{fn, name, input, expected}` for the memory
pass and the default prompts: `input` is the named arguments of the function and
`expected` is what the code answered when the case was written. A change that
moves one on purpose is regenerated from `backend/`:

```bash
.venv/Scripts/python -m tests.test_recorded_cases
```

Read the diff, since it is the change in behaviour. Never edit an `expected` by
hand, and never remove a case that fails.

## Optional semantic memory

Installing the `semantic` extra swaps recency-based recall for meaning-based
recall, on both established facts and old message passages:

```bash
cd backend && .venv/Scripts/python -m pip install -e ".[semantic]"
```

It pulls in `sentence-transformers` (a few GB with torch) and downloads
`intfloat/multilingual-e5-small` once, then works offline. The model is only ever
loaded by a task at start, so no request can trigger a download. Without the
extra, `embed()` and `rank()` return `None` and vectors stay `NULL`: recall falls
back to recency, and nothing raises.

## Translations

The dictionaries are `frontend/src/i18n/locales/{en,fr,de,es}.json`. `en` is the
fallback, so it has to be complete, and the others carry exactly its keys:
`npm test` fails on a key missing or unknown, or on an empty value, which would
render as nothing at all rather than as an error. Interpolation placeholders
(`{count}`, `{name}`) and card macros (`{{char}}`, `{{user}}`) must survive
translation untouched.

## Docker

There is one image, `ghcr.io/phobetore/evermind`, built from the **repository
root** as context (it needs `frontend/`, `backend/` and `library/`), so only the
root `.dockerignore` applies. A Node stage compiles the interface and only the
finished files are copied into the Python image that runs, so neither Node nor
the npm tree ships. The container serves the interface and the API on port 8000,
and `docker-compose.yml` publishes that as `${BIND:-127.0.0.1}:${PORT:-3000}:8000`.

The image is configured through its environment (it starts with `--no-env-file`,
and `.dockerignore` keeps every `.env*` file out of it), so
`EVERMIND_GATE_PASSWORD` is read when the container starts and the password can
be changed without rebuilding.

## Cutting a release

1. Bump `__version__` in `backend/app/__init__.py`, the one place that holds the
   version: `backend/pyproject.toml` reads it from there, and the interface's
   `package.json` stays at `0.0.0`. `/api/health` and the update check read
   `__version__` rather than the installed distribution, whose metadata keeps
   the number it had when `pip install -e` last ran.
2. Push a `v*` tag. That builds the image for amd64 and arm64, pushes it to
   ghcr.io, and attaches `docker-compose.yml` and `env.example` to the release,
   creating an empty release first if the tag arrived before it. INSTALL.md
   installs from `releases/latest/download/docker-compose.yml`, so a release
   without those files breaks the documented install.
3. Write the notes once that release exists: a release published any earlier
   becomes `releases/latest` while the image is still building, without those
   files. A release that asks something of people who already run Evermind gets a
   section in [UPGRADING.md](UPGRADING.md), and its notes point there.

## Conventions

- Migrations are append-only; never edit one that has shipped.
- Components never call `fetch`. Every call to the server goes through `data` in
  `src/data/index.ts` (its type is `DataSource`), with its error handling, and its
  address never starts with a slash ([why](#serving-under-a-path-prefix)).
- Repositories return plain dicts, which the routes answer with; there is no ORM,
  and Pydantic validates input only.
- Bytes columns (`embedding`) must never reach a JSON response. The `to_out`
  helpers strip them.
