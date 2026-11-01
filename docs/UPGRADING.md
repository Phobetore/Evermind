# Upgrading Evermind

One section per release that asks for more than a restart. Your characters,
conversations, memory and settings are kept every time: an upgrade replaces the
program, and your data lives somewhere of its own (the `data` folder, or the
`evermind-data` volume under Docker).

If you are installing for the first time, you want [INSTALL.md](../INSTALL.md)
instead.

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

The image `evermind-frontend` is no longer updated, and nothing uses it any more.
`docker image rm ghcr.io/phobetore/evermind-frontend` gives the disk space back.
The new image is also published as `evermind-backend`, which is the name the old
file pulls, but the old file does not work with it. Its interface container
reaches the API under the name `backend`, which the new image does not answer
to, so once a 2.x `docker-compose.yml` pulls it (`docker compose pull`, for
instance), the interface can no longer show your characters and conversations.
Nothing is lost: replacing the file as above brings them back.

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
  `.localhost`) or by the computer's own name, also with `.local` after it,
  nothing changes. Opened by any other name, an install without a password now
  says "Evermind does not answer to this address" (the API's own words are
  "Unknown host name"). List the name in `EVERMIND_ALLOWED_HOSTS` in your `.env`,
  separated by commas, or set a password: with one, any name works. With Docker,
  the computer's own name counts as unknown too, because the container cannot
  see it, so list it as well and run `docker compose up -d` again.
- **A reverse proxy has to keep the address the browser used.** Evermind now
  turns away the changes that a page of another origin sends. Behind a proxy
  that serves it over plain HTTP and changes the `Host` header, the interface's
  own changes look like that too. Serve it over HTTPS or pass `Host` on unchanged
  ([DEVELOPING.md](DEVELOPING.md#serving-under-a-path-prefix) shows how). If the
  proxy serves Evermind under a path such as `/evermind/`, also set
  `EVERMIND_ROOT_PATH=/evermind`, so that an old bookmark such as `/chat/<id>`
  lands on the right page.
- **Bookmarks still work.** The address is the same, and the old links such as
  `/chat/<id>` or `/settings` redirect to their new form (`/#/chat/<id>`), so
  the ones on your phone keep opening the right place.
- **There is one port, `PORT`.** From the source, the API used to listen on its
  own, on 8000. Anything of yours that called it there directly, a script for
  instance, now uses the same address as the interface.
  `EVERMIND_BACKEND_PORT` is only for development now (`scripts/dev`), and
  `EVERMIND_BACKEND_URL` is not read at all any more. If either is in your
  `.env`, you can delete the line.
- **Your `.env` keeps working.** From the source, Evermind reads it itself now,
  the same file in the same place, wherever it is started from; with Docker,
  `docker compose` reads it as before. A value set in the environment still wins
  over the file.
