# Upgrading Evermind

One section per release that asks for more than a restart. Your characters,
conversations, memory and settings are kept every time: an upgrade replaces the
program, and your data lives somewhere of its own (the `data` folder, or the
`evermind-data` volume under Docker).

If you are installing for the first time, you want [INSTALL.md](../INSTALL.md)
instead. Coming from further back, read every section from your version up.

## From 3.0.x to 3.1.0

From 3.0.0 or 3.0.1, the steps for 3.0.2 below apply too: with Docker, download
`docker-compose.yml` again; remove the quotes around values in `.env`; and from
the source, Python must use SQLite 3.35 or newer.

- **If you built the image yourself, for semantic memory, do not run the command
  that Settings shows in 3.0.x.** It would replace your image with the published
  one, which has no semantic memory. Bring the source up to date and run
  `docker compose up -d --build` from it instead, as
  [Updating](../INSTALL.md#updating) says; that also builds semantic memory back
  into an image already replaced. From 3.1.0 on, Settings links to those steps
  rather than showing the command.
- **Every device signs in once more**, if you set a password: the sessions kept
  by 3.0.x end with the update. A device then stays signed in until it is signed
  out in **Settings** or the password changes. There is no 30-day limit any more:
  a lost phone stays signed in until **Sign out every device**, or a new password.
- **Without a password, Evermind only answers to an address or `localhost`.**
  `EVERMIND_ALLOWED_HOSTS` is gone, and a line left in `.env` is ignored. Opened
  by any name, the computer's own and `.local` ones included, it says "Without a
  password, Evermind does not answer to this name". Open it by its address
  (`http://192.168.1.42:3000`), or set a password: with one, any name works.
- **Behind a reverse proxy, `FORWARDED_ALLOW_IPS` names the proxy to believe.**
  Evermind used to believe `X-Forwarded-For` and `X-Forwarded-Proto` from
  127.0.0.1, and now only from the addresses that new setting lists, none by
  default. Without it, the session cookie is never `Secure`, and every device
  behind the proxy shares one count of wrong passwords. The proxy must also pass
  `Host` on unchanged: HTTPS no longer makes up for a changed one.
  [DEVELOPING.md](DEVELOPING.md#serving-under-a-path-prefix) has an nginx example,
  and [SECURITY.md](../SECURITY.md#behind-a-reverse-proxy) says which address to
  name, or when to leave it empty. `EVERMIND_ROOT_PATH` is gone: a proxy that
  removes the path needs nothing more.
- **From the source, some ways of starting Evermind went.** `scripts/dev.sh` and
  `scripts/dev.ps1`: [DEVELOPING.md](DEVELOPING.md#running-it) has the two
  commands instead. `-SkipBuild` and `--skip-build`: run `python -m app` from
  `backend` with the environment's own Python. The `--host`, `--port`,
  `--data-dir`, `--env-file` and `--root-path` options of `python -m app`: put
  `BIND`, `PORT` or `EVERMIND_DATA_DIR` in `.env`. A `.env` saved as UTF-32, or
  as UTF-16 without a byte order mark, stops the start: save it as UTF-8. On
  Windows, a start on the network prints the firewall rule other devices need
  every time, rather than looking for it.
- **A few controls went, and what they did is done elsewhere.** **Summarize**,
  in the side panel: **Remember** writes the summary along with the facts. The
  **Default persona** and **Default connection** lists in Settings: tick **Use by
  default in new conversations** on a persona, or **Default connection** on a
  connection; what the lists named stays the default. **Retry** on a message that
  did not go: it stays in the box, and **Send** sends it. The choice of greeting
  when a conversation starts: the arrows on the first message go through them.
- **The memory follows the story back.** Removing messages takes it back to the
  last memory pass before them, and so does regenerating, continuing or swiping
  the last reply once the memory has read it; what you wrote, pinned or typed
  stays. A summary carried over from 3.0.x counts as one you typed: a cut keeps
  it, partly stale, until a memory pass writes the next one. A story you cut back
  under 3.0.x keeps its old summary and the model's facts from the removed turns
  (clear them in the side panel if they no longer fit), and its memory reads its
  last 40 turns again.
- **When you edit a card, lorebook changes wait for Save**, like the rest of the
  form, and **Cancel** drops them.
- **A long conversation shows its newest hundred messages.** **Show earlier
  messages** brings back a hundred more each time.
- **The check for a newer release goes from your browser**, each time Settings
  opens, rather than from Evermind once a day. GitHub sees what it sees of any
  browser that asks it something, the address you opened Evermind at included.
  The checkbox under **About** turns it off.
- **Pictures that are replaced or removed stay on disk**, in the `media` folder
  of your data, as those of a deleted card, persona or conversation already did.
- **For a script that calls the API**:
  - Gone: `POST /api/characters/import` and `GET /api/characters/{id}/export`
    (cards are read and written in the browser now),
    `POST /api/library/{filename}/install`, the lorebook routes (a character's
    `lore_entries`, in its `GET`, `POST` or `PUT`, is its whole lorebook),
    `POST /api/conversations/{id}/summarize`, `POST /api/connections/{id}/test`
    and `/benchmark`, `GET /api/connections/{id}/models`, and `/docs`, `/redoc`
    and `/openapi.json`.
  - `POST /api/chat` answers in JSON once the message is saved, and
    `GET /api/conversations/{id}/turn/stream` follows the reply.
    `DELETE /api/messages/{id}` always removes the messages after it too.
    `POST /api/connections/test` and `/benchmark` take the connection as the
    form holds it, with `id` to use its saved key, and `PUT /api/connections/{id}`
    takes the whole connection.
  - A model's failure is a `502` with `error` and `kind` only, `error` being what
    its server said, the address it could not reach, or how the connection
    broke. `model_http_error` is now `model_error`; `model_timeout` and
    `model_network_error` are `model_connection_lost`, or `unreachable` when no
    connection could be made; `model_unexpected_response` is `model_unreadable`;
    `model_empty_retried` is `model_empty`; and `model_unknown_type` is gone. The
    connection test and the benchmark fail that way too, instead of answering
    `200` with `"ok": false`.
  - A turn that cannot be had is refused by `POST /api/chat` with an error
    status before anything is saved, `400` `no_connection` among them. A memory
    pass that keeps nothing answers `409` (`memory_busy`, `too_few_facts`,
    `facts_changed` or `conversation_changed`) rather than `200` with `skipped`,
    and one without a connection `400` rather than `502`. A sign-in over 4096
    bytes, or without its length, is `413` `too_large`, and a `422` no longer
    repeats what was sent.
  - `GET /api/characters` takes no filter, and lorebook entries have no
    `case_sensitive` or `priority`. `POST /api/conversations` takes no
    `greeting_index`, its `PATCH` no `persona_id`, and the settings have no
    `default_persona_id` or `default_connection_id`. A conversation has no
    `forked_at_position`, and it and the state of its turn carry `revision`. A
    message's `meta.interrupted` lists its versions cut short instead of being
    `true`, `meta.streaming` is gone, and `meta.perf` has no `finish_reason`. A
    fact has no `kind` and gains `previous_content` and `corrected_at`; adding
    one the model already holds makes it yours (`201`, not `400` `fact_exists`),
    and so does changing its text. `GET /api/update` answers only `current`,
    `kind` and `command`.
- **A copy of the database is kept** as `evermind.before-3.1.0.db`, beside it.
  To go back to 3.0.x, see
  [Going back after an update](../INSTALL.md#going-back-after-an-update). An
  `evermind.before-3.0.2.db` from the update before is older still: the
  database from before 3.0.2.

## From 3.0.0 or 3.0.1 to 3.0.2

- **With Docker, download `docker-compose.yml` again before updating.** The
  upgrade command, `docker compose up -d --pull always`, does not replace it, and
  the old file can leave Evermind without a password. This matters most when the
  password holds `$` or ` #`. It needs Compose 2.30 or later.
- **Remove quotes around values in `.env`.** Values are read as written, so the
  quotes would now be part of the value.
- **With Docker, a password set in the shell or with `--env-file` no longer reaches
  the container.** Put it in the `.env` beside `docker-compose.yml`.
- **OpenAI and Anthropic connections leave temperature, top_p and the penalties to
  the model.** The first start empties those four settings on every connection to
  Anthropic and to api.openai.com, because the newest models refuse some of them.
  Max response (tokens) is emptied on the OpenAI ones too and kept on the
  Anthropic ones, but where it was under 4096 it becomes 4096, since Claude's
  thinking counts in it, and the Context (tokens) grows by the same difference so
  that the story keeps its room. You can set any of them again on the
  connection. Other connections are not touched.
- **A copy of the database is kept.** If the update changes the database, it is
  first copied beside the original as `evermind.before-3.0.2.db`. To go back, see
  [Going back after an update](../INSTALL.md#going-back-after-an-update).
- **From the source, Python must use SQLite 3.35 or newer.** The python.org ones
  do. If yours is older, Evermind says so at start and changes nothing.

## From 2.x to 3.0

Evermind used to be two programs, an interface and an API, each on a port of its
own. It is one now. The interface and the API answer together on a single port
(3000 unless you changed `PORT`), the Docker install is one container instead of
two, and the access password was rebuilt so that each device keeps its own
sign-in.

Nothing in your data is lost by this. The first start adds two small tables to
the database for the sign-in sessions and leaves everything else as it was. A
Docker install does need the steps below, though, because the file that
describes it has changed.

Follow the part that matches how you run Evermind, then read
[For everyone](#for-everyone).

### With Docker

1. Open a terminal in the folder that holds your `docker-compose.yml`, and stop
   Evermind:

   ```bash
   docker compose down
   ```

   Do this first, before you touch the file. Docker decides what to stop from
   the file in front of it, and the new one describes a single container. Replace
   it while the old Evermind is running and the old interface container is left
   holding port 3000, so the new one cannot start: "port is already allocated".
   Do not add `-v` to this command: that option deletes your data.

2. Download the new
   **[docker-compose.yml](https://github.com/Phobetore/Evermind/releases/latest/download/docker-compose.yml)**
   and put it over the old one, in the same folder. Keep your `.env` where it is:
   it works as it was.

   If you run Evermind from a copy of the project, because you build the image
   yourself, there is nothing to download: `git pull` brings the new file. Do
   it after the step above: pulling is what replaces the old file.

   One exception. If it has a line such as `EVERMIND_VERSION=2.1.6`, change it
   to `3.0.0`, or delete the line. The new image starts at 3.0.0 and has no 2.x
   versions to pin to.

3. Start it:

   ```bash
   docker compose up -d
   ```

   That downloads the new image, which takes under a minute, and Evermind comes
   back where it was: **http://localhost:3000**, or the port you set in `PORT`.

   If you built the image yourself (`SEMANTIC=true` in `.env`, started with
   `--build`), run `docker compose up -d --build` instead, in the copy of the
   project you have just updated, since it compiles the folder it is in. The
   plain command starts the published image, which has no semantic memory. The
   new file keeps the `SEMANTIC` build argument, so your `.env` still decides.

Your conversations are there at the first start. The new file mounts the same
`evermind-data` volume the old one used.

If you replaced the file before stopping the old one and ran into that "port is
already allocated" error, `docker compose up -d --remove-orphans` stops the
old interface container and starts the new one in one go.

Until you replace the file, nothing changes: an old `docker-compose.yml` keeps
running 2.1.6 (or the 2.x version your `.env` pins). `docker compose pull` does
not move it to 3.0, because the two images it names, `evermind-backend` and
`evermind-frontend`, are no longer updated. The steps above are what switches
it.

Once you have switched, nothing uses those two images any more. This gives the
disk space back:

```bash
docker image rm ghcr.io/phobetore/evermind-backend ghcr.io/phobetore/evermind-frontend
```

### From the source

This is for Evermind started with `scripts\prod.ps1` or `./scripts/prod.sh`.

1. Stop Evermind (Ctrl+C in the window it runs in).
2. Get the new version. If you cloned the project, that is `git pull`. If you
   downloaded a ZIP, unzip the new one and copy the `data` folder and your `.env`
   from the old folder into it.
3. Check your Node.js. Building the interface now needs **Node.js 22.12 or
   newer**, where 2.x was content with 20. `node --version` tells you which you
   have; [nodejs.org](https://nodejs.org) has the current one. Python is
   unchanged.
4. Run the script you always run, with `-Lan` (or `--lan`) if you play from other
   devices. It installs what changed and builds the new interface, so this first
   start takes a few minutes. Then open **http://localhost:3000**.

On Windows, if you start Evermind with the `.sh` scripts (from WSL or Git Bash)
in a copy you cloned, run this once after pulling:

```bash
git checkout -- scripts/*.sh
```

Git may have saved those files with Windows line endings, and bash then refuses
to run them (`env: 'bash\r': No such file or directory`). This release adds the
setting that keeps them as bash needs them, and the command writes them again
under it. The `.ps1` scripts and a ZIP download are not affected.

A `frontend/.next` folder left over from 2.x is harmless. Delete it if you like.

### For everyone

- **The password is asked once more on every device.** Only if you set one with
  `EVERMIND_GATE_PASSWORD`. Sign-ins are kept by the server now, one per device,
  so the ones from 2.x do not carry over. Each device types the password again
  and then stays signed in for 30 days after its last visit. **Settings** has
  **Sign out of this device** and **Sign out every device**, and changing or
  removing the password signs everyone out. An accent counts the same however it
  was typed, so an é from a phone keyboard matches the one saved in `.env` by
  another editor.
- **Without a password, Evermind only answers to names it knows.** A website
  could otherwise point a name of its own at your computer and read your
  conversations through your browser. Opened by an address
  (`http://192.168.1.42:3000`), by `localhost` (or a name ending in
  `.localhost`) or by the computer's own name, also with `.local` after it (when
  the name has a domain, as in `nas.home.lan`, its first part works too, `nas`
  and `nas.local`), nothing changes. Opened by any other name, an install
  without a password now says "Evermind does not answer to this address" (the
  API's own words are "Unknown host name"). List the name in
  `EVERMIND_ALLOWED_HOSTS` in your `.env`, separated by commas, or set a
  password: with one, any name works. With Docker, the computer's own name
  counts as unknown too, because the container cannot see it, so list it as
  well and run `docker compose up -d` again.
- **A reverse proxy has to keep the address the browser used.** Evermind now
  turns away the changes that a page of another origin sends. Behind a proxy
  that changes the `Host` header, the interface's own changes look like that
  too. Pass `Host` on unchanged, which always works
  ([DEVELOPING.md](DEVELOPING.md#serving-under-a-path-prefix) shows how).
  Serving it over HTTPS is the second safety net, but Safari before 16.4 sends
  no Fetch Metadata even over HTTPS.
- **Bookmarks still work.** The address is the same, and the old links such as
  `/chat/<id>` or `/settings` redirect to their new form (`/#/chat/<id>`), so
  the ones on your phone keep opening the right place.
- **There is one port, `PORT`.** From the source, the API used to listen on its
  own, on 8000. Anything of yours that called it there directly, a script for
  instance, now uses the same address as the interface.
  `EVERMIND_BACKEND_PORT` is only for development now (`python -m app --dev`), and
  `EVERMIND_BACKEND_URL` is not read at all any more. If either is in your
  `.env`, you can delete the line.
- **Your `.env` is read as written.** From the source, Evermind reads it itself
  now, the same file in the same place, wherever it is started from, and a value
  set in the environment still wins over the file. With Docker, the container
  gets the lines of the `.env` beside `docker-compose.yml`, and nothing else: a
  password set in the shell or with `--env-file` no longer reaches it, while
  `BIND` and `PORT` set there still apply. Keep the password in that `.env`.
  See [From 3.0.0 or 3.0.1 to 3.0.2](#from-300-or-301-to-302) for the quotes.
