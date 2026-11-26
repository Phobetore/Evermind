# Upgrading Evermind

One section per release that asks for more than a restart. Your characters,
conversations, memory and settings are kept every time: an upgrade replaces the
program, and your data lives somewhere of its own (the `data` folder, or the
`evermind-data` volume under Docker).

If you are installing for the first time, you want [INSTALL.md](../INSTALL.md)
instead. Coming from further back, read every section from your version up.

## From 3.7.x to 3.8.0

This update asks for a restart and a reload of your pages. The database changes
when Evermind starts, and a copy of it is kept first, as
`evermind.before-3.8.0.db` in the data folder. Read this to know what changes.

- **Reload Evermind on every device that had it open**, a phone above all.
- **To go back to the previous release, put back `evermind.before-3.8.0.db`**,
  as [Going back after an update](../INSTALL.md#going-back-after-an-update)
  says. What you did since the update is lost. See "Going back" below for the
  other way.
- **Your conversations play as before.** Your three settings of today ("Reply
  length", "Recent messages sent to the model" and "Passage recall") become a
  way to play. It is **Balanced** if you never touched them (the figures are the
  same), and **My settings** otherwise, which keeps your exact values. Each
  existing conversation plays it, and it is offered to the new ones. Each AI is
  sent the same request as before, but for three things (see "Three things
  change without your choosing them" below).
- **The way to play is chosen apart from the AI**, under the typing area, next
  to the name of the AI: one tap for the list of ways, one tap to choose. The
  choice holds for that conversation only, and it can be adjusted for that
  conversation alone. Changing the way offered to new conversations does not
  touch the ones that exist.
- **Four ways to play**: Light, Balanced, Immersive and Maximum. You can
  change them (in Settings, **Ways to play**), go back to their original values,
  and make copies of your own. The ceilings of 200 messages reread and of 4,000
  tokens of old passages are gone: the only limit is the model's.
- **Evermind says what the AI reads.** At the top of the list of ways, in the
  conversation, and under **What the AI reads** on a way's page in Settings:
  the pages sent, the messages reread, and when the AI's reading capacity is
  full. The small context bar in
  the header of a conversation, on a computer, is gone, and so is its speed in
  tokens per second; the speed test stays on the AI's page.
- **Under a reply cut short**, its reason and the button that mends it: the AI's
  ceiling ("Let Evermind set it"), the room of its length ("Long replies here"),
  or its thinking ("Try again"). An AI that read only the end of the story (Ollama
  and LM Studio cut a story that is too long without saying so) is now noticed,
  with "Shrink and try again". A server that refuses a story that is too long
  teaches Evermind its limit, and Evermind shrinks it and asks once more by
  itself.
- **Estimates "per 100 messages"** show where you choose an AI or a way to play:
  My AIs, an AI's page, the list to add one, the ways to play, and the two lists
  of a conversation. Never under the typing area.
- **An AI that is sent no reply ceiling** keeps 1,024 tokens for its reply,
  whatever the way, as before. Under a way with long replies, a notice offers
  "Keep the room long replies need".
- **Three things change without your choosing them: Evermind counts better.**
  It asks the server how many tokens it counted (one field more in each request
  to an OpenAI-compatible server, `stream_options`; a server that refuses it is
  asked again without) and trusts the answer: once an AI has answered, what
  Evermind sends it is measured the way its server counts, no longer by
  Evermind's own estimate. On a story that already fills what the AI reads,
  more or fewer messages are then reread than before: fewer when the server
  counts more tokens than Evermind estimated (the story was then longer than
  the AI could read), more when it counts fewer. Until it has measured an AI,
  Evermind keeps a wider margin under what the AI reads: 6% of it, 3% once
  measured, and never under the 200 tokens it was before. And for an AI that
  reasons, the room kept for its thinking is no longer always 3,072 tokens:
  once a reply has measured its thinking, it is twice what that took on
  average, and never under 1,024 tokens. On Anthropic, which must be sent a
  ceiling, the ceiling sent follows it. The facts and the lorebook of a
  community card, which take a share of what is left, follow.
- **Going back.** Besides putting the copy back, the previous release also
  starts on the migrated database. It finds your three old settings as they were
  the day of the update, and knows nothing of the ways to play. **Coming back to
  this release** replays nothing: the ways are there. A conversation started
  meanwhile in the previous release plays Balanced here, whatever your settings
  were then. What you changed there in the three old settings is not carried
  back either: the ways keep the values they had.
- **A page open before the update** must be reloaded. Meanwhile it cannot save
  the three old settings (it says "reload this page"), and its conversations
  answer as usual.
- **For a script that calls the API**: `GET /api/settings` no longer carries
  `reply_length`, `history_limit` or `passage_budget`, and writing them answers
  `410` (`page_outdated`). The ways are read and written under `/api/ways`. A
  conversation carries `play_style` and `play_overrides`. The body of a request
  to an OpenAI-compatible server carries `stream_options`.

## From 3.6.x to 3.7.0

This update asks for a restart and a reload of your pages. The database changes
when Evermind starts, and a copy of it is kept first, as
`evermind.before-3.7.0.db` in the data folder. Read this to know what changes.

- **Reload Evermind on every device that had it open**, a phone above all.
- **To go back to the previous release, put back `evermind.before-3.7.0.db`**,
  as [Going back after an update](../INSTALL.md#going-back-after-an-update)
  says. What you did since the update is lost. See "Going back" below for the
  other way.
- **None of your settings moves.** Each connection becomes an AI, with its name,
  its model, its reading capacity (the old "Context") and its reply ceiling (the
  old "Max response") as they were. Each AI is sent exactly the request it was
  sent before, for replies, the pen, automatic memory and the card assistant,
  and Evermind keeps the same room for it.
  **One thing changes without your choosing it.** An AI whose name would be its
  service's chip name, or another AI's name (a connection called "OpenRouter",
  as the old form suggested), takes the name of its model ("aurore-large"), so
  that two AIs are not mistaken for each other. A name you chose ("Living-room
  PC") stays as it is. If it meets a name taken from a model, the model's one
  gets "(2)". In a rare case, a name so numbered can meet a name you chose that
  already ends in the same number ("brume (2)"): two AIs then show the same
  name, and the AI's page renames either.
- **Two connections on the same server with the same key become one service.**
  The key is kept once, and changing it changes it for all its AIs. Known
  services take their chip's name ("OpenRouter", "LM Studio"...). Two keys on one
  server make "OpenRouter" and "OpenRouter (2)". Two connections are joined only
  when their API type is the same and their address (a final "/" apart) and
  their key are written exactly the same. One server written two ways (with
  capital letters, or as `localhost` and as `127.0.0.1`) gives two services,
  each with its key and its AIs, and nothing is lost.
- **Your conversations keep their AI**, including those that named none: they
  are fixed on the one that answered them. **This too changes without your
  choosing it**: they no longer follow a change of the default AI made later. A
  new conversation takes the default AI of the moment it is created. When an AI
  is removed, its conversations are fixed on the default AI of that moment, and
  say so once.
- **Evermind now reads what each server says**: the whole list of its models
  (not only the first 8), how much each reads at once, the longest reply it can
  write, its price and whether it thinks before it writes. It reads this when
  you add an AI, after each AI's first reply every time Evermind starts, then at
  most once a day, and when you open the AI's page. Reading changes no setting.
  When a number you typed long ago works against you, "My AIs" says so, with a
  button ("Follow the server", "Let Evermind set it") and "Keep everything as it
  is".
- **An AI that thinks** is recognised the first time it thinks. This is kept,
  and counts for its ceiling when that ceiling is "Set by Evermind". The AIs
  brought over keep their value. Under a reply cut short by a ceiling you set by
  hand, a button, "Let Evermind set it", lifts it for that AI. A service that
  refuses for lack of credit (OpenRouter then counts on the longest reply the
  model can write) says so, and offers to top up or to give the AI a ceiling.
- **The AIs you add after the update** have a reply ceiling "Set by Evermind":
  the room your "Reply length" asks for (512, 1,024 or 2,048 tokens), and no
  ceiling for an AI that thinks. Their reading capacity is "Follow the server".
  Evermind never keeps for the reply more than half of what the AI reads at
  once: on a local server that does not say the size it loads, the card and the
  story keep their room.
- **Under the typing area**, the help sentence gives way to the name of the AI
  that answers: one tap for the list (each AI with its price), one tap to
  choose. With a keyboard, the shortcuts sentence stays at its right. "Draft
  restored" and the pen's error show just above the area for a few seconds; the
  advice of a pen that only thought stays under the area until the next try, as
  before. The choice of the model leaves the conversation's panel.
- **A reading capacity or a reply ceiling has no maximum any more.** A value
  above what the server announces is kept, with a sentence.
- **Going back.** Besides putting the copy back, the previous release also
  starts on the migrated database, for one release. It finds its connections
  with their figures of the day of the update, under their service's name. The
  AIs added since are not there (a service added there is a connection with no
  model), nor are merged connections (their conversations move to the default
  connection there), and conversations created since answer with its default
  connection. Its "Delete" on a connection that carries AIs shows a general
  error, and nothing is removed. **Coming back to this release** replays
  nothing. A connection created meanwhile is a service with no AI, its key kept
  ("Already connected · no AI in your list"), and recognised as OpenRouter,
  OpenAI and so on when its address is a chip's. A conversation created meanwhile
  follows the default AI. What the previous release changed on a connection's
  **model, context, ceiling or settings**, or on a **conversation's model**, is
  not seen here. What it changed on a **name, address, key or API type** is seen,
  and holds for all that service's AIs; an address changed there is read here as
  a new address, and its family with it.
- **A page open before the update** must be reloaded. Meanwhile the model choice
  in its panel looks empty (nothing was removed). Its list shows the services,
  and choosing one gives the conversation (or the assistant) an AI of that
  service: the one with the same id for a service brought over, else the
  service's default. It cannot create, save or delete a connection that carries
  AIs, nor measure the speed: each refusal says so ("reload this page"), and
  nothing is lost.
- **For a script that calls the API**: AIs live under `/api/models`, and a
  service (`/api/connections`) is now only a server's address, key and type.
  `POST /api/connections` answers `410` (`page_outdated`): a service is created
  with its AIs by `POST /api/models`. `PUT /api/connections/{id}` with the whole
  old body answers `422`: send only the service's own fields. `GET
  /api/connections` no longer carries `model`, `context_size` or `max_tokens`.
  Conversations carry `model_id` (`connection_id` stays only as an alias for a
  page from before).

## From 3.5.x to 3.6.0

This update asks for a restart and a reload of your pages. The database gains
new columns when Evermind starts, and a copy of it is kept first. Read this to
know what changes.

- **Reload Evermind on every device that had it open.**
- **Every conversation without a backdrop of its own shows the character's
  picture** behind the text, at 20 %, sharp. This is the only setting that
  changes without your choosing it. The "Aa" button or Settings, under
  "Display", turns it off for that device. The panel of a conversation
  ("No backdrop") turns it off for that conversation only.
- **Your existing backdrops stay.** Same picture, same strength. They gain a
  plate behind the messages. That is the only difference you will see.
- **The strength slider under a conversation** is now the "Aa" sheet, which also
  sets the size of the text.
- **The text size** is 100 % on each device until you change it. At 100 % the
  messages keep their size. A new "Aa" button sits in the header. On a computer,
  the back button (32 px before) and the panel button (36 px before) become
  44 px squares, as they already were on a touch screen. The portrait's button
  becomes 44 px too; the portrait inside it keeps 36 px. The input and the
  editor of a message go from 15.7 to 16 px. An empty
  input is one line again (about 44 px, not 88), grows with its text up to six
  lines, then scrolls. Its resize handle is gone. A very long word or an address
  wraps in a message. Changing the text size keeps the place you were reading.
  On a very narrow screen (under 320 px, as very large system text gives on
  Chrome for Android), the portrait in the header goes, and the short card opens
  from the panel. The input then takes its own line.
- **On a phone, the home page cards** are taller and show the description and
  all the tags. The computer's tile keeps its shape. A card without a tagline
  now shows the start of its description there too, as on a phone.
- **The home page loads faster.** The list of characters carries only what a
  card shows: about 1.8 MB compressed before, about 40 KB after, measured on 300
  characters the size of the community's. Only the pictures near the screen
  load (small, on a phone; the computer keeps its pictures whole). Search still
  finds every word of a description. Those words arrive a moment after the
  others.
- **A conversation loads less.** Its round portraits, and those of the list of
  conversations, read the small copy of the picture instead of the whole file.
  The card's page reads the larger copy.
- **The first time an older card shows**, its whole picture is loaded once (your
  browser usually has it already). Then your device makes two smaller copies and
  sends them, one card at a time, never while a reply is being written. Each
  portrait takes about 50 KB and 150 KB. This happens once for all your devices.
  The sending goes on when you leave the home page for a conversation, between
  two replies.
- **Nothing else changes**: not your characters, conversations or generation
  settings.
- **A page open before the update** must be reloaded. If it sets the strength of
  a backdrop, the new strength is the one that counts.

## From 3.4.x to 3.5.0

This update asks for a restart and a reload of your pages, nothing more. Read it
to know what changes.

- **Reload Evermind on every device that had it open**, a phone above all.
- **Evermind has a mark of its own**, a half mask, in the tab, in the sidebar
  and on the login page. A shortcut already on a phone's home screen may keep
  the old picture until you add it again.
- **The page of a card** starts with its author's presentation, laid out
  (headings, colours, tables, links, pictures written in the card), in the
  interface's language when the card offers several. Then comes the greeting in
  full, with its variants. Then, folded, "What the model reads". The description
  is no longer shown first, under "About". The `<style>` blocks, fixed
  positions, negative margins, animations and scripts of a card do not get
  through. A bare web address, a footnote (`[^1]`), a checkbox (`- [ ]`) and a
  reference link (`[text][r]`) stay as the text written.
  A heading longer than 120 characters, there or in "What the model reads", is
  shown as a paragraph, at the size of the text around it.
- **Pictures from other sites** are asked for only when you tap, and only for
  that visit, and the site is not told where the request comes from. Pictures
  over `http` never show. A link that holds a picture asks before it opens. A
  text too long to lay out (more than 100,000 characters) is shown plainly, and
  in parts past 200,000 characters. A picture written in the card that is too
  large for a phone's memory (more than 4,096 × 4,096 pixels, or more than 256
  MB decoded with the ones before it) is replaced by a placeholder that says so.
  A link whose text shows one site and leads to another asks first. If the
  layout code does not arrive, the presentation is shown without its layout,
  with a button to reload.
- **The summary opened from a conversation** shows the presentation in plain
  words. A card without a presentation keeps its description, shown as the model
  reads it, as the scene in the conversation's panel does.
- **The markers of a card read as words** wherever its tagline or its
  presentation is shown.
- **Every page is served with a content security policy**, plus
  `Referrer-Policy: same-origin`, `X-Content-Type-Options: nosniff` and
  `X-DNS-Prefetch-Control: off`, so that no link's name is looked up in advance.
  A proxy that sets its own policy: both apply. A browser extension that injects
  code into the page may be blocked. Evermind stays openable inside a frame of
  another page.
- **A message of more than 100,000 characters, or too loaded with marks to be
  read in time**, in a conversation, is shown without Markdown layout. That is
  the case of a huge greeting, or of one written to freeze the page: a few
  thousand `>`, `-` or brackets. Past 200,000 characters it is shown in parts.
  An ordinary message does not change: a paragraph of one line with 1,200
  actions between asterisks (31,000 characters) goes through, and so does a
  message of 400 paragraphs. In a message, `[r]: address` and `[text][r]` now
  read as written: the definition is no longer hidden. Nothing else changes in
  the conversation.
- **A very long tagline or tag** no longer widens the home page, the library or
  the form. The tagline is cut to its lines, a tag to the width of its chip, and
  its first 2,000 characters show on hover. The whole tag stays in the card and
  in its form.
- **Nothing changes in the data.** There is no migration. The presentation is
  kept as written; only how it is shown changes.

## From 3.3.x to 3.4.0

This update asks for a restart and a reload of your pages, nothing more. Read it
to know what changes.

- **Reload Evermind on every device that had it open**, a phone above all. A
  page left open from 3.3.x does not know the import report or the new settings
  of a card. It sends back what it read, so a character it saves loses nothing.
  An entry it adds takes the default settings. A character it creates or
  imports stays on the old rules, with no card kept. Its banner then offers to
  read the card again from the portrait.
- **The first start copies your database** to `evermind.before-3.4.0.db`, next
  to it, and then adds what the update needs. Nothing in it is removed.
- **To go back to 3.3.x, put that copy back**, as
  [Going back after an update](../INSTALL.md#going-back-after-an-update) says.
  Never start 3.3.x on the updated database: it starts without a word, but a
  character saved from it loses the settings of its entries and its entries that
  are always on, yet keeps its rules and its card: back on 3.4.0, its entries
  behave differently and its export leaves out the card's own.
- **Your characters give the same prompt as before, word for word.** Each one
  stays on the old rules (`card_rules` 1) until you accept, in its form, to read
  its card again or to move to the new rules. Its lorebook keeps its order: each
  entry gets an order equal to its place today.
- **A character you create or import from now on follows the new rules.**
  - A key of one word matches whole words: `ring` no longer fires on "bring".
  - Entries can call other entries.
  - The lorebook may use a quarter of the prompt, where it had 800 tokens. That
    is more once the prompt passes 3,200 tokens, and less below that.
  - Entries have an order and a place: before or after the character, or at a
    depth.
  - Example dialogue is cut on `<START>`, and kept block by block.
  - The card's own instructions replace the role reminder. The safeguards stay.
  - A character can have a nickname and a character note.
  - The lorebook looks at the last 6 messages, each under the name of who wrote
    it (SillyTavern looks at 2).
  - A character note and the entries set at a depth are placed at that depth
    inside one of your turns, marked as not written by you. Their role (system,
    you, character) is kept and exported, but not followed: Evermind never adds a
    message to the story.
  - Markers such as `{{roll}}` are replaced, and random choices are fixed for
    each conversation. This applies to what the card and the character write,
    not to what you write.
- **The starter library installed after the update follows the new rules.** Its
  six cards have examples cut on `<START>`, and the entries of "The Elmswood
  Vigil" come in the order the card gives them. A card already installed does
  not change.
- **A card is read more completely.** `ccv3` is read before `chara`, so a file
  you import again may give more than it did. Compressed blocks (`zTXt`,
  `iTXt`) are read, up to 60 MB of text, a limit of memory. A keyword in
  capitals, the flat Pygmalion shape and the `creatorcomment` of a V1 card are
  read. An entry that is always on, with no keyword, is kept. Duplicate tags are
  removed. A setting that is badly formed takes its default value and no longer
  stops the import. Evermind shows a report of what it read and asks two
  questions.
- **The card you imported is kept whole.** The file is stored with the
  character, with what Evermind read of it (and, for a PNG that holds two
  different cards, the second one). The database grows by about twice the size of
  the file for each such character. The list of characters does not get heavier.
- **Export starts from that card.** What Evermind does not know goes out
  unchanged, value for value: entries it never received too, each at its place.
  What you changed is written over it, and only that. A PNG holds `chara` and
  `ccv3`. When the portrait is a PNG, its image goes out as it is, with its other
  blocks, and is no longer reduced to 1,536 px. A V3 card goes out as V3 JSON.
  A V1 card goes out as V2, with the keys of its root. A character made in
  Evermind goes out with the settings of its entries and the V1 copies at its
  root. One imported from a PNG before the update, and not yet read again,
  is exported from the card in its portrait. Evermind warns you when a file it
  exports is past 15 MB, since it will not take it back (a PNG holds the card
  twice), and when the images joined to a V3 card are not in the file.
- **The form shows more.** A character on the new rules shows its nickname,
  character note, presentation by language, and the settings of each entry.
  One on the old rules shows a banner: read the card again and move to the new
  rules, or only keep the card for export. A field you emptied, an entry you
  deleted and an entry you changed are never undone.
- **A new conversation with a character on the new rules** has the markers of
  its greeting replaced once, when it is created, as `{{char}}` already was.

## From 3.0.x to 3.1.0

From 3.0.0 or 3.0.1, every step of
[the 3.0.2 section](#from-300-or-301-to-302) below applies too.

- **If you built the image yourself, for semantic memory, or run a downloaded
  ZIP, do not run the command that Settings shows in 3.0.x.** It would replace a
  built image with the published one, which has no semantic memory, and a ZIP's
  folder has nothing for its `git pull` to update: on Windows, the old version
  then starts again. Follow [Updating](../INSTALL.md#updating) instead; for an
  image, that also builds semantic memory back into one already replaced. From
  3.1.0 on, Settings links to those steps rather than showing a command.
- **With semantic memory in Docker, the first start downloads its model once
  more** (about 470 MB), into the data volume this time, under `huggingface`,
  where every later container finds it.
- **Reload Evermind on every device that had it open**, a phone above all. A page
  left open from 3.0.x goes on running until then and misreads some of the new
  answers: after a Regenerate that worked, it may say "The reply did not
  arrive.", and its **Retry** makes yet another version.
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
- **A conversation without a persona of its own keeps the one 3.0.x played it
  as**: one begun before you made a persona, begun with **No persona**, or
  played as a persona you deleted since. That is the persona ticked **Use by
  default in new conversations**, or your oldest if none was, and the
  conversation now shows it. Its first message may still say "User", or the name
  of the persona you deleted.
- **The memory follows the story back.** Removing messages takes it back to the
  last memory pass before them, and so does regenerating, continuing or swiping
  the last reply once the memory has read it; what you wrote, pinned or typed
  stays. A summary carried over from 3.0.x counts as one you typed: a cut keeps
  it, partly stale, until a memory pass writes the next one. After that, a cut
  back past where its memory had read before the update goes back to that
  summary when more than 40 turns are left; with fewer, the next pass reads them
  all and writes it again. A story you cut back under 3.0.x, behind what its
  memory had read, keeps its old summary and the model's facts from the removed
  turns (clear them in the side panel if they no longer fit); unless it has grown
  back that far since, its memory reads its last 40 turns again.
- **When you edit a card, lorebook changes wait for Save**, like the rest of the
  form, and **Cancel** drops them.
- **Lorebook entries match whatever the case, and follow the order the card lists
  them in.** Case-sensitive keys and priorities are gone, so an entry whose key
  is a common word, such as a sexton named Will, now also wakes on "will": check
  the cards you imported.
- **A long conversation shows its newest hundred messages.** **Show earlier
  messages** brings back a hundred more each time.
- **The check for a newer release goes from your browser**, each time Settings
  opens, rather than from Evermind once a day. GitHub sees what it sees of any
  browser that asks it something, the address you opened Evermind at included.
  The checkbox under **About** turns it off.
- **Pictures that are replaced or removed stay on disk**, in the `media` folder
  of your data, as those of a deleted card, persona or conversation already did.
- **A save waits for a busy database** for up to 30 seconds, where it used to
  fail after 5 with an error. Stopping Evermind waits for such a save too.
- **For a script that calls the API**:
  - Gone: `POST /api/characters/import` and `GET /api/characters/{id}/export`
    (cards are read and written in the browser now),
    `POST /api/library/{filename}/install`, the lorebook routes (a character's
    `lore_entries`, in its `GET`, `POST` or `PUT`, is its whole lorebook),
    `POST /api/conversations/{id}/summarize`, `POST /api/connections/{id}/test`
    and `/benchmark`, `GET /api/connections/{id}/models`, and `/docs`, `/redoc`
    and `/openapi.json`.
  - `POST /api/chat` answers in JSON once the message is saved.
    `GET /api/conversations/{id}/turn` no longer has `mode` or
    `ended_recently`: it gives the `message_id` and `text` of the reply being
    written, or, when there is none, an `outcome` that says how the last turn
    failed or added nothing (`kind`, `message`, `mode`), or is `null`.
    `.../turn/stream` sends the reply so far as `{"text": ...}`, each piece
    after it as `{"delta": ...}`, then `{"end": true}`, which is all it sends
    when no reply is being written. The reply is then read from the
    conversation, and the `outcome` from `.../turn`.
    `DELETE /api/messages/{id}` always removes the messages after it too.
    `POST /api/connections/test` and `/benchmark` take the connection as the
    form holds it, with `id` to use its saved key, and `PUT /api/connections/{id}`
    takes the whole connection.
  - `PATCH /api/messages/{id}` with `content` and `active_index` writes the
    words into that version and shows it, where it wrote them into the version
    shown before switching. `POST /api/conversations` and
    `POST /api/messages/{id}/branch` take a `client_id`: asked again under the
    same one, while Evermind runs, they answer with what the first made.
    `GET /api/conversations/{id}` says whether a memory pass is running
    (`memory_running`), and leaves the messages out with `messages=false`.
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
    repeats what was sent. A text holding half of an emoji (a lone surrogate,
    such as an unpaired `\ud83d` escape) is a `422` naming its field, wherever
    it sits in that field, the form sent to the card assistant (`existing`)
    included, where several routes answered `500`.
  - `GET /api/characters` takes no filter, and lorebook entries have no
    `case_sensitive` or `priority`. `POST /api/conversations` takes no
    `greeting_index`, its `PATCH` no `persona_id`, and the settings have no
    `default_persona_id` or `default_connection_id`. A conversation has no
    `forked_at_position`, and it and the state of its turn carry `revision`. A
    message's `meta.interrupted` lists its versions cut short instead of being
    `true`, `meta.unanswered` can hold how the model failed instead of `true`,
    and `meta.streaming` and `meta.finish_reason` are gone. A fact has no `kind`
    and gains `previous_content` and `corrected_at`; adding one the model
    already holds makes it yours (`201`, not `400` `fact_exists`), and so does
    changing its text, while a text left blank is `400` `fact_empty`.
    `avatar_url` and `wallpaper_url` are relative, `api/media/<file>`.
    `GET /api/library` gives each card whole, as `card`, beside `filename` and
    `has_avatar`, and `GET /api/connections` reports the oldest connection as
    `is_default` when none is marked. `GET /api/update` answers only `current`,
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

   One exception. If it has a line such as `EVERMIND_VERSION=2.1.6`, delete it,
   or set it to `latest`. The new image starts at 3.0.0 and has no 2.x versions
   to pin to, and a pin to a 3.x version would hold you there.

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

Until you replace the file, an old `docker-compose.yml` keeps running the 2.x
images your machine already holds. It can no longer fetch them: the two images
it names, `evermind-backend` and `evermind-frontend`, received no fix after
2.1.6 and were removed from the registry on 26 November 2026. `docker compose
pull`, and a start with `--pull always`, now fail on them; a plain
`docker compose up -d` still starts what is there. The steps above are what
switches it.

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
