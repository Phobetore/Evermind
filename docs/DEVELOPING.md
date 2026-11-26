# Developing Evermind

Technical notes for people working on the code. If you only want to *use*
Evermind, read [INSTALL.md](../INSTALL.md) instead.

## Layout

```
backend/   FastAPI + SQLite (aiosqlite, plain SQL migrations)
  app/__main__.py  python -m app: reads .env, checks the port, starts the server
  app/server.py    how that server reads a request: a capped head, a deadline
  app/ui.py        serves the built interface wherever no route answers, and
                   redirects the old paths
  app/gate.py      a middleware: the access password (one session per device),
                   the refusal of writes from other origins, the host names
  app/log_file.py  copies the warnings and errors the server logs to evermind.log
  app/prompting/   prompt engine ({{char}}/{{user}} macros, context budget, RP rules)
                   embeddings.py + retrieval.py: optional semantic memory
  app/providers/   LLM connectors (openai-compatible, anthropic), normalized SSE
  app/services/    chat_service: one turn = one streamed call (send / regenerate / continue)
                   memory_service: fact extraction, rolling summary, consolidation
  migrations/      NNN_name.sql, applied in filename order
frontend/  Vite + React 19 + Tailwind v4, a single-page app routed by hash
  src/pages/       one page per route
  src/router.tsx   the routes, which live after the "#" of the address
  src/data/        contract.ts: what the interface asks of its data source
                   http/: the calls to the server, and what the browser keeps
                   index.ts: `data`, the one door to both
  src/lib/cards.ts Character Card V2 codec (JSON + PNG "chara" chunk), in the browser
  src/components/  layout/Access.tsx keeps the pages behind the access password
  src/i18n/        homemade i18n: JSON dictionaries + useT() hook (en, fr, de, es)
  e2e/             Playwright tests, run against the real server
library/   starter cards shipped with the repo
data/      SQLite database + uploaded media + evermind.log (created at first run,
           never committed)
```

## Running it

```bash
# production: build the interface, then one server for the interface and the API
powershell -ExecutionPolicy Bypass -File scripts/prod.ps1 [-Lan]   # Windows
./scripts/prod.sh [--lan]                                          # macOS / Linux

# development, with hot reload, in two terminals
cd backend && .venv/Scripts/python -m app --dev   # the API, restarted on every change
cd frontend && npm run dev                        # the interface (npm run dev:lan: on the network)
```

The environment's Python is `.venv/Scripts/python` on Windows, as written here,
and `.venv/bin/python` elsewhere. `-ExecutionPolicy Bypass` runs the script where
a stock Windows refuses scripts, without changing its policy. The scripts create
`backend/.venv` when it has no working pip, install the dependencies again when
`backend/pyproject.toml` or `frontend/package-lock.json` has changed (the backend
without its test tools: `pip install -e "backend[dev]"` once, to run the tests),
ask `python -m app --check` whether the port is free before the interface is
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
rule other devices need. It runs uvicorn with Evermind's own HTTP protocol,
`app/server.py`: h11, which holds at most 16 KB of an unfinished request head,
with a 20 s deadline on a client that keeps the server waiting. Uvicorn started
by hand picks httptools instead, and has neither limit.

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
back: a test that passes either way reads like cover. A test that clicks a
message's button with `force` waits for the page to settle first
(`page.waitForLoadState("networkidle")`): the persona's name is drawn late, and
can move the buttons from under the click.

## Main API surface

- `POST /api/chat`: modes `send` / `regenerate` / `continue`, answered once the message is saved;
  `GET /api/conversations/{id}/turn` says how the reply stands and the messages' `revision`, which
  the conversation carries too, `.../turn/stream` follows it (SSE) and `DELETE .../turn` stops it
- CRUD on `characters` (each with its whole lorebook), `personas`, `models` (the AIs),
  `conversations`, `memories`; services are read, changed and removed under
  `/api/connections` and created with their first AIs by `POST /api/models`;
  `POST /api/connections/probe` reads a server's list of models
- `POST /api/characters/assist`: drafts a card from a free-form brief
- `POST /api/conversations/{id}/memories/extract`, `.../memories/consolidate`: run by a task
  of the server's own, as a reply is, and answered at its end; a client that goes away cancels
  nothing, only the server's stop does, and what a pass writes is one transaction. One at a
  time per conversation (`409 memory_busy`). The conversation says `memory_running`,
  `memory_operation` (`pass`, `extract` or `consolidate`) and `memory_error`: why the pass
  (automatic, or a Remember) or a Condense last failed, with the `operation` that did, until
  that work succeeds; a Condense that succeeds says nothing of a failed pass, and neither a
  Remember nor a Condense shortens the wait of an automatic pass that failed
- `GET /api/ways`, `PUT /api/ways/{id}`, `POST /api/ways`, `DELETE /api/ways/{id}`,
  `POST /api/ways/{id}/reset`, `PUT /api/ways/default`: the ways of playing, written field
  by field so that two devices changing two ways do not overwrite each other;
  `GET /api/settings` no longer carries the three settings they replace, and writing them
  answers `410` (`page_outdated`)
- `GET /api/conversations/{id}/outlook`: what each AI and each way would read of a
  conversation, worked out without asking a model; the page does the money
  (`frontend/src/lib/estimate.ts`), the server never
- `POST /api/models/{id}/observed`: records the size an AI really reads when its server
  cut a story without saying so; the conversation then plays again with it
- `GET /api/spending`, `/api/spending/detail`, `/api/spending/total`,
  `/api/spending/export.csv`, `DELETE /api/spending` (`before`, `dry_run`) and
  `POST /api/spending/forget`: what the calls cost, as sums (see "Spending"); the
  periods are the device's days (`tz`, and `tzo` for a zone Python does not know),
  and a day or a zone that cannot be read answers `422` (`bad_period`).
  `DELETE /api/conversations/{id}` and `DELETE /api/characters/{id}` take
  `?forget_name=1`; `POST /api/characters` takes `assist_jobs`; `GET /api/models`
  gives each AI a `per100`; `PUT /api/models/{id}` answers `repriced`; and
  `GET .../turn` carries `glance` and `spent` once the turn has ended, until
  anything is written through the API
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
`connection`, `model`, `fact`, `illustration`, `file`). An error may also carry
`"params"`, the numbers its sentence is made of: the card assistant's refusals
before the model is asked, `brief_too_long`, `card_too_long` and
`context_too_small`, carry `needed` (the tokens the request would take, to the
hundred above) and `context` (what the AI reads). The sentence is for
whoever reads the API; the interface shows its own text for the `kind`, and for how a reply
failed, which `GET /api/conversations/{id}/turn` tells, in the person's language
(`frontend/src/lib/errors.ts`, sentences under `errors` in the locale files). A
new `AppError` needs a `kind`, and a test fails without one.

When a model's server is what failed (a `ProviderError`, `502`), the kind says how:
`unreachable` (nothing answered at its address, or the address is not one),
`model_connection_lost` (the connection broke off or went quiet),
`model_auth_refused`, `model_not_found` or `model_rate_limited` (an error status
401, 404 or 429), or `model_error` (any other error status, or an error inside its
stream). The `error` is then what that server said (`HTTP <status>` when it said
nothing), the address that could not be reached, or how the connection broke.
The interface frames the first two in a sentence of its own, and does not show
the third. A model that answers with nothing is `model_empty` (`model_no_text`
for the benchmark), and an answer that cannot be read is `model_unreadable`. The
speed test of an AI (`/api/models/{id}/benchmark`) fails the same way.

FastAPI's own answers have no `kind`: `{"detail": ...}` for a route that does not
exist (`404`), a method a route does not take (`405`) or a body that does not
validate (`422`, each problem's `type`, `loc` and `msg`, never what was sent).
One validation answer does: a `422` for a text refused for its length carries,
beside `detail`, `"kind": "text_too_long"` or `"text_too_short"` with
`"params": {"limit": <the bound>, "length": <its own length>}`, so that the
person reads how long the text is and may be. Any other validation answer still
has no kind.
Neither has a proxy's, often not JSON, which the request layer gives the kind
`http_error` and the message `HTTP <status>`. The interface shows a sentence of
its own for their status, never their words. A kind it does not know yet shows
the server's English sentence until it gets a line in `errors.ts` and a sentence
in the four languages.

## The log file

Whatever the server logs at `WARNING` or above, through a logger under `app`
(`logging.getLogger(__name__)` in any module of the backend) or through uvicorn's
`uvicorn.error`, is also appended to `evermind.log` in the data folder
(`backend/app/log_file.py`), as `<date> <time> <LEVEL> <logger>: <message>`, an
exception with its traceback. A new `logger.warning(...)` needs nothing more to be
there; an `INFO` line, an access line or another library's own logger never is,
and what the terminal shows does not change. The file turns over at 1 MB into
`evermind.log.1`, so there are two at most. One that cannot be written stops
nothing: the terminal says so once and the server goes on without it. One held
for a moment, by a reader, a backup or another server on the same folder, is not
given up: a turn-over that Windows refuses waits for the next line, and a line
that cannot be added is in the terminal, the file saying how many it missed. It is what
people send with a bug report, and the interface never shows it: a warning says
what failed and where, never what someone wrote. Each application `create_app()`
makes installs it afresh, and the backend tests give each test a file of its own.

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
in other setups, Docker's among them. That `.env` also sets
`EVERMIND_GATE_PASSWORD` when browsers reach the proxy by a name, as they usually
do: without a password, Evermind answers only to an address or `localhost`
(`unknown_host`).

The prefix needs nothing more, since nothing is addressed from the root of the
host: the build uses relative asset paths (`base: "./"`) and routes after the
`#`, so the address of the page, without the fragment, is the root of the app;
every call in `frontend/src/data/http/index.ts` is for `api/...`, without a leading
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

## Services and AIs

A **service** is a server: its address, its key, its API type and its family
(`connections` table, `repositories/connections.py`). An **AI** is a model
chosen on a service, with its reading capacity, its reply ceiling, its settings
and its price (`models` table, `repositories/models.py`). Conversations and the
card assistant name an AI (`model_id`). The old columns of `connections` stay,
frozen, for the release before: nothing reads or writes them, and no new code
should.

- **`services/ai_call.py` is the one place that decides how an AI is asked.** It
  is pure. `ceiling` says what is sent as the reply ceiling and what the prompt
  keeps for the reply, `window` what the AI is counted to read, and `call_for`
  gives a provider and the services all they take. `reply_room(conversation,
  settings)` is the one function `auto` asks for the room a reply needs: a way
  of playing that changes it changes this function only. Nothing else may
  compute a ceiling or a window, or the prompt and the request drift apart.
  The engine in `prompting/` is unchanged: it only receives the reserve.
- **`providers/catalog.py` reads each family's list and limits.** Everything it
  reads goes through `catalog.client_factory`, which `conftest.py` replaces with
  a transport that refuses every address: no test reaches a real server. A test
  that wants an answer sets its own transport. `conftest.py` awaits
  `limits.drain()` after every test, so that a read started in the background
  by `services/limits.py` ends before its database is closed.
- **A read replaces what was read before only where it says more**
  (`repositories/models.store_read`). It is kept only while the AI still names
  the model that was read. A size is never replaced by a less sure one (served,
  then configured, then observed, then the trained maximum), reasoning is never
  unlearned, and a model no longer listed, or a read that failed, keeps all it
  had. A figure the person typed (`context_own`, `price_own_in`, ...) is never
  overwritten: a read is stored beside it. A read is also dropped when the
  service has moved to another address or API type since it began, and that
  move marks every AI of the service as to be read again (`limits_read_at`
  NULL), keeping what was read until then.
- **`POST /api/models` never adds a model twice to one service.** Asked for a
  model its service already has, it answers the AI that exists, and the name,
  the capacity and the prices sent with it are not applied: change them with
  `PUT /api/models/{id}`.
- **A key is lent to its own address only.** `routers/connections.held_service`
  is the one function that returns a service with its key. A draft with no key
  typed takes the saved key only while its API type and its address are those
  the key was given for. A key never leaves in an answer, a log or an error: only
  its end (`…4f2a`) does, and `providers/base.scrub` takes the key out of what a
  server wrote back.
- **`tests/test_requests_before.py` holds what an update must not change**: the
  requests each connection sent before 3.7.0, recorded on the code before it
  (`requests_before.json`), compared byte for byte with what an AI sends now.
  When the engine, a provider or a service that builds a request changes,
  record the file again on the code of `main` itself, not on a branch.

## Spending

Every request sent to a model's server leaves one row in `calls` (migration
`023_calls.sql`), and the rows are only ever summed. The table has **no foreign
key**, on purpose: what a conversation, a character or an AI cost stays spent once
it is deleted, so the ids are plain text and the names are copied onto the row at
call time. Deleting with `?forget_name=1`, or `POST /api/spending/forget`, blanks
those copied names; only "Clear the history" removes rows.

- **`services/calls.py` is the recorder.** `recording(...)` is an asynchronous
  context manager: it inserts the row when the request starts (`running`, the
  prompt as the engine estimates it) and completes it when it ends, however it
  ends. Each write is on a short connection of its own, committed at once, so
  that a caller's rollback or a stop never takes the row with it, and a recording
  is never opened inside a caller's `write_transaction`. A write that fails is
  logged as a warning and the call goes on. Six callers open it: the turn
  (`chat_service.run_turn`, each pass), the pen, the memory pass (each request of
  `_ask`), the condensation, the card assistant and the speed test.
- **The rules are pure functions beside it.** `outcome_of` says how a call ended
  (`whole`, `stopped`, `failed`, `refused`, `empty`, `discarded`: an error before
  the server had the request is a refusal, and a refusal reads and writes
  nothing), `tokens_of` takes the server's counts and estimates what it did not
  say, `pricing_of` copies the price as applied, `at_home` says whether a call
  was free at home, and `cost_of` gives the cost: what the service reported; else,
  away from home, what the whole price makes; else nothing known. A refusal costs
  zero, never "no price". A price counts only whole (read and written).
- **OpenRouter's record completes what it did not say.** A stopped call, or one
  never counted, is read once from `GET {base}/generation?id=`: 20 seconds and 2
  minutes after its end, and at start-up, for a call less than an hour old.
  Rows a killed process left `running` are ended `stopped` at start-up
  (`after_start`). A price typed later fills only the rows with no price for the
  same model id (`repositories/calls.reprice`, in the transaction that saves the
  price). Tests replace `calls.client_factory`, and `conftest.py` awaits
  `calls.drain()` after each test.
- **`repositories/calls.py` makes every sum in SQL**; no row is read into Python,
  and no list of calls is served but the CSV. `services/periods.py` turns the
  device's days into UTC instants (a day is 23, 24 or 25 hours long when the
  clocks change); the bars are cut by a table of bounds joined to the rows.
- **The page asks for little**: one request to open Spending, one to change
  period, one for a line's detail, and `/api/spending/total` for the lines under
  My AIs, an AI's page and a character's page. The panel of a conversation reads
  its sum once, then follows the `spent` that the end of each turn carries
  (`services/turns.py`), which also carries `glance`, so that a reply costs the
  page one request less than in 3.8.0.
- **No request to a model changes.** `backend/tests/test_requests_3_8.py` compares
  the requests recorded on 3.8.0 (`fixtures/requests_3_8.json`) with what each AI
  is sent now, with no exception. Run it with `tests/cases_kept.py` before every
  commit that touches a provider, the engine or a service that builds a request.

## Ways of playing

A way of playing is nine fields: `history_limit`, `reply_length`, `reply_room`,
`facts_cap`, `max_facts`, `lore_cap`, `lore_share`, `passage_cap` and
`passage_share`. The four built in (Light, Balanced, Immersive, Maximum) are
constants of `prompting/ways.py`, with the rules that turn them into budgets, and
the same module exists in TypeScript (`frontend/src/engine/ways.ts`). Only what a
person changed, and the ways they made, are stored (`settings`: `play_styles`,
`default_play_style`). A conversation carries `play_style` and `play_overrides`.
Balanced is the engine as it was, figure for figure.

- **The one seam is `ai_call.reply_room`**, with `chat_service` for what the
  engine rereads. A way never reaches a call anywhere else. `unsent` keeps
  `UNSENT_RESERVE` (1,024) under every way.
- **Margin and ratio.** The prompt leaves `max(200, 6%)` of the window unused
  until an AI has measured its own counts, `max(200, 3%)` after
  (`ai_call.margin_for`), plus `fit_margin`, a share of the window a refusal for
  a prompt too long may add. `services/learning.py` keeps each AI's
  `token_ratio`, the server's count over the engine's estimate, as a moving
  average of the last eight whole replies, between half and double; the engine
  divides the budget by it, so that what is sent fills the window as the server
  counts it. A count teaches no ratio when it is far under the estimate (until
  two counts that grew with the story prove the server reads what it is sent),
  or when it stood still against the AI's last count while the estimate grew.
- **Thinking.** A model that reasons is given room for its thinking on top of
  the reply's (`ai_call.thinking_allowance`): 3,072 tokens until a whole reply
  has measured it, then twice its average, never under 1,024. On Anthropic,
  which must be sent a ceiling, it is in what is sent.
- **A story read from its end.** A reply is marked `meta.truncated` when its
  count and the AI's two counts before it stand within 1% of each other while
  the estimate grew by more than 5% (a server that drops the beginning of a
  story that grows), or when its count is far under the estimate and just
  under a round size or the size the server is set to load. The mark names the
  version it was read for (`version`), the AI (`model_id`) and its model then
  (`model`); it holds until another version is written whole, or that version is
  rewritten by hand. `meta.cut`, why each version was cut at its ceiling, names
  the AI that wrote it (`model_id`).
- **A refusal for a prompt too long** (`learning.is_too_long`: its words, or the
  `code` and `type` its error body keeps, `ProviderError.said`) teaches the size
  and the count it names (in its words, or llama.cpp's `n_ctx` and
  `n_prompt_tokens`), else a wider `fit_margin`, and the turn asks once more,
  only when the prompt rebuilt with that is shorter: otherwise nothing is learned
  and the server's refusal is told. A wider margin is kept only when the second
  ask was answered. A refusal whose prompt is under the limit while the reply's
  room leaves no story its place (`learning.reply_takes_the_room`) is not a
  story too long.
- **`CallFigures`** (`providers/base.py`) is what each provider hands back of its
  call: the server's usage, the id of the generation, the model and upstream that
  answered, the stop reason, the characters received, and whether the request
  was sent and a stream opened. It stays readable after a stop or an error.
  `Answer.figures` carries it out of `complete_answer`. What spending is counted
  from is read from these without opening the providers again; `on_id` is where
  its recorder hooks in.
- **What an update must not change** is held by three things, run before every
  commit that touches the engine, a provider or a service that builds a request,
  from `backend/`:

  ```bash
  .venv/Scripts/python tests/cases_kept.py <commit before the ways>
  .venv/Scripts/python -m pytest -q tests/test_requests_before.py tests/test_requests_3_7.py \
    tests/test_my_ais_api.py::test_an_update_sends_each_model_the_request_it_sent_before
  ```

  `cases_kept.py` says that no recorded case of that commit changed its input or
  its expected output. `test_requests_3_7.py` replays the requests 3.7.0 sent
  (`fixtures/requests_3_7.json`, recorded on the code of 3.7.0, never by hand) and
  allows two exceptions only, each removed by name and checked on its own:
  `stream_options: {"include_usage": true}` in an OpenAI-compatible body, and the
  wider margin of an AI that has measured nothing.

## Recorded cases

`backend/tests/cases/` holds cases `{fn, name, input, expected}` for the whole
prompt engine: the chat prompt and its parts, the other prompts, the reading of a
model's answer, the memory pass, the card draft and the default prompts, and the
ways of playing (`ways.json`: a way as stored and as a conversation adjusts it,
the room each gives the facts, the lorebook and past passages, a conversation's
outlook in the server's tokens, and what a prompt keeps for the reply, through
`reply_reserve`, the reserve of `ai_call.ceiling`). `input`
is the named arguments of the function and `expected` is what the Python code
answered when the case was written. A change that moves one on purpose is
regenerated from `backend/`:

```bash
.venv/Scripts/python -m tests.test_recorded_cases
```

Read the diff, since it is the change in behaviour. Never edit an `expected` by
hand, and never remove a case that fails.

Two suites read the same files. `backend/tests/test_recorded_cases.py` runs each
case against Python, which is the reference. `frontend/src/engine/cases.test.ts`
runs it against the engine's TypeScript copy in `frontend/src/engine/`, through
`index.ts`, its only door, and fails when a recorded function has no adapter or
a function of `index.ts` is reached by none. So a rule changed in Python and not
in TypeScript fails `npm test` once the cases are regenerated. Nothing in the
interface calls that copy yet, so it is not in the build.

The two engines owe each other the same answer on typed input, and on anything a
model answers. Typed input is what the server stores: the header of
`frontend/src/engine/chat.ts` says what a type cannot (whole, finite numbers, well
formed strings, whole rows), and whatever feeds the TypeScript copy must keep it.
Some things cannot be the same between Python and JavaScript:

- a model's answer nested deeper than 900, which TypeScript refuses;
- an integer past 2^53, which a double rounds, and one in a model's answer past
  the largest double (about 1.8e308), which JavaScript reads as Infinity;
- the letters that only Unicode 16 cases, which Node knows and Python 3.13 does not;
- a text that grows past the longest string V8 accepts, such as a name repeated
  by thousands of `{{char}}`;
- a whole float such as `3.0` given as input, which `JSON.parse` hands back as an
  integer;
- an object key that reads as an integer, which JavaScript lists first.

## Cards kept whole

A character imported from a card keeps the card. `character_cards` holds the
file as it came (`text`, in `format` `png` or `json`), what the reader made of it
(`read`, as stored), and the PNG's second card when it held a different one
(`other_text`). It is a table of its own so that the list of characters stays
light, and `GET /api/characters/{id}/card` is the only way to it. An entry made
from the card carries its index there in `lore_entries.origin`. The export
(`frontend/src/lib/cards/export.ts`) writes over the kept card only what differs
from `read`, column by column and setting by setting. So a change to the rules of
reading never passes for an edit, and whatever Evermind does not read stays as
its author wrote it. `characters.card_rules` is 1 for a character made before
this, whose prompt stays what it was (the engine checks it with
`on_card_rules`), and 2 for the rules community cards are written for. A
character made before has no kept card: `reread.ts` finds it again in the
portrait, and `pairing.ts` says which entry of the card each entry now is, only
when the two still share their keys or their text and nothing puts the pairing
in doubt.

## Display, portrait copies and card excerpts

`evermind:display` (`frontend/src/lib/display.ts`) holds this device's text size, whether a
picture shows behind a conversation, and that picture's strength. It is read with the language,
before the first paint, so a first message is never drawn at the wrong size; a store shared by
the person's devices keeps one display per kind of screen (`:touch`, `:desk`). Under the text the
picture never weighs more than `UNDER_TEXT` (0.12, the same file): `plateAlpha` gives the opacity
of the page-coloured plate over each message, which the story sets as `--plate`, and the plate's
colour comes from `--page-rgb` in `styles.css`, the one value a light theme would change. A
portrait's smaller copies (`GRID_WIDTH` 480 and `BACKDROP_WIDTH` 960, `lib/portraitSizes.ts`) are
made by the browser and sent to `POST /api/characters/{id}/avatar/sizes` with the name of the
portrait they were made from: the server checks them and keeps them, and answers 409
`portrait_changed` when that portrait was replaced meanwhile. A new portrait has no copies until a
page sends some. The excerpt of a description (the card's text when it has no tagline) is written
twice, in `backend/app/services/card_text.py` and `frontend/src/engine/excerpt.ts`, and the
recorded cases in `backend/tests/cases/card_excerpt.json` hold both to the same answers. A change
to its rule raises `EXCERPT_RULE` in both files, to the same number: the stored excerpts are then
worked out again, with no migration.

## Optional semantic memory

Installing the `semantic` extra swaps recency-based recall for meaning-based
recall, on both established facts and old message passages:

```bash
cd backend && .venv/Scripts/python -m pip install -e ".[semantic]"
```

It pulls in `sentence-transformers` (a few GB with torch). The first start
downloads `intfloat/multilingual-e5-small` (about 470 MB) into the Hugging Face
cache, and every later one loads it from there without contacting huggingface.co,
offline included. In the image that cache is `/data/huggingface`
(`HF_HUB_CACHE`), in the data volume, so a new container finds the model. It
holds files there rather than links (`HF_HUB_DISABLE_SYMLINKS`), since
`docker compose cp` copies a link as a link, which Windows makes only for an
administrator or in Developer Mode: a backup would stop at the model. The model
is only ever loaded by a task at start, so no request can trigger a download.
Without the extra, `embed()` and `rank()` return `None` and vectors stay `NULL`:
recall falls back to recency, and nothing raises.

## Translations

The dictionaries are `frontend/src/i18n/locales/{en,fr,de,es}.json`. `en` is the
fallback, so it has to be complete, and the others carry exactly its keys:
`npm test` fails on a key missing or unknown, or on an empty value, which would
render as nothing at all rather than as an error. Interpolation placeholders
(`{count}`, `{name}`) and card macros (`{{char}}`, `{{user}}`) must survive
translation untouched.

A sentence given a number as `{count}` can have a form for each plural category
of its language, as `Intl.PluralRules` names them, under `<key>_one` and the like
(`chatList.messageCount_one`): every locale then carries that key, and the plain
one serves the other numbers. A number given to a sentence is written the
language's way, `54,1` in French. French puts a no-break space (U+00A0) before :
and inside « », and a narrow one (U+202F) before ; ! and ?; French, German and
Spanish put a no-break space between a number and %. `npm test` fails on a plain
space in those places.

## The mark

Evermind's mark, a half-mask whose one eye is an almond and whose other is a
four-pointed spark, is the application's own drawing. In the interface it is
`frontend/src/components/ui/Mark.tsx`, an inline SVG coloured by `currentColor`
and sized by its classes (`<Mark decorative className="h-7 w-7 text-ember-400" />`;
`decorative` hides it from a screen reader when the word Evermind is beside it).
The tab and home-screen icons are `frontend/public/favicon.svg` and
`apple-touch-icon.png`. It moves by CSS (`styles.css`, "The mark"): the
spark winks, a slow eyelid, when the pointer or the keyboard comes to
the link or button holding it (or an element marked `data-mark-host`); a mark
alone, like the login's, does not wink, since nothing happens by clicking it.
A wink always finishes, even when the pointer leaves half-way: the mark finds
its host and marks itself `data-wink` until the wink ends (`wink.ts`), so
nothing is wired where it is used. The spark's size is `SPARK` in `Mark.tsx`
(the favicon keeps a slightly fuller spark of its own). `busy` turns
it, for as long as Evermind waits on itself with a whole page or moment to show
for it: `<Mark busy />`, or `PageWait` for a page that has nothing yet. A
spinner stays the sign of a button at work, and a busy mark does not wink.

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

## The security policy

- `backend/app/headers.py` sets `Referrer-Policy`, `nosniff` and
  `X-DNS-Prefetch-Control: off` on every answer of the server, except the 500 of
  an error that nothing catches (a plain text).
- `X-DNS-Prefetch-Control: off` matters on a page served over `http`, which is
  what Evermind is on a home network. Without it, Firefox looks up the name of
  every link on the page in advance, with no tap. A link in a card would then
  tell its author when the card is read. `index.html` carries the same rule as a
  `meta` tag, for a page served without our headers.
- A page that calls a new address on another site (a `fetch`) needs that host
  added to `connect-src` in `headers.py`, in `https://` and in full, and to the
  string of `test_the_policy_is_the_one_written_down`. Never `https:` alone:
  `img-src https:` already lets a script that got through ask for an address of
  its choice, with its data in the address, and `connect-src https:` would let
  it also send a body and read any answer that CORS allows. Naming the hosts
  removes only those two things.
- `Referrer-Policy: same-origin`, not `no-referrer`: no address of the app goes
  to another site, and a write to Evermind keeps its `Origin`. Under
  `no-referrer`, the Fetch standard itself sends `Origin: null` for a write to
  the same site (a `fetch` to the same origin is not marked `cors`), and the
  gate (`gate.py`) refuses it.
- `backend/app/ui.py` sets the types of `.js`, `.mjs` and `.css` itself. Under
  `nosniff`, a script of another type is refused, and Python otherwise takes its
  types from the Windows registry.
- Vite's development server (port 3000) sets none of these headers. Only the two
  `meta` tags of `index.html` (`Referer`, names looked up in advance) hold
  there. A breach of the policy shows only with Evermind's own server (`python
  -m app`) or with the Playwright tests.
- The layout code of a presentation (`lib/presentation/renderPresentation.ts`)
  is loaded apart: import it only with `import()`, from `Presentation.tsx`. Its
  bounds live in `lib/presentation/bounds.ts`, which imports nothing, so that
  another page can read them.
- Any text of a card or a message goes through `layoutRefusal` (`bounds.ts`)
  before it is given to a Markdown parser. micromark takes a time that grows as
  the square of some runs of marks, and `layoutCost` counts them without
  parsing. A new place that lays out a text from elsewhere does the same, and
  uses `noDefinitions` and `boundDepth` (`lib/presentation/markdown.ts`). The
  shapes measured are in `lib/presentation/costliest.ts`, and a slow shape found
  later is added there.
- Raw HTML written in a text reaches `rehype-raw` only after `rawTagCost`
  (`renderPresentation.ts`), which counts what parse5 will rebuild, copy and
  compare before it reads it. A closing tag removes nothing there when a
  comment, another tag, an element with text content, a `<table>` or a table
  cell could hide it.

## Conventions

- Migrations are append-only; never edit one that has shipped.
- Components never call `fetch`. Every call to the server goes through `data` in
  `src/data/http/index.ts` (typed by the `DataSource` contract in
  `src/data/contract.ts`), with its error handling, and its address never starts
  with a slash ([why](#serving-under-a-path-prefix)).
- Repositories return plain dicts, which the routes answer with; there is no ORM,
  and Pydantic validates input only.
- Bytes columns (`embedding`) must never reach a JSON response. The `to_out`
  helpers strip them.
