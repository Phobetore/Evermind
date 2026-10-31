"""``python -m app``: start Evermind.

One entry point for every way of starting Evermind, so that the settings file,
the port and the warnings behave the same wherever it runs.
"""

import argparse
import errno
import ipaddress
import os
import socket
import sys
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from . import config
from .services import update_check

# What a bind reports when another program has the port. Windows answers with
# "access denied" instead of "in use" when the other program asked for exclusive
# use of it.
_PORT_TAKEN = {errno.EADDRINUSE, errno.EACCES, getattr(errno, "WSAEACCES", errno.EACCES)}

# For an address that covers every interface: where to look for a program
# already on the port.
_WILDCARD_LOOPBACK = {"0.0.0.0": "127.0.0.1", "::": "::1"}


@dataclass(frozen=True)
class Listen:
    host: str
    port: int
    dev: bool


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="python -m app",
        description="Start Evermind: the interface and the API on one port.",
    )
    parser.add_argument(
        "--lan", action="store_true", help="also listen on the local network (0.0.0.0)"
    )
    parser.add_argument(
        "--dev",
        action="store_true",
        help="serve the API alone, restarted on every change, for the Vite dev server to use",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="print the port that would be used and exit without starting anything",
    )
    parser.add_argument("--host", metavar="HOST", help="address to listen on")
    parser.add_argument("--port", metavar="N", help="port to listen on")
    parser.add_argument("--data-dir", metavar="DIR", help="where the database and media live")
    parser.add_argument("--env-file", metavar="PATH", help="settings file (default: .env)")
    parser.add_argument(
        "--no-env-file", action="store_true", help="do not read any settings file"
    )
    return parser.parse_args(argv)


def _port(name: str, raw: str) -> int:
    try:
        port = int(raw)
    except ValueError:
        raise ValueError(f"{name} must be a number, got {raw!r}") from None
    if not 1 <= port <= 65535:
        raise ValueError(f"{name} must be between 1 and 65535, got {raw!r}")
    return port


def resolve_listen(args: argparse.Namespace, env: Mapping[str, str]) -> Listen:
    """Work out where to listen. A value that is set but empty counts as unset,
    since ``PORT=`` is what a settings file looks like once its value is erased."""
    if args.host:
        host = args.host
    elif args.dev:
        # Vite is what the network sees in development; the API stays behind it.
        host = "127.0.0.1"
    elif args.lan:
        host = "0.0.0.0"
    else:
        host = env.get("BIND") or "127.0.0.1"

    if args.port is not None:
        port = _port("--port", args.port)
    elif args.dev:
        port = _port("EVERMIND_BACKEND_PORT", env.get("EVERMIND_BACKEND_PORT") or "8000")
    else:
        port = _port("PORT", env.get("PORT") or "3000")
    return Listen(host, port, args.dev)


def lan_address() -> str | None:
    """The address other devices on the network can reach this computer by.

    Connecting a UDP socket sends nothing; it only makes the system pick the
    route, and so the local address, it would use to reach that destination.
    192.0.2.1 is reserved for documentation, so nothing answers there. No route,
    no address.
    """
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("192.0.2.1", 9))
            return s.getsockname()[0]
    except OSError:
        return None


def port_in_use(host: str, port: int) -> bool:
    """Whether something already holds the port.

    The probe has to bind the way uvicorn will. On POSIX uvicorn sets
    SO_REUSEADDR, so a port that only has closed connections waiting out
    TIME_WAIT is free for it, and the probe sets the option too: without it a
    restart a few seconds after a stop would be told the port is busy. On Windows
    the option means something else, it lets a second socket bind to a port that
    is in active use, which is exactly the case to catch, so it stays off.

    Only the failures that mean "the port is taken" count. A host that is not an
    address of this computer, or a name that does not resolve, fails the bind too,
    and telling someone to pick another port for that would send them the wrong
    way; uvicorn reports those itself, with the real reason.
    """
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    try:
        with socket.socket(family, socket.SOCK_STREAM) as s:
            if os.name != "nt":
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind((host, port))
    except OSError as err:
        return err.errno in _PORT_TAKEN
    # Windows lets a bind succeed next to a listener on the other side of the
    # wildcard, in either direction: 127.0.0.1 or the network address while
    # another program holds 0.0.0.0, and 0.0.0.0 while another holds 127.0.0.1
    # alone. Both programs then run, the second one sharing the first one's data
    # folder or only being reached by part of the traffic. The bind cannot see
    # that; a connection can.
    return _has_listener(_WILDCARD_LOOPBACK.get(host, host), port)


def _has_listener(host: str, port: int) -> bool:
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    try:
        with socket.socket(family, socket.SOCK_STREAM) as s:
            # A listener accepts at once. Windows takes about two seconds to
            # refuse a closed loopback port, and there is no point waiting for it.
            s.settimeout(0.5)
            s.connect((host, port))
    except OSError:
        return False
    return True


def _is_loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        # A name that is not an address: it may resolve to anything, so assume
        # the network can reach it.
        return False


def _browse_host(host: str) -> str:
    """What to put in the address printed for a browser: localhost wherever
    that answers, and the address itself where it cannot. Bound to one address
    of the network, the computer refuses connections to localhost."""
    if host in _WILDCARD_LOOPBACK or _is_loopback(host):
        return "localhost"
    return f"[{host}]" if ":" in host else host


def _say(*lines: str, file=None) -> None:
    # Flushed because a script that reads the output through a pipe would
    # otherwise see nothing until the server stops.
    for line in lines:
        print(line, file=file, flush=True)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    if not args.no_env_file:
        # The default file is optional, since Evermind runs without one. A file
        # that was asked for by name is not: a typo there would otherwise start
        # the server without the settings the person meant to give it.
        env_file = Path(args.env_file) if args.env_file else config.default_env_file()
        if args.env_file and not env_file.exists():
            _say(f"The settings file {env_file} does not exist.", file=sys.stderr)
            return 1
        try:
            config.load_env_file(env_file)
        except UnicodeError:
            _say(
                f"Cannot read the settings file {env_file}: "
                "it is not valid UTF-8 or UTF-16 text.",
                file=sys.stderr,
            )
            return 1
        except OSError as err:
            _say(
                f"Cannot read the settings file {env_file}: {err.strerror or err}.",
                file=sys.stderr,
            )
            return 1
    if args.data_dir:
        # After the settings file, so the flag wins over a data directory set there.
        os.environ["EVERMIND_DATA_DIR"] = args.data_dir

    try:
        listen = resolve_listen(args, os.environ)
    except ValueError as err:
        _say(str(err), file=sys.stderr)
        return 1

    if port_in_use(listen.host, listen.port):
        _say(
            f"Port {listen.port} is already in use.",
            "If Evermind is still running, stop it and run this again. "
            "Otherwise put a free port in .env next to the scripts, for example PORT=3001.",
            file=sys.stderr,
        )
        return 1

    if args.check:
        _say(str(listen.port))
        return 0

    # In development the page comes from the Vite server, so there may be no build.
    if not listen.dev and not (config.ui_dir() / "index.html").is_file():
        _say(
            f"The interface has not been built ({config.ui_dir()} has no index.html).",
            'Run scripts/prod.ps1 or scripts/prod.sh, which build it, or "npm run build" '
            "in frontend/.",
            file=sys.stderr,
        )
        return 1

    # Inside a container docker-compose.yml decides what is exposed and where, so
    # an address printed from in here would be wrong and a warning beside the point.
    if update_check.install_kind() != "docker":
        if not listen.dev:
            _say(f"Evermind -> http://{_browse_host(listen.host)}:{listen.port}")
            if listen.host == "0.0.0.0" and (lan := lan_address()):
                _say(f"            http://{lan}:{listen.port}  (from the local network)")
        exposed = not _is_loopback(listen.host) or (listen.dev and args.lan)
        if exposed and not config.gate_password():
            _say(
                "No password is set, so anyone on this network can read your conversations.",
                "Put EVERMIND_GATE_PASSWORD in .env to be asked for one.",
                file=sys.stderr,
            )

    # Imported here so that --help, --check and the tests do not pay for it.
    import uvicorn

    options = {}
    if listen.dev:
        # The app folder only: the data folder is written to all the time and
        # would restart the server on every message.
        options["reload_dirs"] = [str(Path(__file__).resolve().parent)]
    uvicorn.run(
        "app.main:app", host=listen.host, port=listen.port, reload=listen.dev, **options
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
