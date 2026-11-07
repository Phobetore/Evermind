"""``python -m app``: start Evermind, the interface and the API on one port."""

import argparse
import os
import socket
import sys
from pathlib import Path

from . import config
from .services import update_check


def lan_address() -> str | None:
    """The address other devices reach this computer by. Connecting a UDP socket
    sends nothing; it only makes the system pick the route, and so the address."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("192.0.2.1", 9))
            return s.getsockname()[0]
    except OSError:
        return None


def port_taken(port: int) -> bool:
    # A connection, not a bind: Windows lets a bind succeed next to a listener
    # on the other side of the wildcard.
    with socket.socket() as s:
        s.settimeout(0.2)
        return s.connect_ex(("127.0.0.1", port)) == 0


def say(*lines: str) -> None:
    print(*lines, sep="\n", file=sys.stderr, flush=True)


def fail(*lines: str) -> int:
    say(*lines)
    return 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app", description=__doc__)
    parser.add_argument("--lan", action="store_true", help="listen on the local network")
    parser.add_argument("--dev", action="store_true", help="the API alone, for the Vite server")
    parser.add_argument("--check", action="store_true", help="print the port and exit")
    parser.add_argument("--no-env-file", action="store_true", help="do not read .env")
    args = parser.parse_args(argv)

    env_file = config.default_env_file()
    try:
        if not args.no_env_file:
            config.load_env_file(env_file)
    except (OSError, ValueError) as err:  # a UnicodeError is a ValueError
        return fail(f"Cannot read {env_file}: {err}")

    env = os.environ
    host = "127.0.0.1" if args.dev else "0.0.0.0" if args.lan else env.get("BIND") or "127.0.0.1"
    name, default = ("EVERMIND_BACKEND_PORT", "8000") if args.dev else ("PORT", "3000")
    raw = env.get(name) or default
    if not (raw.isascii() and raw.isdigit() and 1 <= int(raw) <= 65535):
        return fail(f"{name} must be a number from 1 to 65535, got {raw!r}.")
    port = int(raw)

    if port_taken(port):
        return fail(
            f"Port {port} is already in use.",
            f"If Evermind is still running, stop it. Otherwise put {name}=<a free port> in .env.",
        )
    if args.check:
        print(port, flush=True)
        return 0
    if not args.dev and not (config.ui_dir() / "index.html").is_file():
        return fail(
            f"The interface has not been built ({config.ui_dir()} has no index.html).",
            'Run scripts/prod.ps1 or scripts/prod.sh, or "npm run build" in frontend/.',
        )

    # In a container docker-compose.yml decides what is exposed: an address or a
    # warning printed from in here would be wrong.
    if update_check.install_kind() != "docker":
        local = host in ("127.0.0.1", "localhost", "::1")
        if not args.dev:
            shown = "localhost" if local or host in ("0.0.0.0", "::") else host
            print(f"Evermind -> http://{shown}:{port}", flush=True)
            if host == "0.0.0.0" and (lan := lan_address()):
                print(f"            http://{lan}:{port}  (from the local network)", flush=True)
            if not local and sys.platform == "win32":
                # Windows drops inbound connections that no rule allows.
                say(
                    "Other devices need this rule once, in an administrator PowerShell:",
                    f"  New-NetFirewallRule -DisplayName 'Evermind ({port})' -Direction Inbound "
                    f"-Protocol TCP -LocalPort {port} -Action Allow",
                )
        if (not local or (args.dev and args.lan)) and not config.gate_password():
            say(
                "No password is set, so anyone on this network can read your conversations.",
                "Put EVERMIND_GATE_PASSWORD in .env to be asked for one.",
            )

    import uvicorn

    uvicorn.run(
        "app.main:app", host=host, port=port, reload=args.dev,
        reload_dirs=[str(Path(__file__).resolve().parent)] if args.dev else None,
        # A page reading a reply holds its connection open; a model that has hung
        # must not hang the shutdown too.
        timeout_graceful_shutdown=5,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
