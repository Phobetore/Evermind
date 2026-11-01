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

Each device types the password once and gets a session of its own, which lasts 30
days after that device's last visit. **Sign out of this device** and **Sign out
every device**, both in Settings, end one session or all of them, and changing or
removing the password ends them all.

The password is kept as a salted scrypt digest, and only a SHA-256 of each
session token is stored, so reading the database does not hand anyone a way in.
It is compared after Unicode normalisation, so an accent typed on a phone
keyboard is the same password as the one in `.env` however each wrote it.
Wrong guesses are limited to 10 per 15 minutes for each address. Behind Docker
the requests usually all reach Evermind from Docker's own address, so that limit
is shared by every device: ten wrong guesses from one of them keep the others
out too, for up to 15 minutes.

## Requests from other sites

A website you visit can make your browser send requests to Evermind. This is
what stands in its way:

- **Changes from another origin are refused, password or not.** A write to the
  API, or a websocket, that the browser says comes from a page of another origin
  is turned away. The browser says so in `Sec-Fetch-Site` over HTTPS and on
  localhost, and otherwise only in `Origin`, which Evermind compares with the
  address the request was sent to. A reverse proxy in front of Evermind must
  therefore pass the `Host` header through unchanged, which works with every
  browser. Serving it over HTTPS is the second safety net, since browsers then
  send `Sec-Fetch-Site`, though Safari before 16.4 sends no Fetch Metadata even
  over HTTPS. A proxy that does neither gets the interface's own changes refused
  too.
- **Without a password, Evermind only answers to names it knows.** A website can
  point a name of its own at your computer once its page is loaded (DNS
  rebinding), and the browser then treats that page as Evermind itself, able to
  read and change everything. So the API only answers when it is reached by an
  address, `localhost` (or a name ending in `.localhost`), this computer's own
  name (also with `.local` after it, and its first label alone when the name has
  a domain, `nas` for `nas.home.lan`), or a name listed in
  `EVERMIND_ALLOWED_HOSTS`. A container cannot see the computer's own name, so
  with Docker it has to be listed too.
- **With a password, the password protects the rest.** Any name is accepted, so
  a proxy can serve Evermind under its own, but the session cookie belongs to
  the name each device signed in on: a page under another name has none, and
  would need the password.

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
