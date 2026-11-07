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

## Behind a reverse proxy

A proxy that ends HTTPS passes requests on to Evermind over plain HTTP, so
Evermind only knows that a browser came over HTTPS, and from which address, if
the proxy says so in `X-Forwarded-Proto` and `X-Forwarded-For`. Anyone can send
those headers, so Evermind believes them only from the addresses listed in
`FORWARDED_ALLOW_IPS`. Set it, in `.env`, to the address the proxy connects from
(with Docker, the address the proxy reaches the container from, which starts each
request's line in `docker compose logs`). The session cookie is then marked
`Secure`, at sign-in and each time it is renewed, so the browser never sends it
over plain HTTP, and wrong passwords are counted for each device, or over IPv6
for each network, rather than for the proxy.
[docs/DEVELOPING.md](docs/DEVELOPING.md#serving-under-a-path-prefix) has an nginx
example.

Anything else that reaches Evermind from that address is believed just as much,
and can claim a new address for each guess. With a proxy on the same computer,
any program running there can do it, and so can a page open in its browser when
the browser reaches Evermind from the proxy's address: behind Docker Desktop,
where every connection to Evermind's port arrives from one address, or when the
address named is `127.0.0.1`, which the browser connects from. For that last
reason the nginx example has its proxy connect from `127.0.0.2`, the address to
name.

Turn on HSTS at the proxy as well (the `Strict-Transport-Security` header). A
browser that has been there once then never uses plain HTTP for that name again,
not for an address typed without `https://` nor for an old `http://` link.
Without it, that first plain request can be answered by someone on the network
instead of the proxy, with a page of their own that asks for the password.

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
