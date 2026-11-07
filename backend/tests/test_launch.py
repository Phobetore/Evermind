"""The settings file and the ``python -m app`` command.

Nothing in here may read the developer's own ``.env`` or environment, or start a
real server: a stray PORT or EVERMIND_GATE_PASSWORD would change what a test
sees, and a server left running would hold a port for the rest of the run.
"""

import codecs
import errno
import os
import socket
import subprocess
import sys
from pathlib import Path

import pytest
import uvicorn

from app import __main__ as launch
from app import config
from app.config import gate_password, load_env_file

BACKEND_DIR = Path(__file__).resolve().parents[1]


@pytest.fixture()
def clean_env(tmp_path, monkeypatch):
    """No launch variable from the real environment, and a private copy of it,
    so that ``load_env_file`` and ``main`` cannot write into the real one. The
    default settings file is a file that does not exist, so that a test that
    forgets ``--no-env-file`` still cannot pick up the real ``.env``."""
    for name in list(os.environ):
        if name in ("PORT", "BIND", "FORWARDED_ALLOW_IPS") or name.startswith("EVERMIND_"):
            monkeypatch.delenv(name)
    monkeypatch.setattr(os, "environ", dict(os.environ))
    monkeypatch.setattr(config, "default_env_file", lambda: tmp_path / "no-such.env")


@pytest.fixture()
def ui_built(clean_env, tmp_path, monkeypatch):
    """A folder holding an index.html, standing in for the built interface."""
    folder = tmp_path / "ui"
    folder.mkdir()
    (folder / "index.html").write_text("<!doctype html>", encoding="utf-8")
    monkeypatch.setenv("EVERMIND_UI_DIR", str(folder))


@pytest.fixture(autouse=True)
def served(monkeypatch):
    """What ``main`` would have handed to uvicorn instead of serving: starting a
    real server from a test is always a mistake."""
    calls = []
    monkeypatch.setattr(uvicorn, "run", lambda app, **kwargs: calls.append((app, kwargs)))
    return calls


@pytest.fixture(autouse=True)
def outside_container(monkeypatch):
    """Whether the tests themselves run in Docker must not change their outcome."""
    monkeypatch.setattr(config, "install_kind", lambda: "clone")


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture()
def port():
    return free_port()


@pytest.fixture()
def busy_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        s.listen()
        yield s.getsockname()[1]


def start(monkeypatch, *argv, **env):
    """``main`` with a free PORT unless the test gives one; the exit status."""
    for name, value in {"PORT": str(free_port()), **env}.items():
        monkeypatch.setenv(name, value)
    return launch.main(["--no-env-file", *argv])


# --- the settings file -----------------------------------------------------


def test_the_default_env_file_sits_at_the_repository_root():
    assert Path(__file__).resolve().parents[2] / ".env" == config.default_env_file()


def test_the_file_fills_only_what_is_missing_or_empty(tmp_path, clean_env, monkeypatch):
    monkeypatch.setenv("PORT", "4000")
    monkeypatch.setenv("BIND", "")
    (tmp_path / ".env").write_text("PORT=3001\nBIND=0.0.0.0\nOTHER_KEY=1\n", encoding="utf-8")
    load_env_file(tmp_path / ".env")
    assert (os.environ["PORT"], os.environ["BIND"], os.environ["OTHER_KEY"]) == ("4000", "0.0.0.0", "1")


@pytest.mark.parametrize(("raw", "value"), [
    ("KEY=value", "value"),
    ("  KEY = value  ", "value"),
    ("export KEY=value", "value"),
    ("KEY=a=b", "a=b"),
    ("KEY=", ""),
    # Read as written: a password may hold quotes, "$" and "#".
    ('KEY="quoted"', '"quoted"'),
    ("KEY=abc #def", "abc #def"),
    ("KEY=ab$cd", "ab$cd"),
    ("﻿KEY=value\r\nOTHER=1\r\n", "value"),
])
def test_the_file_is_read_as_written(tmp_path, clean_env, raw, value):
    (tmp_path / ".env").write_text(raw, encoding="utf-8")
    load_env_file(tmp_path / ".env")
    assert os.environ["KEY"] == value


def test_comments_and_garbage_are_ignored(tmp_path, clean_env):
    (tmp_path / ".env").write_text("# A=1\nnot a setting\n1BAD=2\nGOOD=3\n", encoding="utf-8")
    load_env_file(tmp_path / ".env")
    assert [k for k in ("A", "1BAD", "GOOD") if k in os.environ] == ["GOOD"]


@pytest.mark.parametrize("bom", [codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE])
def test_utf16_with_a_byte_order_mark_reads_like_utf8(tmp_path, clean_env, bom):
    # What ">" and Out-File write in Windows PowerShell 5.1.
    codec = "utf-16-le" if bom == codecs.BOM_UTF16_LE else "utf-16-be"
    (tmp_path / ".env").write_bytes(bom + "KEY=é\r\n".encode(codec))
    load_env_file(tmp_path / ".env")
    assert os.environ["KEY"] == "é"


@pytest.mark.parametrize("data", [
    "A=1\n".encode("utf-16-le"),  # NULs and no mark: neither UTF-8 nor UTF-16 as far as we can tell
    "A=1\n".encode("utf-32"),
    b"A=\xff\xfe\n",
])
def test_a_file_that_is_not_text_raises_before_setting_anything(tmp_path, clean_env, data):
    (tmp_path / ".env").write_bytes(data)
    with pytest.raises(ValueError):  # UnicodeError is one
        load_env_file(tmp_path / ".env")
    assert "A" not in os.environ


def test_a_missing_file_is_fine(tmp_path, clean_env):
    load_env_file(tmp_path / "absent.env")


@pytest.mark.parametrize(("name", "setting", "default"), [
    ("ui_dir", "EVERMIND_UI_DIR", Path("frontend") / "dist"),
    ("data_dir", "EVERMIND_DATA_DIR", Path("data")),
    ("library_dir", "EVERMIND_LIBRARY_DIR", Path("library")),
])
def test_a_folder_can_be_moved_and_an_empty_setting_means_the_default(
    clean_env, tmp_path, monkeypatch, name, setting, default
):
    where = getattr(config, name)
    monkeypatch.setattr(config, "_REPO_ROOT", tmp_path)
    assert where() == tmp_path / default
    monkeypatch.setenv(setting, "")
    assert where() == tmp_path / default
    monkeypatch.setenv(setting, str(tmp_path / "elsewhere"))
    assert where() == tmp_path / "elsewhere"


def test_the_password_is_trimmed(clean_env, monkeypatch):
    assert gate_password() == ""
    monkeypatch.setenv("EVERMIND_GATE_PASSWORD", "  secret \n")
    assert gate_password() == "secret"


# --- the port --------------------------------------------------------------


def test_port_taken(busy_port):
    assert launch.port_taken(busy_port) is True
    assert launch.port_taken(free_port()) is False


class FakeSocket:
    def __init__(self, *args, error=None):
        self.error = error

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def connect(self, address):
        if self.error:
            raise self.error

    def getsockname(self):
        return ("192.168.1.20", 50000)


def test_the_network_address_comes_from_the_routing_table(monkeypatch):
    monkeypatch.setattr(socket, "socket", FakeSocket)
    assert launch.lan_address() == "192.168.1.20"


def test_there_is_no_network_address_without_a_route(monkeypatch):
    monkeypatch.setattr(socket, "socket", lambda *a: FakeSocket(error=OSError(errno.ENETUNREACH, "")))
    assert launch.lan_address() is None


def test_the_help_says_what_it_starts_in_plain_words(capsys):
    with pytest.raises(SystemExit):
        launch.main(["--help"])
    help_text = capsys.readouterr().out
    # argparse wraps it to the width of the terminal.
    assert "Start Evermind: the interface and the API on one port." in " ".join(help_text.split())
    assert "`" not in help_text


@pytest.mark.parametrize("raw", ["abc", "0", "70000", "-1", "3000.5"])
def test_a_port_that_is_not_one_is_reported(clean_env, monkeypatch, capsys, raw):
    monkeypatch.setenv("PORT", raw)
    assert launch.main(["--no-env-file", "--check"]) == 1
    assert capsys.readouterr().err.startswith("PORT must be a number from 1 to 65535")


def test_a_busy_port_stops_the_start_and_names_its_setting(clean_env, ui_built, monkeypatch, busy_port, served, capsys):
    assert start(monkeypatch, PORT=str(busy_port)) == 1
    assert f"Port {busy_port} is already in use." in capsys.readouterr().err
    assert served == []


def test_in_development_the_busy_port_is_the_apis(clean_env, monkeypatch, busy_port, capsys):
    assert start(monkeypatch, "--dev", EVERMIND_BACKEND_PORT=str(busy_port)) == 1
    assert "put EVERMIND_BACKEND_PORT=<a free port> in .env" in capsys.readouterr().err


def test_check_prints_the_port_and_starts_nothing(clean_env, monkeypatch, served, capsys, port):
    assert start(monkeypatch, "--check", PORT=str(port)) == 0
    assert capsys.readouterr().out == f"{port}\n"
    assert served == []


def test_check_in_development_prints_the_apis_port(clean_env, monkeypatch, capsys, port):
    assert start(monkeypatch, "--check", "--dev", EVERMIND_BACKEND_PORT=str(port)) == 0
    assert capsys.readouterr().out == f"{port}\n"


def test_check_still_fails_on_a_busy_port(clean_env, monkeypatch, busy_port):
    assert start(monkeypatch, "--check", PORT=str(busy_port)) == 1


def run_python(*argv: str, port: int) -> subprocess.CompletedProcess:
    """A process of its own, the way the scripts and the container start it: what
    they rely on is the exit status and the lines printed. The variables Evermind
    reads are left out of its environment, except the port."""
    env = {k: v for k, v in os.environ.items() if k not in ("PORT", "BIND") and not k.startswith("EVERMIND_")}
    return subprocess.run(
        [sys.executable, *argv], cwd=BACKEND_DIR, env={**env, "PORT": str(port)},
        capture_output=True, text=True, timeout=60, check=False,
    )


def test_the_entry_point_prints_the_port_and_exits_with_0(port):
    done = run_python("-m", "app", "--check", "--no-env-file", port=port)
    assert (done.returncode, done.stdout.strip(), done.stderr) == (0, str(port), "")


def test_the_entry_point_refuses_a_busy_port_and_exits_with_1(busy_port):
    done = run_python("-m", "app", "--check", "--no-env-file", port=busy_port)
    assert done.returncode == 1 and done.stdout == ""
    assert f"Port {busy_port} is already in use." in done.stderr


def test_check_builds_no_interface(port):
    # Importing the application creates the data folder and mounts the interface.
    done = run_python("-c", (
        "import sys; from app.__main__ import main; main(['--check', '--no-env-file']); "
        "print('app.main' in sys.modules)"
    ), port=port)
    assert done.stdout.split() == [str(port), "False"]


# --- starting ----------------------------------------------------------------


def test_it_refuses_to_start_without_the_built_interface(clean_env, tmp_path, monkeypatch, served, capsys):
    monkeypatch.setenv("EVERMIND_UI_DIR", str(tmp_path / "empty"))
    assert start(monkeypatch) == 1
    assert "The interface has not been built" in capsys.readouterr().err
    assert served == []


def test_it_starts_uvicorn_on_the_loopback_with_the_resolved_values(clean_env, ui_built, monkeypatch, served, capsys, port):
    assert start(monkeypatch, PORT=str(port)) == 0
    assert served == [("app.main:app", {
        "host": "127.0.0.1", "port": port, "reload": False, "reload_dirs": None,
        "timeout_graceful_shutdown": 5, "proxy_headers": False,
    })]
    captured = capsys.readouterr()
    assert (captured.out, captured.err) == (f"Evermind -> http://localhost:{port}\n", "")


def test_the_network_start_lists_the_address_other_devices_use(clean_env, ui_built, monkeypatch, served, capsys, port):
    monkeypatch.setenv("EVERMIND_GATE_PASSWORD", "secret")
    monkeypatch.setattr(launch, "lan_address", lambda: "192.168.1.20")
    assert start(monkeypatch, "--lan", PORT=str(port)) == 0
    assert served[0][1]["host"] == "0.0.0.0"
    assert capsys.readouterr().out == (
        f"Evermind -> http://localhost:{port}\n"
        f"            http://192.168.1.20:{port}  (from the local network)\n"
    )


@pytest.mark.parametrize(("bind", "shown"), [("192.168.1.42", "192.168.1.42"), ("::", "localhost"), ("::1", "localhost")])
def test_the_printed_address_is_one_that_answers(clean_env, ui_built, monkeypatch, capsys, bind, shown, port):
    monkeypatch.setenv("EVERMIND_GATE_PASSWORD", "secret")
    assert start(monkeypatch, BIND=bind, PORT=str(port)) == 0
    assert capsys.readouterr().out == f"Evermind -> http://{shown}:{port}\n"


@pytest.mark.parametrize(("bind", "warns"), [
    ("0.0.0.0", True), ("192.168.1.5", True), ("::", True),
    ("127.0.0.1", False), ("::1", False), ("localhost", False),
])
def test_the_password_warning_follows_the_host(clean_env, ui_built, monkeypatch, capsys, bind, warns):
    assert start(monkeypatch, BIND=bind) == 0
    assert ("anyone on this network can read your conversations" in capsys.readouterr().err) is warns


def test_a_password_silences_the_warning(clean_env, ui_built, monkeypatch, capsys):
    monkeypatch.setattr(sys, "platform", "linux")  # Windows adds its firewall line
    assert start(monkeypatch, "--lan", EVERMIND_GATE_PASSWORD="secret") == 0
    assert capsys.readouterr().err == ""


def test_development_serves_the_api_alone_with_reload(clean_env, monkeypatch, served, capsys, port):
    assert start(monkeypatch, "--dev", EVERMIND_BACKEND_PORT=str(port), PORT="9") == 0
    _, kwargs = served[0]
    assert (kwargs["host"], kwargs["port"], kwargs["reload"]) == ("127.0.0.1", port, True)
    assert kwargs["reload_dirs"] == [str(Path(launch.__file__).resolve().parent)]
    assert capsys.readouterr().out == ""  # no built interface needed, no address to give


def test_development_on_the_network_warns_without_a_password(clean_env, monkeypatch, capsys):
    assert start(monkeypatch, "--dev", "--lan") == 0
    assert "anyone on this network" in capsys.readouterr().err


@pytest.mark.parametrize(("platform", "bind", "prints"), [
    ("win32", "0.0.0.0", True), ("win32", "192.168.1.5", True),
    ("win32", "127.0.0.1", False), ("linux", "0.0.0.0", False),
])
def test_windows_gets_the_firewall_command_on_stderr_for_a_network_start(
    clean_env, ui_built, monkeypatch, capsys, platform, bind, prints, port
):
    monkeypatch.setattr(sys, "platform", platform)
    monkeypatch.setenv("EVERMIND_GATE_PASSWORD", "secret")
    assert start(monkeypatch, BIND=bind, PORT=str(port)) == 0
    err = capsys.readouterr().err
    rule = (f"New-NetFirewallRule -DisplayName 'Evermind ({port})' -Direction Inbound -Protocol TCP "
            f"-LocalPort {port} -Action Allow")
    assert (rule in err) is prints


@pytest.mark.parametrize("kind", ["docker", "built"])
def test_a_container_prints_no_addresses_and_no_warning(
    clean_env, ui_built, monkeypatch, capsys, kind
):
    # docker-compose.yml decides what is exposed; from inside, 0.0.0.0 is simply
    # how the published port reaches the process.
    monkeypatch.setattr(config, "install_kind", lambda: kind)
    monkeypatch.setattr(sys, "platform", "win32")
    assert start(monkeypatch, BIND="0.0.0.0") == 0
    captured = capsys.readouterr()
    assert (captured.out, captured.err) == ("", "")


# --- the settings file, through the command ------------------------------------


def test_the_file_decides_where_to_listen(clean_env, tmp_path, monkeypatch, capsys, port):
    env_file = tmp_path / "custom.env"
    env_file.write_text(f"PORT={port}\nEVERMIND_GATE_PASSWORD=from-file\n", encoding="utf-8")
    monkeypatch.setattr(config, "default_env_file", lambda: env_file)
    assert launch.main(["--check"]) == 0
    assert (capsys.readouterr().out, os.environ["EVERMIND_GATE_PASSWORD"]) == (f"{port}\n", "from-file")


def test_no_env_file_leaves_the_file_unread(clean_env, tmp_path, monkeypatch):
    env_file = tmp_path / "custom.env"
    env_file.write_text("EVERMIND_GATE_PASSWORD=from-file\n", encoding="utf-8")
    monkeypatch.setattr(config, "default_env_file", lambda: env_file)
    assert start(monkeypatch, "--check") == 0
    assert "EVERMIND_GATE_PASSWORD" not in os.environ


@pytest.mark.parametrize("make", [
    lambda p: p.write_bytes(b"A=\xff\xfe\n"),
    lambda p: p.mkdir(),  # a folder where a file is expected: an OSError
])
def test_a_file_that_cannot_be_read_names_it_and_exits(clean_env, tmp_path, monkeypatch, capsys, make):
    env_file = tmp_path / "custom.env"
    make(env_file)
    monkeypatch.setattr(config, "default_env_file", lambda: env_file)
    assert launch.main(["--check"]) == 1
    captured = capsys.readouterr()
    assert captured.out == "" and captured.err.startswith(f"Cannot read {env_file}: ")
