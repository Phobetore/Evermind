# Security policy

## Reporting something

Report privately, through
[GitHub's private advisory form](https://github.com/Phobetore/Evermind/security/advisories/new).
It reaches the maintainer without the report being public first. Please do not
open a normal issue for a vulnerability.

Tell me what you found, how to reproduce it, and what an attacker gets out of it.
A working proof of concept is welcome but not required.

Evermind is maintained by one person. Expect an acknowledgement within a week,
and a fix released as soon as it is written and tested rather than on a schedule
I would end up missing. You will be credited in the release notes unless you
would rather not be.

## Which versions get fixes

The newest release, and nothing else. Evermind is young enough that there is no
sensible long-term support story yet, and pretending otherwise would be worse
than saying so.

## What Evermind assumes about where it runs

These are design decisions rather than oversights, so a report about them will be
closed as working-as-intended:

- **The access password is not authentication.** It is one shared secret with no
  accounts, and over plain HTTP on a home network it travels in clear, so anyone
  who can watch that traffic can read the password and the session that follows
  it. It exists to keep the other people on your home Wi-Fi out of your
  conversations, and it is documented as a speed bump. How it works, and so what
  to expect from it, is described below.
- **Evermind is not built to face the open internet.** It binds to localhost by
  default for that reason. Putting it on a public address is a choice you make
  yourself, and doing so safely means a reverse proxy, TLS and real
  authentication in front of it.
- **API keys are stored so the application can use them.** They sit in the local
  database, readable by anyone who can already read the files on that machine.
  Anyone at that point has your conversations too.
- **The model is not sandboxed and is not trusted to be safe.** Evermind sends it
  your text and renders what comes back. You picked the model; its behaviour is
  between you and it.

## How the access password works

Each device types the password once and gets a session of its own, which lasts
until it is ended. **Sign out of this device** and **Sign out every device**, both
in Settings, end one session or all of them, and changing or removing the password
ends them all, for good: an old password set again later lets none of them back in.
A session never expires by itself: each opening of Evermind gives its cookie
another 400 days, so a device that is lost stays signed in until every device is
signed out or the password changes.

The database keeps of the password only a salted scrypt digest, slow to guess
from on purpose, by which Evermind finds out at start that the password has
changed; and of each session only an HMAC of its token keyed by the password. So
reading the database does not hand anyone a way in. The password is compared
after Unicode normalisation, so an accent typed on a phone keyboard is the same
password as the one in `.env` however each wrote it. Wrong guesses are limited to
10 per 15 minutes for each address, and over IPv6 for each /64 network, since one
device can take any address of its network.

That limit has a cost when devices share what it counts. Every device does when
they all reach Evermind from one address, as behind Docker Desktop, or behind a
reverse proxy that `FORWARDED_ALLOW_IPS` does not name (see below); and over
IPv6, every device of one network does, since a home network is a single /64.
Ten wrong passwords from anyone who can reach Evermind that way then lock all of
them out of signing in for 15 minutes, the right password included, and a new
burst of ten does it again as soon as those 15 minutes are over. Devices already
signed in go on working. Restarting Evermind lifts the lock at once.

## Requests from other sites

A website you visit can make your browser send requests to Evermind. This is
what stands in its way:

- **Changes from another origin are refused, password or not.** The browser
  names the page that sends a write in `Origin`, and Evermind refuses the write
  when that is not the address the request was sent to, its `Host`. A reverse
  proxy in front of Evermind must therefore pass the `Host` header through
  unchanged, or the interface's own changes are refused too. The scheme is not
  compared, so a proxy that ends HTTPS works.
- **Without a password, Evermind only answers to an address or `localhost`.** A
  website can point a name of its own at your computer once its page is loaded
  (DNS rebinding), and the browser then treats that page as Evermind itself,
  able to read and change everything. So the API only answers when it is reached
  by an address (`192.168.1.42`, `127.0.0.1`) or by `localhost`. To open it by a
  name, set a password.
- **With a password, the password protects the rest.** Any name is accepted, so
  a proxy can serve Evermind under its own, but the session cookie belongs to
  the name each device signed in on: a page under another name has none, and
  would need the password.
- **Pictures are served only under the names Evermind gives them**: 32
  hexadecimal characters, then `.png`, `.jpg` or `.webp`. Any other name is a
  `404` before a file is looked for. A page can make your browser ask a
  password-less Evermind for a picture, and a name that is a Windows network path
  (`\\host\share\x`) would otherwise make Evermind connect to that host and offer
  it your Windows account's credentials.

## Behind a reverse proxy

A proxy that ends HTTPS passes requests on to Evermind over plain HTTP, so
Evermind only knows that a browser came over HTTPS, and from which address, if
the proxy says so in `X-Forwarded-Proto` and `X-Forwarded-For`. Anyone can send
those headers, so Evermind believes them only from the addresses listed in
`FORWARDED_ALLOW_IPS`. Set it, in `.env`, to the address the proxy connects from,
as long as nothing else connects from it (see below). The session cookie is then
marked `Secure`, at sign-in and each time it is renewed, so the browser never
sends it over plain HTTP, and wrong passwords are counted for each device, or over
IPv6 for each network, rather than for the proxy.
[docs/DEVELOPING.md](docs/DEVELOPING.md#serving-under-a-path-prefix) has an nginx
example.

Anything else that reaches Evermind from that address is believed just as much,
and can claim a new address for each guess, so name only an address that nothing
but the proxy connects from. On the same computer that is not `127.0.0.1`, which
every program and browser there uses: the nginx example has its proxy connect
from `127.0.0.2` instead, an address no browser connects from, though a program
there could. With Docker, a proxy outside the container reaches it from the same
address as everything else on that computer; one in its own container on
Evermind's network can have a fixed address (`ipv4_address` in Compose), shown at
the start of each of its requests' lines in `docker compose logs`. Where the proxy
cannot have an address of its own, leave `FORWARDED_ALLOW_IPS` empty: both
headers are then ignored, every device shares the limit on wrong passwords, and
the cookie is not marked `Secure`, which HSTS below makes up for.

Turn on HSTS at the proxy as well (the `Strict-Transport-Security` header). A
browser that has been there once then never uses plain HTTP for that name again,
not for an address typed without `https://` nor for an old `http://` link.
Without it, that first plain request can be answered by someone on the network
instead of the proxy, with a page of their own that asks for the password.

## Slow and malformed requests

Before the password or any route, Evermind holds at most 16 KB of a request's
line and headers while it waits for the rest, and refuses the request (`400`)
past that. It closes a connection that leaves it waiting more than 20 seconds,
for the rest of a request's line and headers or for a body sent after its
answer; uploads and replies are not timed. A request whose body turns out
malformed once Evermind has started answering it, after the `401` of a locked
route for instance, has its connection closed at once.

## What a card's presentation may do

A card's presentation comes from elsewhere, and it is shown on the same origin as
the conversations and the API keys. Here is what stands in its way:

- **Only a list of allowed tags gets through**
  (`frontend/src/lib/presentation/schema.ts`): 39 tags of text, tables, pictures
  and links. No script, handler, form, frame or `<style>` block.
- **Inline styles are filtered property by property**
  (`frontend/src/lib/presentation/style.ts`). No position, transform, layer,
  animation or negative margin. Font sizes, line heights, opacity and the
  transparency of text colours are bounded, and opacity and transparency are
  counted together at any depth. A colour that inherits is counted with the one
  it inherits from. Side margins are counted together along nested boxes,
  with the indent of lists and quotes. The width left to the text is never under
  120 px, in `px` or in `%`. The top and bottom inner margin of an inline element
  is bounded to 4 px, so that it does not paint over the lines around it, whether
  the element is inline by itself or set to `display: inline`. Only colours that
  every browser reads are kept, so that the count is that of what is painted.
  A link that holds a picture asks before it opens, whatever its text.
- **Links** are `http`, `https` and `mailto` only, never a page of the app. A link
  whose text shows, anywhere, another site than its target asks before it opens.
  No link's name is looked up in advance (`X-DNS-Prefetch-Control: off`).
- **What is not caught**: text that is opaque in the colour of its background;
  a drawing that imitates a command of the app without showing an address. Such a
  drawing stays in the "From the author" frame, its links stay underlined, and a
  disclosure that the card dresses as a button keeps its triangle, in a badge in
  the app's colours that the card cannot change.
- **Pictures written in the card** show if their size in pixels fits in a phone's
  memory, one by one and all together. A picture from another site is requested
  only when the person taps, and without a `Referer`. Not checked: the size of a
  picture from another site, which can be read only by loading it. A huge picture
  shown on a tap, or many pictures shown together by "Show images", can use up the
  memory of a phone's tab. The browser then shows its error page, and the page has
  to be reloaded. The next visit does not ask for them again without a new tap.
- **A presentation, a greeting or a message too long**, or too loaded with marks
  to be parsed in time, is shown in full without layout, instead of freezing the
  page (`frontend/src/lib/presentation/bounds.ts`). A text written to break the
  layout is shown as it is. What stays slow: some megabytes of pictures written
  in a card's text, one to two seconds for 6 MB of pictures on a PC, several times
  more on a phone, at each visit of its page.
- **A second layer**: the security policy of the self-hosted edition
  (`backend/app/headers.py`).
- **In Anna's edition**, the allowed list and the filter are the same. Whether the
  second layer applies depends on what the platform lets Evermind set, which has
  not been established. Pictures from other sites do not show there.
- **Not done**: the "permissive" level, with `<style>` blocks in an isolated frame.

## What is worth reporting

- Anything that lets a request bypass the access password while it is set, or
  keep a session alive after it was ended or the password changed
- Anything that lets a page from another origin change something in Evermind,
  or read anything from it
- Anything that reads or writes data across conversations, personas or accounts
  that should not be reachable from where the request came from
- Injection of any kind that escapes its context: SQL, template, path traversal
  into the data directory, or a card that executes something when imported
- Anything in the published Docker image that runs with more privilege than it
  needs, or ships a credential
- Dependency vulnerabilities that are actually reachable from Evermind's code
  paths, rather than a scanner's raw output

That last one matters. A CVE in a transitive dependency that no code path
touches is noise, and I would rather spend the time on something real.
