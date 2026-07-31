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

### The simple way: Docker

Docker is a free tool that runs applications in a tidy, self-contained box. You
install it once and never think about it again.

1. Download and install **Docker Desktop** from
   [docker.com](https://www.docker.com/products/docker-desktop/). Start it and
   let it finish loading (its icon stops animating).
2. Download Evermind: on the project page on GitHub, click the green **Code**
   button, then **Download ZIP**. Unzip it somewhere sensible, such as your
   Documents folder.
3. Open the unzipped folder. Find the file named `.env.example` and make a copy
   of it named exactly `.env` (same folder, no other change needed for now).
4. Open a terminal **in that folder**:
   - **Windows**: click the address bar at the top of the folder window, type
     `powershell`, press Enter.
   - **macOS**: right-click the folder, then Services, then New Terminal at Folder.
   - **Linux**: right-click inside the folder, then Open in Terminal.
5. Type this and press Enter:

   ```bash
   docker compose up -d
   ```

   It downloads two ready-made images, which takes under a minute on a normal
   connection. Later starts take seconds.
6. Open your browser at **http://localhost:3000**

Evermind is running. It will keep running in the background, and restart with
your computer, until you stop it with `docker compose down`.

> **One thing to remember with Docker.** Your AI is running on your computer, but
> Evermind is running inside its box, and inside that box "localhost" means the
> box itself. So in Step 3, wherever this guide says `localhost`, type
> `host.docker.internal` instead. For LM Studio that means
> `http://host.docker.internal:1234/v1`.

### The other way: run it directly

If you would rather not use Docker, you can run Evermind straight from the code.
You need two free tools installed first: **Python 3.11 or newer**
([python.org](https://www.python.org/downloads/)) and **Node.js 20 or newer**
([nodejs.org](https://nodejs.org)).

Then, from the Evermind folder:

```bash
# Windows
scripts\prod.ps1

# macOS and Linux
./scripts/prod.sh
```

The first run installs what it needs and takes a few minutes. Then open
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

**Play from your phone or tablet.** Start Evermind with `scripts\prod.ps1 -Lan`
(or `./scripts/prod.sh --lan`) and it will print an address to open on your other
device, on the same Wi-Fi. A password page protects it; set the password with
`EVERMIND_GATE_PASSWORD` in your `.env` file. Leave it empty to turn the password
off entirely. This is meant for your home network, not the open internet.

**Sharper long-term memory.** By default, Evermind recalls the most recent facts.
It can instead recall facts and old passages *by meaning*, so the right memory
comes back even three hundred messages later. With Docker, set `SEMANTIC=true` in
your `.env` and run `docker compose up -d --build` again. The `--build` matters
here: the ready-made images are the light ones, so this option only takes effect
when you compile locally. It adds a couple of gigabytes and downloads a small
language model once.

**Cards from elsewhere.** Evermind reads and writes the standard Character Card
V2 format, the JSON and PNG files used across the roleplay community. Thousands
of existing cards work; use **Import** on the Discover page.

---

## If something goes wrong

| What you see | What it usually means |
|---|---|
| "Cannot reach http://localhost:1234/v1" | Your AI is not running. Go back to LM Studio and check the server is started. On Docker, check you used `host.docker.internal` instead of `localhost`. |
| "No LLM connection configured" | Step 3 has not been done, or the connection was not saved. |
| Replies are cut off mid-sentence | The **Max response (tokens)** value on your connection is too low. Raise it. |
| The character forgets things, or repeats itself | Your **Context (tokens)** is probably set higher than your AI really offers. Match it to the real value. Also try lowering **Recent messages sent to the model** in Settings to 16 or 24. |
| Replies are very slow | Normal for a large model on a modest machine. Try a smaller one, or an online service. |
| Your phone cannot reach it | Both devices must be on the same Wi-Fi, and on Windows the firewall must allow the port. The launch script tells you the exact command if the rule is missing. |
| The page asks for a password you never set | The default is `ouistiti`. Change it, or switch it off, with `EVERMIND_GATE_PASSWORD` in your `.env`. |

**Want to try Evermind before setting up a real AI?** Run
`python scripts/mock_llm.py`, then add a connection of type OpenAI-compatible
pointing at `http://localhost:5599/v1`. It replies with placeholder roleplay text,
which is enough to check that everything is wired up correctly.

---

## Where your things are kept

Everything you create, including characters, conversations, personas and API
keys, stays on your own machine, in the `data` folder next to the app (or in a Docker volume if
you used Docker). Nothing is sent anywhere except to the AI service you chose
yourself. If you run the AI locally too, nothing leaves your computer at all.

To back it up, copy that folder. To start fresh, delete it.
