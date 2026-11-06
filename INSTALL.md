# Installing Evermind

This guide is written for people who are not developers. You do not need to know
how to code. Take about twenty minutes, follow the steps in order, and at the end
you will have Evermind running on your own computer.

If you get stuck, jump to [If something goes wrong](#if-something-goes-wrong) at
the bottom.

---

## First, the one thing to understand

Evermind is the **app**: the characters, the conversations, the memory, the
interface. It does not come with an AI inside it.

You choose the AI separately, and Evermind talks to it. That is the whole point
of the project: nobody else decides which model you use or what it will and will
not write for you.

So the installation has two halves:

1. **Get an AI running** (Step 1)
2. **Get Evermind running** (Step 2)

Then you introduce them to each other (Step 3).

---

## Step 1: get an AI

You have two options. Pick one.

### Option A: run the AI on your own computer

This is free, completely private, works offline, and nothing you write ever
leaves your machine. It asks more of your hardware.

#### Which model to pick

Two things decide the quality of your stories, and they are independent of each
other: **how big** the model is, and **how willing** it is.

**Size, or how well it writes.** The number before the B is billions of parameters.

| Your computer has | Look for | What to expect |
|---|---|---|
| 8 GB of RAM | 7B or 8B | Keeps up, plain prose, loses the finer nuance |
| 16 GB of RAM | 12B to 15B | The sweet spot: distinct voices, decent pacing |
| 32 GB of RAM | 22B to 24B | Subtext, longer arcs, characters that hold a line |
| 48 GB or a large GPU | 32B to 70B+ | About the best you can run at home |

A dedicated graphics card makes everything much faster, but is not required.

You will also see letters like Q4_K_M or Q6_K in the file names. That is
compression: lower numbers are smaller and faster but a little duller. Q4_K_M
is the usual good trade; take Q5 or Q6 if you have room to spare.

**Willingness, or whether it follows you.** This is the choice that decides what
your characters will and will not write. Evermind filters nothing, but a model
can refuse on its own.

| Kind | What to look for | How it behaves |
|---|---|---|
| Roleplay finetunes | Cydonia, Rocinante, Magnum, Stheno, Behemoth | Built for storytelling. Follow your lead, stay in character, no lectures |
| Uncensored variants | anything tagged *abliterated*, *uncensored*, *unaligned* | A general model with its refusal reflex surgically removed |
| Standard instruct models | Llama, Mistral, Qwen, Gemma, ending in *Instruct* | Fine for gentle stories; break character and moralise on darker turns |
| Hosted APIs | Claude, GPT, Gemini | The best prose available, and the provider's rules travel with it |

**Concrete starting points**

| If you have | Try | Why |
|---|---|---|
| 8 GB | **Stheno 8B** or **Lunaris 8B** (Sao10K) | The reliable classics of the small tier |
| 16 GB | **Rocinante 12B** (TheDrummer) | Warm, quick, very hard to make refuse anything |
| 16 GB | **Mistral Nemo Instruct 12B** | If you want something more neutral and restrained |
| 32 GB | **Cydonia 22B or 24B** (TheDrummer) | A common default for narration at this size |
| 32 GB | **Magnum v4 22B** (anthracite) | Trained towards a more literary prose |
| 48 GB and up | **Behemoth 123B** (TheDrummer) | If your machine can genuinely take it |
| Any machine | **OpenRouter** | Rent the large uncensored community models by the token |

That last row matters if your computer is modest: OpenRouter also serves
community finetunes, so you can rent a 70B storytelling model for a few cents an
evening instead of running a small one locally.

> Model names move quickly and this list will age. The creators above
> (TheDrummer, Sao10K, anthracite) publish new versions regularly, so searching
> their name directly in LM Studio is a dependable shortcut. For what is current,
> the monthly recommendation threads on r/SillyTavernAI are the usual reference.

**How to run it, with LM Studio (the friendliest option):**

1. Download **LM Studio** from [lmstudio.ai](https://lmstudio.ai) and install it
   like any normal app.
2. Open it, use the search tab, and download one of the models above, or search a
   creator's name and take whatever is newest.
3. Click download and wait. Models are large files, usually 4 to 20 GB.
4. Go to the **Developer** tab (in older versions it is called **Local Server**),
   select your downloaded model, and click **Start Server**.
5. LM Studio will show you an address. It is almost always:

   ```
   http://localhost:1234/v1
   ```

   Write it down. You need it in Step 3.

Leave LM Studio running in the background whenever you want to play.

> Ollama, llama.cpp and KoboldCpp work just as well if you already use one of
> them. Evermind has a one-click preset for each.

### Option B: use an online AI service

This works on any computer, however modest, and needs no downloads. It costs a
small amount of money per conversation, and the service you pick has its own
rules about what its models will write.

Using **OpenRouter** as the example:

1. Create an account at [openrouter.ai](https://openrouter.ai).
2. Add a small amount of credit.
3. Create an **API key** and copy it somewhere safe. It looks like a long
   password and you will not be shown it twice.
4. The address you will need in Step 3 is:

   ```
   https://openrouter.ai/api/v1
   ```

Which model to ask for there follows the same two axes as above. The big names
from the labs (Claude, GPT, Gemini) write beautifully and arrive with their
provider's rules attached. OpenRouter also carries the same community
storytelling finetunes you would otherwise run at home, in sizes no home machine
can hold. That is the practical way to get good prose and a free hand at the same
time without buying hardware. Evermind shows you the full list once the connection is
tested, so you can try several and keep the one you like.

---

## Step 2: get Evermind running

Two ways. The first asks less of you.

Coming from Evermind 2.x? Read [docs/UPGRADING.md](docs/UPGRADING.md) instead of
this step. It takes a few minutes and keeps everything you have written.

### The simple way: Docker

Docker is a free tool that runs applications in a tidy, self-contained box. You
install it once and never think about it again.

You do not need the source code for this. Evermind is published as a ready-made
image, and one small file tells Docker how to fetch it.

1. Download and install **Docker Desktop** from
   [docker.com](https://www.docker.com/products/docker-desktop/). Start it and
   let it finish loading (its icon stops animating).
2. Make an empty folder for Evermind somewhere sensible, such as
   `Documents\Evermind`. One file is going to live in it.
3. Download
   **[docker-compose.yml](https://github.com/Phobetore/Evermind/releases/latest/download/docker-compose.yml)**
   and move it into that folder. That is the whole download: about two kilobytes,
   saying which image Docker should fetch and how to run it.
4. Open a terminal **in that folder**:
   - **Windows**: click the address bar at the top of the folder window, type
     `powershell`, press Enter.
   - **macOS**: right-click the folder, then Services, then New Terminal at Folder.
   - **Linux**: right-click inside the folder, then Open in Terminal.
5. Type this and press Enter:

   ```bash
   docker compose up -d
   ```

   It downloads the ready-made image, which takes under a minute on a normal
   connection. Later starts take seconds.
6. Open your browser at **http://localhost:3000**

There is nothing to configure first and no password to get past. Evermind
listens on this computer only, so nothing else on your network can reach it
until you decide otherwise.

If you would rather type than click, steps 2 and 3 are one line:

```bash
mkdir evermind; cd evermind; curl -LO https://github.com/Phobetore/Evermind/releases/latest/download/docker-compose.yml
```

On Windows use `curl.exe`, spelled out with the extension. Plain `curl` in
PowerShell is a different command wearing the same name, and it will not do what
you want here.

Evermind is running. It will keep running in the background, and restart with
your computer, until you stop it with `docker compose down`.

> **One thing to remember with Docker.** Your AI is running on your computer, but
> Evermind is running inside its box, and inside that box "localhost" means the
> box itself. So in Step 3, wherever this guide says `localhost`, type
> `host.docker.internal` instead. For LM Studio that means
> `http://host.docker.internal:1234/v1`.

### The other way: run it directly

If you would rather not use Docker, you can run Evermind straight from the code.
This is the one route that needs the source: on the project page on GitHub, click
the green **Code** button, then **Download ZIP**, and unzip it somewhere sensible.

You also need two free tools installed: **Python 3.11 or newer**
([python.org](https://www.python.org/downloads/)) and **Node.js 22.12 or newer**
([nodejs.org](https://nodejs.org)). Node is only used to build the interface;
Evermind itself runs on Python alone.

> **On Debian or Ubuntu**, Python's virtual-environment module is a separate
> package: `sudo apt install python3-venv` (or the package for your Python
> version, such as `python3.12-venv`). The Node.js in the distribution's own
> packages is often older than 22.12, so get a current one from nodejs.org or
> with a version manager.

Then, from the Evermind folder:

```bash
# Windows
scripts\prod.ps1

# macOS and Linux
./scripts/prod.sh
```

The first run installs what it needs and takes a few minutes, and so does the
first run after an update that changes any of it. Then open
**http://localhost:3000**.

Use `scripts\prod.ps1 -SkipBuild` (or `./scripts/prod.sh --skip-build`) for a
faster start when you have not changed anything.

---

## Step 3: introduce Evermind to your AI

In Evermind, go to **Settings**, then **LLM connections**, then **Add**.

1. Click the preset that matches what you set up in Step 1 (LM Studio, Ollama,
   OpenRouter, and so on). The address fills itself in.
2. If you used Docker, change `localhost` in that address to
   `host.docker.internal`.
3. If you chose an online service, paste your API key. For a local model, leave
   the key empty.
4. Click **Test connection**. If it works, the list of available models appears
   just below. Click the one you want.
5. Set **Context (tokens)** to match what your AI actually offers. LM Studio
   shows this when you load a model; 16384 is a common, comfortable value. This
   one matters: set it too high and your conversations get cut off without
   warning.
6. Save.

---

## Step 4: your first story

1. Go to **Discover**.
2. Click **Library**. Six ready-to-play cards come with Evermind: four characters
   and two scenarios.
3. Install one that appeals to you, then click **Start**.

That is it. Write in the box at the bottom and press Enter. Put *actions between
asterisks* and they appear in italics.

Two things worth knowing early:

- **The panel on the right is the memory.** Evermind writes down the important
  facts of your story by itself as you play. You can read them, correct them,
  pin the ones that must never be dropped, or add your own. Nothing is hidden
  from you.
- **Settings, then General roleplay instructions** is where you set your own
  rules: language, length, tone, what you do and do not want. Evermind imposes
  nothing; whatever you write there applies to every conversation.

---

## Optional extras

**Play from your phone or tablet.** Evermind stays on your computer by default,
so this takes two deliberate changes. Next to your `docker-compose.yml`, make a
file named exactly `.env` containing these two lines:

```
BIND=0.0.0.0
EVERMIND_GATE_PASSWORD=something-only-you-know
```

(That `.env` is where every setting lives. Write values as they are, without
quotes. For the full annotated list, download
[env.example](https://github.com/Phobetore/Evermind/releases/latest/download/env.example)
and rename it to `.env`.)

Run `docker compose up -d` again, and open your computer's local address on the
other device, on the same Wi-Fi. It looks like `http://192.168.1.42:3000`;
`ipconfig` on Windows, `ipconfig getifaddr en0` on macOS or `ip addr` on Linux
will tell you the number.
The password page appears first, once per device. After that the device stays
signed in for 30 days after its last visit, and **Settings** has a button to sign
it out, or every device at once.

Set the password. Without it, everyone on that Wi-Fi can read your
conversations. And keep this to your home network rather than the open internet:
it is one shared password over plain HTTP, which is a speed bump and not real
protection.

Running without Docker instead? `scripts\prod.ps1 -Lan` (or
`./scripts/prod.sh --lan`) does the same thing and prints the address for you.
Set `EVERMIND_GATE_PASSWORD` in your `.env` there too, in the Evermind folder.

**Using a different port.** Evermind answers on port 3000, interface and API
together. If something on your computer already has it, make a file named `.env`
(from the source, copy `.env.example`; with Docker, rename the
[env.example](https://github.com/Phobetore/Evermind/releases/latest/download/env.example)
you can download) and change it:

```
PORT=3001
```

Put the file next to your `docker-compose.yml`, or in the Evermind folder if you
run it from the source, and start Evermind again: with Docker, that is
`docker compose up -d` (`docker compose restart` keeps the port the container
started with). It works the same with Docker and with the launch scripts; under
Docker it is the port on your computer, and inside its box Evermind keeps its
own.

**Sharper long-term memory.** By default, Evermind recalls the most recent facts.
It can instead recall facts and old passages *by meaning*, so the right memory
comes back even three hundred messages later.

This is the one option the ready-made image cannot give you, because it would
add two or three gigabytes to a download everybody else pays for. So it means
building your own copy: get the source (green **Code** button, then **Download
ZIP**), put `SEMANTIC=true` in your `.env`, and from the unzipped folder run
`docker compose up -d --build`. Expect a long first build, and a small language
model downloaded once on first start.

**Cards from elsewhere.** Evermind reads and writes the standard Character Card
V2 format, the JSON and PNG files used across the roleplay community. Thousands
of existing cards work; use **Import** on the Discover page.

---

## If something goes wrong

The interface shows its messages in the language you chose, and they are quoted
here in English. The ones about ports are the exception: they come from the
program that starts Evermind, which always writes in English.

| What you see | What it usually means |
|---|---|
| "Evermind cannot reach the model's server at http://localhost:1234/v1" | Your AI is not running. Go back to LM Studio and check the server is started. On Docker, check you used `host.docker.internal` instead of `localhost`. |
| "No LLM connection is set up" | Step 3 has not been done, or the connection was not saved. |
| Replies are cut off mid-sentence | The **Max response (tokens)** value on your connection is too low. Raise it. |
| The character forgets things, or repeats itself | Your **Context (tokens)** is probably set higher than your AI really offers. Match it to the real value. Also try lowering **Recent messages sent to the model** in Settings to 16 or 24. |
| Replies are very slow | Normal for a large model on a modest machine. Try a smaller one, or an online service. |
| "The model returned nothing, twice" | That model's chat template will not work for roleplay here, whatever you write. Nothing you can configure fixes it; pick another model. |
| `docker compose` complains about `env_file` | Your Docker is older than November 2024. Update it; on Debian or Ubuntu, install Docker from Docker's own packages rather than the distribution's. |
| "Port 3000 is already in use", or Docker says the port is already allocated | Something else on your computer already uses that port, and often it is Evermind itself, still running. Stop it first. Otherwise set `PORT` to a free one, `3001` for instance, in your `.env` (see **Using a different port** under Optional extras). |
| "Port 80 needs administrator rights" | Your system keeps that port for itself: Linux and macOS reserve the ones below 1024, and Windows holds back a few others. Set `PORT` to a number above 1024, `3001` for instance, in your `.env` (see **Using a different port** under Optional extras). |
| Your phone cannot reach it | On Docker, check `BIND=0.0.0.0` is in your `.env` and that you ran `docker compose up -d` again afterwards; the default keeps Evermind on your computer alone. Both devices must be on the same Wi-Fi, and on Windows the firewall must allow the port. The launch script tells you the exact command if the rule is missing. |
| "Evermind does not answer to this address" | You opened Evermind by a name it does not know, and no password is set. Open it by its address (`http://192.168.1.42:3000`), by `localhost` (or a name ending in `.localhost`) or by the computer's own name, also with `.local` after it (when the name has a domain, as in `nas.home.lan`, its first part works too, `nas` and `nas.local`). Or list the name in `EVERMIND_ALLOWED_HOSTS` in your `.env`, separated by commas if there are several. Setting a password works too: with one, any name is accepted. With Docker, the computer's own name has to be listed as well, because the container cannot see it. With Docker, after changing `.env`, run `docker compose up -d` again (`docker compose restart` keeps the settings the container started with); otherwise start Evermind again. |
| "Evermind refused this request because it seems to come from another address" | Evermind turns away changes that a page from another website sends. If you reach it through a reverse proxy, the proxy has to pass the browser's original `Host` header on unchanged, which always works. Serving it over HTTPS helps too, but Safari before 16.4 sends no Fetch Metadata even then. [docs/DEVELOPING.md](docs/DEVELOPING.md#serving-under-a-path-prefix) has an example. |
| A password page appears | Only happens once you set `EVERMIND_GATE_PASSWORD` in your `.env`. Each device is asked once, then stays signed in for 30 days after its last visit. Clear that line and start Evermind again to remove the page (with Docker, `docker compose up -d`). |
| You changed the password and every device asks for it again | That is on purpose: changing or removing the password signs every device out. |

---

## Where your things are kept

Everything you create, including characters, conversations, personas and API
keys, stays on your own machine, in the `data` folder next to the app (or in a Docker volume if
you used Docker). Nothing you write is sent anywhere except to the AI service you
chose yourself. If you run the AI locally too, nothing you write leaves your
computer at all.

One thing does go out. Once a day Evermind asks GitHub whether a newer release
exists, so that you hear about fixes without having to go and look. It is a
plain request for the latest release number, and nothing about you, your machine
or what you have installed travels with it. The checkbox under **About** in
Settings turns it off, and with it off nothing goes out on its own. The button
beside it still asks when you press it, which is the only time anything is sent
once the checkbox is clear.

To back it up, copy that folder. To start fresh, delete it.

**Going back after an update.** When an update changes the database, Evermind
first copies it beside the original as `evermind.before-NNN.db`. To return to
the earlier state: stop Evermind, install the previous version again, copy that
file over `evermind.db` in the data folder, and delete `evermind.db-wal` and
`evermind.db-shm` there if they exist. With Docker the data is in a volume: put
the version you came from in your `.env` (such as `EVERMIND_VERSION=3.0.1`), stop Evermind
with `docker compose down`, then run this, with `NNN` as in the file name:

```bash
docker compose run --rm --no-deps --entrypoint sh evermind -c 'cd /data && cp evermind.before-NNN.db evermind.db && rm -f evermind.db-wal evermind.db-shm'
```
