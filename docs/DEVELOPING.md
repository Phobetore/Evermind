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
  app/cards/       Character Card V2 codec (JSON + PNG "chara" chunk)
  app/prompting/   prompt engine ({{char}}/{{user}} macros, context budget, RP rules)
                   embeddings.py + retrieval.py: optional semantic memory
  app/providers/   LLM connectors (openai-compatible, anthropic), normalized SSE
  app/services/    chat_service: one turn = one streamed call (send / regenerate / continue)
                   memory_service: fact extraction, rolling summary, consolidation
  migrations/      NNN_name.sql, applied in filename order
frontend/  Vite + React 19 + Tailwind v4, a single-page app routed by hash
  src/pages/       one page per route, fetched when it is first opened
  src/router.tsx   the routes, which live after the "#" of the address
  src/data/        the typed DataSource the interface talks to; http/ implements it
  src/components/  layout/Access.tsx keeps the pages behind the access password
  src/i18n/        homemade i18n: JSON dictionaries + useT() hook (en, fr, de, es)
  e2e/             Playwright tests, run against the real server
library/   starter cards shipped with the repo
data/      SQLite database + uploaded media (created at first run, never committed)
```

## Running it

```bash
# production: build the interface, then one server for the interface and the API
scripts\prod.ps1 [-SkipBuild] [-Lan]        # Windows
./scripts/prod.sh [--skip-build] [--lan]    # macOS / Linux

# development, with hot reload
scripts\dev.ps1 [-Lan]
./scripts/dev.sh [--lan]
```

The scripts only get everything ready: they create the Python environment when
`backend/.venv` has no working pip (so a creation that was interrupted is done
again, not mistaken for a finished one), install the dependencies again when
`backend/pyproject.toml` or `frontend/package-lock.json` has changed, build the
interface (production only; Vite 8 needs **Node.js 22.12 or newer**), and start
`python -m app`. Once Python's side is installed, and before the interface is
installed or built, they ask `python -m app --check` about the port: production
about `PORT`, development about the API's `EVERMIND_BACKEND_PORT`, and neither
goes on if it is taken. `dev.ps1 -Lan` and `dev.sh --lan` also ask about `PORT`,
the one Vite uses, and only warn, since Vite does not stop for a port that is
taken. On Windows, `-Lan` also checks that the firewall lets the port through.
`dev.sh` stops the API and Vite whichever way it is stopped (Ctrl+C, SIGTERM, a
closed terminal), and for that Vite runs without a keyboard to read, so its
shortcuts (`h` + enter) are not available there.

`python -m app` is the one way Evermind is started, whoever starts it: the
scripts, the container, the end-to-end suite. From `backend/`, with the
virtualenv the scripts create:

```bash
.venv/Scripts/python -m app [--lan] [--dev] [--check] [--host H] [--port N] \
                            [--root-path PATH] [--data-dir DIR] \
                            [--env-file PATH | --no-env-file]
```

It reads `.env` at the repository root, then the environment, and **the
environment wins** over the file. The file may have been saved by Notepad or
PowerShell (a byte order mark, CRLF line endings, even UTF-16, which it also
reads without the mark); it reads the same as a plain one. `BIND` (default
`127.0.0.1`) and `PORT` (default `3000`) say where to listen, and `--lan` is
`BIND=0.0.0.0`. Before anything else it checks that the port is free; `--check`
stops right after that and prints the port, so the scripts can ask once Python
is installed and before the interface is installed or built. Once it starts, it
prints the local address and, when it listens on the network, that one too, with
a warning if no password is set. Inside the container it prints neither, since
`docker-compose.yml` is what decides what is exposed there.

**In production there is one process and one port.** FastAPI answers `/api/` and
serves the built interface (`frontend/dist`, or wherever `EVERMIND_UI_DIR`
points) for everything else. The interface is a single page whose routes live
after the `#` (`/#/chat/<id>`), so the server has one file to hand out whatever
the route, and the same build works wherever it is put. The paths the previous
interface used (`/chat/<id>`, `/characters/...`, `/personas`, `/settings`,
`/login`) redirect to their hash form, which keeps old bookmarks working. Files
under `/assets/` carry a hash in their name and are cached for good; `index.html`
is always revalidated, which is how a phone picks up a new build.

**In development there are two.** `python -m app --dev` serves the API alone, on
`EVERMIND_BACKEND_PORT` (default `8000`), on the loopback only, and restarts
whenever `backend/app` changes. The Vite dev server serves the interface on
`PORT` (default `3000`) with hot reload and relays `/api` to the API, so the
browser still sees one origin, as it does in production. The relay leaves the
`Host` header as the browser sent it, which the API needs to recognise the
interface's writes as its own (see below). With `--lan` it is Vite
that listens on the network and the API stays behind it. `EVERMIND_BACKEND_PORT`
means nothing outside this mode.

Components never call `fetch`. Everything the interface asks of the server goes
through `src/data/`, a typed `DataSource` with an HTTP implementation, so the
calls and their error handling live in one place.

The backend deliberately runs a **single uvicorn worker**: the memory-maintenance
lock, the SQLite writes and the cache of access-password sessions are
per-process, so multiple workers would race.

No real model to hand? `python scripts/mock_llm.py` serves an OpenAI-compatible
endpoint on `http://localhost:5599/v1` that streams placeholder roleplay text,
plus valid JSON for the memory and card-assistant prompts.

## Tests

```bash
cd backend && .venv/Scripts/python -m pytest    # 800+ tests
cd backend && .venv/Scripts/python -m ruff check app tests
cd frontend && npx tsc --noEmit
cd frontend && npm run lint
cd frontend && npm test                         # Vitest, no browser
cd frontend && npm run build
cd frontend && npm run test:e2e                 # a real browser, both sizes
```

The backend suite covers the whole API through mocked providers, so it never
needs a model or a network. No test reads your `.env` or the password in your
environment.

`npm run test:e2e` first builds the interface into `frontend/dist-e2e`, never
`frontend/dist`, so a run cannot replace the interface of an Evermind you are
using. Playwright then starts the whole stack itself: a mock model and two
`python -m app` servers, one of them behind an access password, each on a port
and a data directory of its own. None reads `.env`, and each starts with an
environment built from scratch, so no `EVERMIND_*` variable of your shell
reaches them. It runs them from the virtualenv in `backend/.venv`, which the
launch scripts create, and needs the browser once:
`npx playwright install chromium`. `npm run test:e2e:ui` opens Playwright's
runner if you want to watch one.

It exists because typecheck and build are blind to the kind of thing that
actually broke: a button falling off the side of a phone, an API the browser
withholds when the app is reached by address rather than on localhost, a message
disappearing while a reply streams. Each test in `e2e/` is written against a
specific fault, and should be checked to fail when that fault is put back — a
test that passes either way is worse than none, because it reads like cover.

## Main API surface

- `POST /api/chat`: SSE stream, modes `send` / `regenerate` / `continue`
- CRUD on `characters`, `personas`, `connections`, `conversations`, `memories`, `lore`
- `POST /api/characters/import`, `GET /api/characters/{id}/export?format=json|png`
- `POST /api/characters/assist`: drafts a card from a free-form brief
- `POST /api/conversations/{id}/summarize`, `.../memories/extract`, `.../memories/consolidate`
- `GET /api/library`, `POST /api/library/{filename}/install`
- `GET /api/gate`: whether a password is set and whether this device is past it;
  `POST /api/gate` signs in and sets the session cookie; `DELETE /api/gate` signs
  this device out; `DELETE /api/gate/sessions` signs every device out

With a password set, everything under `/api/` except `/api/health` and
`/api/gate` answers `401` with `"kind": "locked"` until the device has signed in.
A path under `/api/` that no route answers gets the API's own JSON 404, never the
interface's page.

Password or not, a `POST`, `PUT`, `PATCH` or `DELETE` under `/api/` that a
browser sends from a page of another origin answers `403` with
`"kind": "cross_origin"`, and such a page's websocket is closed. The browser
says so in `Sec-Fetch-Site` over HTTPS and on localhost, and otherwise only in
`Origin`, which the API compares with the scheme and `Host` the request arrived
with. So a reverse proxy must either use HTTPS or preserve `Host`. A request
with neither header, from curl or a script, is let through.

Without a password, anything under `/api/` whose `Host` is not an address,
`localhost` (or a name ending in `.localhost`), this machine's name (also with
`.local`) or a name in `EVERMIND_ALLOWED_HOSTS` answers `403` with
`"kind": "unknown_host"`: a page whose own name was pointed at 127.0.0.1 (DNS
rebinding) looks same-origin in every other header. The header is read strictly,
so a name with anything after it (`localhost:3000@evil.com`) is not the name in
front of it, and a request without a `Host` header is refused with a sentence of
its own. In a container the machine's name is the container's, which nobody
types, so with Docker the computer's own name has to be listed. With a password
the name is not checked.

Responses are plain dicts shaped by the repositories; Pydantic is used for input
validation only.

An error is `{"error": "<English sentence>", "kind": "<name>"}`, and a `not_found`
adds `"resource"` (`character`, `conversation`, `message`, `persona`,
`connection`, `lore_entry`, `fact`, `library_card`, `illustration`, `file`). The
sentence is for whoever reads the API; the interface reads `kind` and shows its
own text for it, in the language the person chose (`frontend/src/lib/errors.ts`,
sentences under `errors` in `frontend/src/i18n/locales/`). The same goes for the
error events of a reply's stream. A new `AppError` needs a `kind`, and a test
fails without one.

When a model's server is what failed, the kind says how (`unreachable`,
`model_auth_refused`, `model_not_found`, `model_rate_limited`, `model_http_error`,
`model_timeout`, `model_network_error`, `model_unexpected_response`, or
`model_error` for a complaint of its own), and what it said travels apart from the
sentence: `upstream` is its words as it sent them (for a page that is not JSON,
the words of the page without its markup, cut short), `upstream_status` its status,
and `upstream_url` the address that could not be reached, without any
`user:password@` in it. The interface cannot translate what another program wrote,
so it says the failure in the person's language, with the address where there is
one, and shows `upstream` after it. The connection test, the
benchmark and the model list report failures the same way inside their `200`
bodies: `{"ok": false, "detail": "<English sentence>", "kind": ..., "upstream": ...}`.

Some answers never come from an `AppError`, and have no `kind`: FastAPI's
own, `{"detail": ...}` for a route that does not exist (`404`), a method a route
does not take (`405`) or a request body that does not validate (`422`, with a list
of problems in `detail`), and whatever a proxy in front of the server answers,
often not JSON at all. The request layer gives the last an `http_error` kind and
the status as its message (`HTTP 502`). The interface does not show the words of
any of them: a `422` is "something is missing or not valid", a `404` a missing
thing, a `5xx` "Evermind answered with an error (HTTP n)", and any other `4xx` the
generic "Something went wrong". A kind the interface does not know yet, on the
other hand, shows the server's English sentence until it gets a line in
`errors.ts` and a sentence in the four languages.

## Serving under a path prefix

Evermind works behind a reverse proxy that serves it under a path such as
`/evermind/` and removes the prefix before passing the request on. With nginx:

```nginx
location /evermind/ {
    proxy_pass http://127.0.0.1:3000/;
    # As the browser sent it, port included. Without it every write over plain
    # HTTP is refused as cross_origin (see above), since Origin and Host differ.
    proxy_set_header Host $http_host;
}
```

Tell the server the prefix with `EVERMIND_ROOT_PATH=/evermind` (in `.env`, or in the
environment of the container) or `python -m app --root-path /evermind`. Whitespace
around the value and slashes at its end are trimmed (`/evermind/` is `/evermind`,
and a lone `/` is the root). A value that does not start with a slash is refused,
and so is one with `//` at its start or inside, a `.` or `..` segment, a backslash,
a `%`, a `?`, a `#` or whitespace inside it. The pages, every call and every image work
without it. What it adds is the redirect of an old `/chat/<id>` bookmark, which has
to go to `/evermind/#/chat/<id>`, a place the server can only name if it knows the
prefix.

The page, its files, every call and every image stay under the prefix because none
of them is addressed from the root of the host:

- the build uses relative asset paths (`base: "./"`) and its routes live after
  the `#`, so the address of the page, without the fragment, is always the root of
  the app;
- every request in `frontend/src/data/http/` is for `api/...`, without a leading
  slash, and is resolved against that address;
- the addresses of images the API returns (`/api/media/<file>`) are made relative
  the same way, in `frontend/src/data/http/media.ts`, where the objects come back,
  so that no component has to know.

So new code that calls the API goes through the data layer, and an address written
there never starts with a slash (a test resolves the calls under a prefix). The
Vite dev server and the end-to-end servers run at the root of their host, where
`api/...` is `/api/...`.

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
- **A conversation opens on an assistant turn**, because the character greets
  first. Some chat templates refuse that shape and stream zero tokens rather than
  erroring, so the first message of a first conversation dies in silence.
  `chat_service` retries once with `fold_leading_assistant=True`, which moves the
  leading assistant turns into the system prompt and leaves a list that starts
  with the player. It is the weaker shape, since the model reads its own opening
  as instruction rather than as its voice, so it is only ever a fallback.
  Observed on `rocinante-x-12b-v1`; `snowpiercer-15b-v4` handles either.

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

Parity check, which CI also runs on every push:

```bash
cd frontend && npm run check:i18n
```

It compares every locale against `en` and fails on a missing key, an unknown one,
or a key present with an empty value. That last case is the nasty one: it renders
as nothing at all rather than as an error.

## Docker

There is one image, built from the **repository root** as context (it needs
`frontend/`, `backend/` and `library/`). Only the root `.dockerignore` applies.
A Node stage compiles the interface and only the finished files are copied into
the Python image that runs, so neither Node nor the npm tree ships. The container
serves the interface and the API on port 8000, and `docker-compose.yml` publishes
that as `${BIND:-127.0.0.1}:${PORT:-3000}:8000`.

The image is configured through its environment (it starts with `--no-env-file`,
and `.dockerignore` keeps every `.env*` file out of it), so
`EVERMIND_GATE_PASSWORD` is read when the container starts and the password can
be changed without rebuilding.

It is published as `ghcr.io/phobetore/evermind`, and also as `evermind-backend`,
the name the backend image had when Evermind was two containers, so that a 2.x
`docker-compose.yml` keeps working until its owner replaces it. The interface
image that file also pulls is no longer updated. [UPGRADING.md](UPGRADING.md)
walks people through the move.

## Cutting a release

1. Bump the version in `backend/app/__init__.py`, `frontend/package.json`, the
   two project entries in `frontend/package-lock.json`, and the placeholder in
   `.github/ISSUE_TEMPLATE/bug_report.yml`. `/api/health` and the update check
   read `__version__` rather than the installed distribution, whose metadata
   keeps the number it had when `pip install -e` last ran.
2. Push a `v*` tag. That builds the image for amd64 and arm64, pushes it to
   ghcr.io under both of its names, and attaches `docker-compose.yml` and
   `env.example` to the release, creating an empty release first if the tag
   arrived before it.
3. Write the notes once that release exists. Published any earlier, it becomes
   `releases/latest` while the image is still building, without the files
   described below.

The attached files are not decoration: INSTALL.md tells people to install by
downloading `releases/latest/download/docker-compose.yml` and nothing else, so a
release missing them breaks the documented path for everyone who follows it.

A release that asks something of people who already run Evermind gets a section
in [UPGRADING.md](UPGRADING.md), and its notes point there.

## Conventions

- Migrations are append-only; never edit one that has shipped.
- Repositories return dicts, never ORM objects; there is no ORM.
- Bytes columns (`embedding`) must never reach a JSON response. The `to_out`
  helpers strip them.
- Commit messages in English, present tense, explaining the *why* when it is not
  obvious from the diff.
