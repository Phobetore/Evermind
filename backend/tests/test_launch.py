"""The settings file and the ``python -m app`` command.

Nothing in here may read the developer's own ``.env`` or environment, or start a
real server: a stray PORT or EVERMIND_GATE_PASSWORD would change what a test
sees, and a server left running would hold a port for the rest of the run.
"""

import codecs
import errno
import os
import re
import socket
import subprocess
import sys
import types
from pathlib import Path

import pytest
import uvicorn

from app import __main__ as launch
from app import config
from app.__main__ import Listen, parse_args, resolve_listen
from app.config import gate_password, load_env_file, ui_dir
from app.services import update_check


@pytest.fixture()
def clean_env(tmp_path, monkeypatch):
    """No launch variable from the real environment, and a private copy of it.

    The copy is what stops ``load_env_file`` and ``main`` from writing into the
    real ``os.environ``: monkeypatch puts the original back afterwards. The
    default settings file is pointed at a file that does not exist, so a test
    that forgets ``--no-env-file`` still cannot pick up the real ``.env``.
    """
    for name in list(os.environ):
        if name in ("PORT", "BIND") or name.startswith("EVERMIND_"):
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
    return folder


@pytest.fixture(autouse=True)
def no_real_server(monkeypatch):
    """Starting uvicorn from a test is always a mistake, so make it loud."""

    def refuse(*args, **kwargs):
        raise AssertionError("a test tried to start a real server")

    monkeypatch.setattr(uvicorn, "run", refuse)


@pytest.fixture()
def served(monkeypatch):
    """Records what ``main`` would have handed to uvicorn instead of serving."""
    calls = []
    monkeypatch.setattr(uvicorn, "run", lambda app, **kwargs: calls.append((app, kwargs)))
    return calls


@pytest.fixture(autouse=True)
def outside_container(monkeypatch):
    """Whether the tests themselves run in Docker must not change their outcome."""
    monkeypatch.setattr(update_check, "install_kind", lambda: "source")


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def listen_host(*flags: str) -> str:
    """The host ``python -m app`` listens on for these flags, which is what it
    hands to ``port_in_use``. The tests that need every interface ask for it the
    way a person does, with ``--lan`` or ``--host ::``, so that they follow what
    the command means by it rather than a copy of the address."""
    return resolve_listen(parse_args(list(flags)), {}).host


@pytest.fixture()
def busy_port():
    """A port that something is listening on."""
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        s.listen()
        yield s.getsockname()[1]


@pytest.fixture()
def busy_port_on_every_interface():
    """A port that something is listening on, on every interface rather than
    only on this computer."""
    with socket.socket() as s:
        s.bind((listen_host("--lan"), 0))
        s.listen()
        yield s.getsockname()[1]


# --- the settings file -----------------------------------------------------


def test_default_env_file_sits_at_the_repository_root():
    assert config.default_env_file() == Path(__file__).resolve().parents[2] / ".env"


def test_env_file_fills_only_missing_keys(tmp_path, clean_env, monkeypatch):
    f = tmp_path / ".env"
    f.write_text("PORT=3000\nBIND=0.0.0.0\n", encoding="utf-8")
    monkeypatch.setenv("PORT", "4000")
    keys = load_env_file(f)
    assert sorted(keys) == ["BIND"]
    assert os.environ["PORT"] == "4000" and os.environ["BIND"] == "0.0.0.0"


def test_env_file_replaces_empty_variables(tmp_path, clean_env, monkeypatch):
    # The old launch scripts treated an empty variable as unset, and a shell that
    # exports BIND= should not be able to veto the file.
    f = tmp_path / ".env"
    f.write_text("BIND=0.0.0.0\n", encoding="utf-8")
    monkeypatch.setenv("BIND", "")
    keys = load_env_file(f)
    assert keys == ["BIND"]
    assert os.environ["BIND"] == "0.0.0.0"


def test_env_file_reports_keys_in_file_order(tmp_path, clean_env):
    f = tmp_path / ".env"
    f.write_text("PORT=3000\nBIND=0.0.0.0\nEVERMIND_BACKEND_PORT=8000\n", encoding="utf-8")
    keys = load_env_file(f)
    assert keys == ["PORT", "BIND", "EVERMIND_BACKEND_PORT"]


@pytest.mark.parametrize(
    ("raw", "key", "value"),
    [
        # Notepad and PowerShell: a byte order mark in front, CRLF line endings.
        ("﻿PORT=3001\r\n", "PORT", "3001"),
        ("export BIND=0.0.0.0\n", "BIND", "0.0.0.0"),
        ('EVERMIND_GATE_PASSWORD="two words"\n', "EVERMIND_GATE_PASSWORD", "two words"),
        ("EVERMIND_GATE_PASSWORD='x'\n", "EVERMIND_GATE_PASSWORD", "x"),
        ("EVERMIND_GATE_PASSWORD=pa#ss=word\n", "EVERMIND_GATE_PASSWORD", "pa#ss=word"),
        ("  PORT = 3002  \n", "PORT", "3002"),
        ("EVERMIND_GATE_PASSWORD=mot de passé ✨\n", "EVERMIND_GATE_PASSWORD", "mot de passé ✨"),
        # Only a pair that wraps the whole value is removed.
        ('EVERMIND_GATE_PASSWORD="open\n', "EVERMIND_GATE_PASSWORD", '"open'),
        ("EVERMIND_GATE_PASSWORD=it's\n", "EVERMIND_GATE_PASSWORD", "it's"),
        ('EVERMIND_GATE_PASSWORD=""\n', "EVERMIND_GATE_PASSWORD", ""),
        ("BIND=\n", "BIND", ""),
        # The last line of a file saved without a final newline still counts.
        ("PORT=3003", "PORT", "3003"),
    ],
)
def test_env_file_parsing(tmp_path, clean_env, raw, key, value):
    # Written as bytes: write_text would turn the \n of a CRLF fixture into \r\r\n
    # on Windows and test the platform instead of the parser.
    f = tmp_path / ".env"
    f.write_bytes(raw.encode("utf-8"))
    keys = load_env_file(f)
    assert keys == [key]
    assert os.environ[key] == value


@pytest.mark.parametrize(
    ("bom", "codec"),
    [(codecs.BOM_UTF16_LE, "utf-16-le"), (codecs.BOM_UTF16_BE, "utf-16-be")],
    ids=["little-endian", "big-endian"],
)
def test_env_file_utf16_reads_like_utf8(tmp_path, clean_env, bom, codec):
    # Windows PowerShell 5.1 writes UTF-16 little-endian with a byte order mark
    # for ">" and "Out-File", and CRLF line ends: the same keys and values as the
    # UTF-8 file have to come out.
    text = "PORT=3001\r\nexport BIND=0.0.0.0\r\nEVERMIND_GATE_PASSWORD=mot de passé ✨\r\n"
    f = tmp_path / ".env"
    f.write_bytes(bom + text.encode(codec))
    keys = load_env_file(f)
    assert keys == ["PORT", "BIND", "EVERMIND_GATE_PASSWORD"]
    assert os.environ["PORT"] == "3001"
    assert os.environ["BIND"] == "0.0.0.0"
    assert os.environ["EVERMIND_GATE_PASSWORD"] == "mot de passé ✨"


@pytest.mark.parametrize("codec", ["utf-16-le", "utf-16-be"])
def test_env_file_utf16_without_a_byte_order_mark(tmp_path, clean_env, codec):
    # Not every tool that writes UTF-16 puts the mark in front. The text is told
    # apart by its NUL bytes: ASCII characters leave one after them in
    # little-endian and one before them in big-endian.
    text = "PORT=3001\r\nexport BIND=0.0.0.0\r\nEVERMIND_GATE_PASSWORD=mot de passé ✨\r\n"
    f = tmp_path / ".env"
    f.write_bytes(text.encode(codec))
    keys = load_env_file(f)
    assert keys == ["PORT", "BIND", "EVERMIND_GATE_PASSWORD"]
    assert os.environ["PORT"] == "3001"
    assert os.environ["BIND"] == "0.0.0.0"
    assert os.environ["EVERMIND_GATE_PASSWORD"] == "mot de passé ✨"


@pytest.mark.parametrize(
    ("bom", "codec"),
    [(codecs.BOM_UTF32_LE, "utf-32-le"), (codecs.BOM_UTF32_BE, "utf-32-be")],
    ids=["little-endian", "big-endian"],
)
def test_env_file_utf32_with_a_byte_order_mark_reads_like_utf8(tmp_path, clean_env, bom, codec):
    # What `Out-File -Encoding utf32` writes. Its little-endian mark starts with
    # the UTF-16 one, and taken for UTF-16 the file would set nothing at all.
    text = "PORT=3001\r\nexport BIND=0.0.0.0\r\nEVERMIND_GATE_PASSWORD=mot de passé ✨\r\n"
    f = tmp_path / ".env"
    f.write_bytes(bom + text.encode(codec))
    keys = load_env_file(f)
    assert keys == ["PORT", "BIND", "EVERMIND_GATE_PASSWORD"]
    assert os.environ["PORT"] == "3001"
    assert os.environ["BIND"] == "0.0.0.0"
    assert os.environ["EVERMIND_GATE_PASSWORD"] == "mot de passé ✨"


@pytest.mark.parametrize("codec", ["utf-16-le", "utf-16-be"])
def test_env_file_utf16_without_a_mark_may_start_with_an_accent(tmp_path, clean_env, codec):
    # The first character is not ASCII, but one of its two bytes is still a NUL.
    f = tmp_path / ".env"
    f.write_bytes("é\nPORT=3001\n".encode(codec))
    keys = load_env_file(f)
    assert keys == ["PORT"]


@pytest.mark.parametrize("first_line", ["é=1", "日本=1", "# été", "# 日本語", "😀=1"])
def test_env_file_utf8_that_starts_with_a_multi_byte_character_is_not_taken_for_utf16(
    tmp_path, clean_env, first_line
):
    # No NUL byte anywhere, so no byte order guess is made: the rest of the file
    # has to come through, and that is the setting that decides whether a password
    # is asked for.
    f = tmp_path / ".env"
    f.write_bytes(f"{first_line}\nPORT=3001\n".encode())
    keys = load_env_file(f)
    assert keys == ["PORT"]
    assert os.environ["PORT"] == "3001"


@pytest.mark.parametrize(
    "data",
    [
        # UTF-32 without its mark: NULs on both sides of every ASCII character.
        "PORT=3001\n".encode("utf-32-le"),
        "PORT=3001\n".encode("utf-32-be"),
        # UTF-16 cut in the middle of a character.
        "PORT=3001\n".encode("utf-16-le")[:-1],
    ],
    ids=["utf-32-le", "utf-32-be", "truncated-utf-16"],
)
def test_env_file_with_nul_bytes_that_is_not_utf16_raises(tmp_path, clean_env, data):
    f = tmp_path / ".env"
    f.write_bytes(data)
    with pytest.raises(UnicodeError):
        load_env_file(f)
    assert "PORT" not in os.environ


def test_env_file_that_is_not_text_raises_before_setting_anything(tmp_path, clean_env):
    f = tmp_path / ".env"
    f.write_bytes(b"PORT=3001\nEVERMIND_GATE_PASSWORD=caf\xe9\n")  # Latin-1, not UTF-8
    with pytest.raises(UnicodeError):
        load_env_file(f)
    assert "PORT" not in os.environ


def test_env_file_ignores_comments_and_garbage(tmp_path, clean_env):
    f = tmp_path / ".env"
    f.write_text(
        "# PORT=1\n\n  # BIND=0.0.0.0\nnot a line\n=novalue\n1BAD=x\nBAD KEY=x\n",
        encoding="utf-8",
    )
    keys = load_env_file(f)
    assert keys == []
    assert "PORT" not in os.environ and "BIND" not in os.environ
    assert "1BAD" not in os.environ and "BAD KEY" not in os.environ


def test_missing_env_file_is_fine(tmp_path, clean_env):
    keys = load_env_file(tmp_path / "nope")
    assert keys == []


def test_ui_dir_defaults_to_the_frontend_build(clean_env):
    assert ui_dir() == config._REPO_ROOT / "frontend" / "dist"


def test_ui_dir_can_be_moved(clean_env, tmp_path, monkeypatch):
    monkeypatch.setenv("EVERMIND_UI_DIR", str(tmp_path))
    assert ui_dir() == tmp_path


def test_an_empty_ui_dir_variable_means_the_default(clean_env, monkeypatch):
    # An empty value would otherwise become Path(""), the current directory.
    monkeypatch.setenv("EVERMIND_UI_DIR", "")
    assert ui_dir() == config._REPO_ROOT / "frontend" / "dist"


def test_data_dir_defaults_to_the_repository_data_folder(clean_env, monkeypatch):
    # Not created by this test: it only says where the default is.
    monkeypatch.setattr(Path, "mkdir", lambda *args, **kwargs: None)
    assert config.data_dir() == config._REPO_ROOT / "data"


def test_data_dir_can_be_moved(clean_env, tmp_path, monkeypatch):
    monkeypatch.setenv("EVERMIND_DATA_DIR", str(tmp_path / "elsewhere"))
    assert config.data_dir() == tmp_path / "elsewhere"
    assert (tmp_path / "elsewhere").is_dir()


def test_an_empty_data_dir_variable_means_the_default(clean_env, monkeypatch):
    # An empty value would otherwise become Path(""), and Evermind would start
    # on a fresh database in whatever folder it was run from.
    monkeypatch.setattr(Path, "mkdir", lambda *args, **kwargs: None)
    monkeypatch.setenv("EVERMIND_DATA_DIR", "")
    assert config.data_dir() == config._REPO_ROOT / "data"


def test_library_dir_defaults_to_the_shipped_cards(clean_env):
    assert config.library_dir() == config._REPO_ROOT / "library"


def test_library_dir_can_be_moved(clean_env, tmp_path, monkeypatch):
    monkeypatch.setenv("EVERMIND_LIBRARY_DIR", str(tmp_path))
    assert config.library_dir() == tmp_path


def test_an_empty_library_dir_variable_means_the_default(clean_env, monkeypatch):
    monkeypatch.setenv("EVERMIND_LIBRARY_DIR", "")
    assert config.library_dir() == config._REPO_ROOT / "library"


def test_gate_password(clean_env, monkeypatch):
    assert gate_password() == ""
    monkeypatch.setenv("EVERMIND_GATE_PASSWORD", "hunter2")
    assert gate_password() == "hunter2"


# --- where to listen ---------------------------------------------------------


@pytest.mark.parametrize(
    ("argv", "env", "expected"),
    [
        ([], {}, Listen("127.0.0.1", 3000, False)),
        ([], {"BIND": "0.0.0.0", "PORT": "3001"}, Listen("0.0.0.0", 3001, False)),
        (["--lan"], {"BIND": "127.0.0.1"}, Listen("0.0.0.0", 3000, False)),
        (["--dev"], {"PORT": "3001", "BIND": "0.0.0.0"}, Listen("127.0.0.1", 8000, True)),
        (["--dev"], {"EVERMIND_BACKEND_PORT": "8123"}, Listen("127.0.0.1", 8123, True)),
        (["--dev", "--lan"], {}, Listen("127.0.0.1", 8000, True)),
        (["--port", "3999", "--host", "::1"], {"PORT": "3001"}, Listen("::1", 3999, False)),
        # A value left empty in the file means "not set", not port zero.
        ([], {"BIND": "", "PORT": ""}, Listen("127.0.0.1", 3000, False)),
        (
            ["--dev", "--port", "9000"],
            {"EVERMIND_BACKEND_PORT": "8123"},
            Listen("127.0.0.1", 9000, True),
        ),
        (["--lan", "--host", "192.168.1.5"], {}, Listen("192.168.1.5", 3000, False)),
    ],
)
def test_resolve_listen(argv, env, expected):
    assert resolve_listen(parse_args(argv), env) == expected


@pytest.mark.parametrize(
    ("argv", "env", "message"),
    [
        ([], {"PORT": "abc"}, "PORT must be a number, got 'abc'"),
        (
            ["--dev"],
            {"EVERMIND_BACKEND_PORT": "x1"},
            "EVERMIND_BACKEND_PORT must be a number, got 'x1'",
        ),
        (["--port", "abc"], {}, "--port must be a number, got 'abc'"),
        ([], {"PORT": "70000"}, "PORT must be between 1 and 65535, got '70000'"),
        (["--port", "0"], {}, "--port must be between 1 and 65535, got '0'"),
    ],
)
def test_resolve_listen_names_the_bad_setting(argv, env, message):
    with pytest.raises(ValueError, match=f"^{re.escape(message)}$"):
        resolve_listen(parse_args(argv), env)


# --- the path Evermind is served under ---------------------------------------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("", ""),
        ("/", ""),
        ("/evermind", "/evermind"),
        # Written either way in a settings file; only one is a path prefix.
        ("/evermind/", "/evermind"),
        ("/apps/evermind//", "/apps/evermind"),
        ("  /evermind  ", "/evermind"),
        # Dots inside a name are names.
        ("/.well-known/evermind", "/.well-known/evermind"),
        ("/evermind.v2", "/evermind.v2"),
    ],
)
def test_the_root_path_is_normalised(raw, expected):
    assert config.parse_root_path(raw, "EVERMIND_ROOT_PATH") == expected


@pytest.mark.parametrize(
    ("raw", "message"),
    [
        ("evermind", "EVERMIND_ROOT_PATH must start with /, got 'evermind'"),
        ("https://example.org/evermind", "EVERMIND_ROOT_PATH must start with /, got 'https://example.org/evermind'"),
        ("/ever mind", "EVERMIND_ROOT_PATH must be a plain path such as /evermind, got '/ever mind'"),
        ("/evermind?x=1", "EVERMIND_ROOT_PATH must be a plain path such as /evermind, got '/evermind?x=1'"),
        ("/evermind#top", "EVERMIND_ROOT_PATH must be a plain path such as /evermind, got '/evermind#top'"),
        # "//host" is another site to a browser that follows the redirect.
        ("//evil.example", "EVERMIND_ROOT_PATH must be a plain path such as /evermind, got '//evil.example'"),
        ("//", "EVERMIND_ROOT_PATH must be a plain path such as /evermind, got '//'"),
        ("/apps//evermind", "EVERMIND_ROOT_PATH must be a plain path such as /evermind, got '/apps//evermind'"),
        # Dots that a browser or a proxy resolves, so that the prefix is not where it says.
        ("/a/../b", "EVERMIND_ROOT_PATH must be a plain path such as /evermind, got '/a/../b'"),
        ("/./evermind", "EVERMIND_ROOT_PATH must be a plain path such as /evermind, got '/./evermind'"),
        ("/evermind/..", "EVERMIND_ROOT_PATH must be a plain path such as /evermind, got '/evermind/..'"),
        # A backslash is a slash to a browser, and a percent sign hides dots and
        # slashes from every check above until something decodes it.
        ("/evermind\\x", "EVERMIND_ROOT_PATH must be a plain path such as /evermind, got '/evermind\\\\x'"),
        ("/\\evil.example", "EVERMIND_ROOT_PATH must be a plain path such as /evermind, got '/\\\\evil.example'"),
        ("/%2e%2e/x", "EVERMIND_ROOT_PATH must be a plain path such as /evermind, got '/%2e%2e/x'"),
        ("/ever%20mind", "EVERMIND_ROOT_PATH must be a plain path such as /evermind, got '/ever%20mind'"),
        ("/evermind/%", "EVERMIND_ROOT_PATH must be a plain path such as /evermind, got '/evermind/%'"),
    ],
)
def test_a_root_path_that_is_not_a_path_is_refused(raw, message):
    with pytest.raises(ValueError, match=f"^{re.escape(message)}$"):
        config.parse_root_path(raw, "EVERMIND_ROOT_PATH")


def test_the_root_path_comes_from_the_environment(clean_env, monkeypatch):
    assert config.root_path() == ""
    monkeypatch.setenv("EVERMIND_ROOT_PATH", "/evermind/")
    assert config.root_path() == "/evermind"
    monkeypatch.setenv("EVERMIND_ROOT_PATH", "")
    assert config.root_path() == ""


@pytest.mark.parametrize(
    ("argv", "env", "expected"),
    [
        ([], {}, ""),
        ([], {"EVERMIND_ROOT_PATH": "/evermind"}, "/evermind"),
        ([], {"EVERMIND_ROOT_PATH": "/evermind/"}, "/evermind"),
        # Empty in the file means "not set", like the other settings.
        ([], {"EVERMIND_ROOT_PATH": ""}, ""),
        (["--root-path", "/apps/evermind/"], {}, "/apps/evermind"),
        # The flag wins over the file, and an empty flag takes the prefix off.
        (["--root-path", "/flag"], {"EVERMIND_ROOT_PATH": "/env"}, "/flag"),
        (["--root-path", ""], {"EVERMIND_ROOT_PATH": "/env"}, ""),
    ],
)
def test_resolve_listen_reads_the_root_path(argv, env, expected):
    assert resolve_listen(parse_args(argv), env).root_path == expected


@pytest.mark.parametrize(
    ("argv", "env", "message"),
    [
        ([], {"EVERMIND_ROOT_PATH": "evermind"}, "EVERMIND_ROOT_PATH must start with /, got 'evermind'"),
        (["--root-path", "evermind"], {}, "--root-path must start with /, got 'evermind'"),
    ],
)
def test_resolve_listen_names_the_bad_root_path(argv, env, message):
    with pytest.raises(ValueError, match=f"^{re.escape(message)}$"):
        resolve_listen(parse_args(argv), env)


def test_the_root_path_is_handed_to_uvicorn(clean_env, ui_built, served):
    p = free_port()
    code = launch.main(["--no-env-file", "--port", str(p), "--root-path", "/evermind/"])
    assert code == 0
    assert served[0][1]["root_path"] == "/evermind"


def test_the_root_path_can_be_set_in_the_environment(clean_env, ui_built, monkeypatch, served):
    monkeypatch.setenv("EVERMIND_ROOT_PATH", "/evermind")
    code = launch.main(["--no-env-file", "--port", str(free_port())])
    assert code == 0
    assert served[0][1]["root_path"] == "/evermind"


def test_a_bad_root_path_is_reported_before_anything_starts(clean_env, ui_built, served, capsys):
    code = launch.main(["--no-env-file", "--root-path", "evermind"])
    assert code == 1
    assert capsys.readouterr().err == "--root-path must start with /, got 'evermind'\n"
    assert served == []


def test_invalid_port_is_reported(clean_env, monkeypatch, capsys):
    monkeypatch.setenv("PORT", "abc")
    code = launch.main(["--no-env-file"])
    assert code == 1
    assert "PORT must be a number" in capsys.readouterr().err


def test_port_in_use_sees_a_listener(busy_port):
    assert launch.port_in_use("127.0.0.1", busy_port) is True


def test_port_in_use_lets_a_free_port_through():
    assert launch.port_in_use("127.0.0.1", free_port()) is False


def test_port_in_use_is_not_fooled_by_an_address_this_computer_does_not_have():
    # 192.0.2.1 is reserved for documentation, so no computer has it. The bind
    # fails, but not because the port is taken, and saying so would be wrong.
    assert launch.port_in_use("192.0.2.1", free_port()) is False


def test_port_in_use_sees_a_loopback_listener_when_asked_about_every_interface(busy_port):
    # Windows lets the bind to 0.0.0.0 succeed next to a listener on 127.0.0.1
    # alone, so the bind says the port is free. Something is answering there.
    assert launch.port_in_use(listen_host("--lan"), busy_port) is True


def test_port_in_use_lets_a_free_port_through_on_every_interface():
    assert launch.port_in_use(listen_host("--lan"), free_port()) is False


def test_port_in_use_sees_a_loopback_listener_when_asked_about_every_ipv6_interface():
    if not socket.has_ipv6:
        pytest.skip("no IPv6 on this computer")
    with socket.socket(socket.AF_INET6) as s:
        try:
            s.bind(("::1", 0))
        except OSError:
            pytest.skip("no IPv6 loopback on this computer")
        s.listen()
        assert launch.port_in_use(listen_host("--host", "::"), s.getsockname()[1]) is True


def test_port_in_use_sees_a_listener_on_every_interface_when_asked_about_the_loopback(
    busy_port_on_every_interface,
):
    # The other way round: Windows lets the bind to 127.0.0.1 succeed next to a
    # listener on 0.0.0.0, and a second server would share the first one's data.
    assert launch.port_in_use("127.0.0.1", busy_port_on_every_interface) is True


def test_port_in_use_sees_a_listener_on_every_interface_when_asked_about_the_network_address(
    busy_port_on_every_interface,
):
    address = launch.lan_address()
    if address is None:
        pytest.skip("no network address on this computer")
    assert launch.port_in_use(address, busy_port_on_every_interface) is True


def test_port_in_use_lets_a_free_port_through_on_the_loopback_too():
    assert launch.port_in_use("127.0.0.1", free_port()) is False


def test_has_listener_connects_to_a_listener(busy_port):
    # On Linux the bind probe fails first and never gets here, so this is the
    # only place the answer of the connection is looked at everywhere.
    assert launch._has_listener("127.0.0.1", busy_port) is True


def test_has_listener_finds_nobody_on_a_free_port():
    assert launch._has_listener("127.0.0.1", free_port()) is False


class FakeSocket:
    """Stands in for a socket in the launch module: it can be used in a ``with``,
    remembers what it was asked to do, and does nothing else. A test makes it
    fail by setting ``bind_error`` or ``connect_error`` on the class that
    ``fake_sockets`` builds."""

    bind_error: OSError | None = None
    connect_error: OSError | None = None
    local_address = ("192.168.1.20", 54321)

    def __init__(self, family, kind):
        self.family, self.kind = family, kind
        self.options = []
        self.timeout = None
        self.connected = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def setsockopt(self, level, option, value):
        self.options.append((level, option, value))

    def settimeout(self, value):
        self.timeout = value

    def bind(self, address):
        if self.bind_error:
            raise self.bind_error

    def connect(self, address):
        if self.connect_error:
            raise self.connect_error
        self.connected = address

    def getsockname(self):
        return self.local_address


def fake_sockets(monkeypatch, os_name=None, **attributes):
    """Replace the socket module, and the os module when ``os_name`` is given
    (only its ``name``), in the launch module only. Returns the list that every
    socket the module makes is added to; ``attributes`` are set on their class."""
    made = []

    class Fake(FakeSocket):
        def __init__(self, family, kind):
            super().__init__(family, kind)
            made.append(self)

    for name, value in attributes.items():
        setattr(Fake, name, value)
    monkeypatch.setattr(launch, "socket", types.SimpleNamespace(
        socket=Fake,
        AF_INET=socket.AF_INET,
        AF_INET6=socket.AF_INET6,
        SOCK_STREAM=socket.SOCK_STREAM,
        SOCK_DGRAM=socket.SOCK_DGRAM,
        SOL_SOCKET=socket.SOL_SOCKET,
        SO_REUSEADDR=socket.SO_REUSEADDR,
    ))
    if os_name is not None:
        monkeypatch.setattr(launch, "os", types.SimpleNamespace(name=os_name))
    return made


def _recording_sockets(monkeypatch, os_name):
    made = fake_sockets(monkeypatch, os_name)
    # The connection that follows a successful bind is not what these look at.
    monkeypatch.setattr(launch, "_has_listener", lambda host, port: False)
    return made


def test_port_probe_reuses_the_address_on_posix(monkeypatch):
    # uvicorn binds with SO_REUSEADDR there, so a port that only has connections
    # in TIME_WAIT left on it is free for uvicorn and has to be free for the probe.
    made = _recording_sockets(monkeypatch, "posix")
    assert launch.port_in_use("127.0.0.1", 3000) is False
    assert [m.options for m in made] == [[(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)]]


def test_port_probe_does_not_reuse_the_address_on_windows(monkeypatch):
    # There the option lets a second socket bind to a port that is in use.
    made = _recording_sockets(monkeypatch, "nt")
    assert launch.port_in_use("127.0.0.1", 3000) is False
    assert [m.options for m in made] == [[]]


# What a refused bind is called where the rights are missing: a port below 1024
# for someone who is not an administrator on POSIX, "access denied" on Windows,
# which has two spellings of the same error.
NO_RIGHTS = [errno.EACCES, errno.EPERM, getattr(errno, "WSAEACCES", errno.EACCES)]


@pytest.mark.parametrize("code", sorted(set(NO_RIGHTS)))
def test_port_probe_says_when_the_rights_are_missing(monkeypatch, code):
    fake_sockets(monkeypatch, bind_error=OSError(code, "Permission denied"))
    monkeypatch.setattr(launch, "_has_listener", lambda host, port: False)
    with pytest.raises(PermissionError):
        launch.port_in_use(listen_host("--lan"), 80)


@pytest.mark.parametrize("code", sorted(set(NO_RIGHTS)))
def test_a_refused_bind_next_to_a_listener_means_the_port_is_taken(monkeypatch, code):
    # Windows answers "access denied" when another program holds the port for its
    # own use, and that program is listening: this is no lack of rights.
    fake_sockets(monkeypatch, bind_error=OSError(code, "Permission denied"))
    monkeypatch.setattr(launch, "_has_listener", lambda host, port: True)
    assert launch.port_in_use("127.0.0.1", 5357) is True


def test_a_port_that_needs_rights_is_reported(clean_env, ui_built, monkeypatch, served, capsys):
    fake_sockets(monkeypatch, bind_error=PermissionError(errno.EACCES, "Permission denied"))
    monkeypatch.setattr(launch, "_has_listener", lambda host, port: False)
    code = launch.main(["--no-env-file", "--port", "80"])
    assert code == 1
    captured = capsys.readouterr()
    assert captured.err.splitlines() == [
        "Port 80 needs administrator rights. Pick a port above 1024, for example PORT=3001."
    ]
    assert captured.out == ""
    assert served == []


def test_a_port_that_needs_rights_in_development_names_the_api_port_setting(
    clean_env, monkeypatch, served, capsys
):
    # PORT is Vite's in development: setting it would not move the API.
    fake_sockets(monkeypatch, bind_error=PermissionError(errno.EACCES, "Permission denied"))
    monkeypatch.setattr(launch, "_has_listener", lambda host, port: False)
    code = launch.main(["--no-env-file", "--dev", "--port", "80"])
    assert code == 1
    assert capsys.readouterr().err.splitlines() == [
        (
            "Port 80 needs administrator rights. "
            "Pick a port above 1024, for example EVERMIND_BACKEND_PORT=8001."
        )
    ]
    assert served == []


def test_check_reports_a_port_that_needs_rights_too(clean_env, monkeypatch, served, capsys):
    fake_sockets(monkeypatch, bind_error=PermissionError(errno.EACCES, "Permission denied"))
    monkeypatch.setattr(launch, "_has_listener", lambda host, port: False)
    code = launch.main(["--check", "--no-env-file", "--port", "443"])
    assert code == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert "Port 443 needs administrator rights." in captured.err


def test_has_listener_does_not_wait_long_for_an_answer(monkeypatch):
    # Windows takes about two seconds to refuse a connection to a closed port,
    # and every start of Evermind waits for that answer.
    made = fake_sockets(monkeypatch)
    assert launch._has_listener("127.0.0.1", 3000) is True
    assert [(m.timeout, m.connected) for m in made] == [(0.15, ("127.0.0.1", 3000))]


def probed_by_port_in_use(monkeypatch, host, lan=None):
    """The hosts that ``port_in_use`` connects to, for a bind that succeeds."""
    fake_sockets(monkeypatch)
    monkeypatch.setattr(launch, "lan_address", lambda: lan)
    probed = []

    def nobody(address, port):
        probed.append(address)
        return False

    monkeypatch.setattr(launch, "_has_listener", nobody)
    assert launch.port_in_use(host, 3000) is False
    return probed


@pytest.mark.parametrize("host", ["0.0.0.0", "0", "::", "::0", "0:0:0:0:0:0:0:0"])
def test_every_spelling_of_a_wildcard_is_probed_on_its_loopback(monkeypatch, host):
    expected = ["::1"] if ":" in host else ["127.0.0.1", "192.168.1.20"]
    assert probed_by_port_in_use(monkeypatch, host, lan="192.168.1.20") == expected


def test_a_wildcard_is_probed_on_the_loopback_alone_without_a_network_address(monkeypatch):
    assert probed_by_port_in_use(monkeypatch, listen_host("--lan"), lan=None) == ["127.0.0.1"]


@pytest.mark.parametrize("host", ["127.0.0.1", "192.168.1.42", "::1", "10", "localhost"])
def test_an_address_of_one_interface_is_probed_as_it_is(monkeypatch, host):
    assert probed_by_port_in_use(monkeypatch, host, lan="192.168.1.20") == [host]


def test_port_in_use_sees_a_listener_on_the_network_address_alone_when_asked_about_every_interface():
    # Windows lets the bind to 0.0.0.0 succeed next to a program that listens on
    # the network address only, and the loopback does not show it.
    address = launch.lan_address()
    if address is None:
        pytest.skip("no network address on this computer")
    with socket.socket() as s:
        s.bind((address, 0))
        s.listen()
        assert launch.port_in_use(listen_host("--lan"), s.getsockname()[1]) is True


def test_lan_address_asks_the_routing_table_without_sending_anything(monkeypatch):
    made = fake_sockets(monkeypatch)
    assert launch.lan_address() == "192.168.1.20"
    assert [(m.family, m.kind, m.connected) for m in made] == [
        (socket.AF_INET, socket.SOCK_DGRAM, ("192.0.2.1", 9))
    ]


def test_lan_address_is_none_without_a_route(monkeypatch):
    fake_sockets(monkeypatch, connect_error=OSError("Network is unreachable"))
    assert launch.lan_address() is None


# --- the command ---------------------------------------------------------------


BACKEND_DIR = Path(__file__).resolve().parents[1]


def run_entry_point(*args: str) -> subprocess.CompletedProcess:
    """``python -m app`` in a process of its own, the way the launch scripts and
    the container start it: what they rely on is the exit status and the lines
    printed, and only a real process shows those. The variables that Evermind
    reads are left out of its environment, so that the developer's own cannot
    change the outcome."""
    env = {
        name: value
        for name, value in os.environ.items()
        if name not in ("PORT", "BIND") and not name.startswith("EVERMIND_")
    }
    return subprocess.run(
        [sys.executable, "-m", "app", *args],
        cwd=BACKEND_DIR, env=env, capture_output=True, text=True, timeout=60, check=False,
    )


def test_the_entry_point_prints_the_port_and_exits_with_0():
    p = free_port()
    done = run_entry_point("--check", "--no-env-file", "--port", str(p))
    assert (done.returncode, done.stdout.strip(), done.stderr) == (0, str(p), "")


def test_the_entry_point_refuses_a_busy_port_and_exits_with_1(busy_port):
    done = run_entry_point("--check", "--no-env-file", "--port", str(busy_port))
    assert done.returncode == 1
    assert done.stdout == ""
    assert f"Port {busy_port} is already in use." in done.stderr
    assert "for example PORT=3001." in done.stderr


def test_the_entry_point_names_the_api_port_setting_for_a_busy_port_in_development(busy_port):
    done = run_entry_point("--check", "--dev", "--no-env-file", "--port", str(busy_port))
    assert done.returncode == 1
    assert "for example EVERMIND_BACKEND_PORT=8001." in done.stderr
    assert "PORT=3001" not in done.stderr


def test_busy_port_is_reported(clean_env, ui_built, busy_port, served, capsys):
    code = launch.main(["--no-env-file", "--port", str(busy_port)])
    assert code == 1
    captured = capsys.readouterr()
    assert f"Port {busy_port} is already in use." in captured.err
    assert "put a free port in .env next to the scripts, for example PORT=3001." in captured.err
    assert captured.out == ""
    assert served == []


def test_busy_port_in_development_names_the_api_port_setting(clean_env, busy_port, served, capsys):
    # PORT is Vite's in development: setting it would not move the API.
    code = launch.main(["--no-env-file", "--dev", "--port", str(busy_port)])
    assert code == 1
    captured = capsys.readouterr()
    assert f"Port {busy_port} is already in use." in captured.err
    assert (
        "put a free port in .env next to the scripts, for example EVERMIND_BACKEND_PORT=8001."
        in captured.err
    )
    assert "PORT=3001" not in captured.err
    assert captured.out == ""
    assert served == []


def test_check_prints_port_and_starts_nothing(clean_env, served, capsys):
    p = free_port()
    code = launch.main(["--check", "--no-env-file", "--port", str(p)])
    assert code == 0
    captured = capsys.readouterr()
    assert captured.out.strip() == str(p)
    assert captured.err == ""
    assert served == []


def test_check_in_dev_prints_the_api_port(clean_env, monkeypatch, served, capsys):
    p = free_port()
    monkeypatch.setenv("EVERMIND_BACKEND_PORT", str(p))
    code = launch.main(["--check", "--dev", "--no-env-file"])
    assert code == 0
    assert capsys.readouterr().out.strip() == str(p)


def test_check_still_fails_on_a_busy_port(clean_env, busy_port, served, capsys):
    code = launch.main(["--check", "--no-env-file", "--port", str(busy_port)])
    assert code == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert "already in use" in captured.err


def test_check_on_the_network_sees_a_loopback_listener(clean_env, busy_port, served, capsys):
    # prod.ps1 -Lan after a local-only run: the port looks free to a bind to
    # 0.0.0.0 on Windows, and starting would put two servers on it.
    code = launch.main(["--check", "--no-env-file", "--lan", "--port", str(busy_port)])
    assert code == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert f"Port {busy_port} is already in use." in captured.err
    assert served == []


def test_check_sees_a_listener_on_every_interface(
    clean_env, busy_port_on_every_interface, served, capsys
):
    # Evermind started with -Lan or BIND=0.0.0.0, then started again local only.
    p = busy_port_on_every_interface
    code = launch.main(["--check", "--no-env-file", "--port", str(p)])
    assert code == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert f"Port {p} is already in use." in captured.err
    assert served == []


def test_check_on_the_network_lets_a_free_port_through(clean_env, served, capsys):
    p = free_port()
    code = launch.main(["--check", "--no-env-file", "--lan", "--port", str(p)])
    assert code == 0
    assert capsys.readouterr().out.strip() == str(p)


def test_refuses_to_start_without_built_ui(clean_env, tmp_path, monkeypatch, served, capsys):
    empty = tmp_path / "empty"
    empty.mkdir()
    monkeypatch.setenv("EVERMIND_UI_DIR", str(empty))
    code = launch.main(["--no-env-file", "--port", str(free_port())])
    assert code == 1
    err = capsys.readouterr().err
    assert f"The interface has not been built ({empty} has no index.html)." in err
    assert 'Run scripts/prod.ps1 or scripts/prod.sh, which build it, or "npm run build"' in err
    assert served == []


def test_starts_uvicorn_with_resolved_values(clean_env, ui_built, served, capsys):
    p = free_port()
    code = launch.main(["--no-env-file", "--port", str(p)])
    assert code == 0
    assert served == [
        ("app.main:app", {"host": "127.0.0.1", "port": p, "reload": False, "root_path": ""})
    ]
    captured = capsys.readouterr()
    assert captured.out == f"Evermind -> http://localhost:{p}\n"
    assert captured.err == ""


def test_lan_lists_the_address_other_devices_use(clean_env, ui_built, monkeypatch, served, capsys):
    monkeypatch.setenv("EVERMIND_GATE_PASSWORD", "secret")
    monkeypatch.setattr(launch, "lan_address", lambda: "192.168.1.20")
    p = free_port()
    code = launch.main(["--no-env-file", "--lan", "--port", str(p)])
    assert code == 0
    assert served[0][1]["host"] == "0.0.0.0"
    assert capsys.readouterr().out == (
        f"Evermind -> http://localhost:{p}\n"
        f"            http://192.168.1.20:{p}  (from the local network)\n"
    )


def test_lan_without_a_route_lists_only_localhost(clean_env, ui_built, monkeypatch, served, capsys):
    monkeypatch.setenv("EVERMIND_GATE_PASSWORD", "secret")
    monkeypatch.setattr(launch, "lan_address", lambda: None)
    p = free_port()
    code = launch.main(["--no-env-file", "--lan", "--port", str(p)])
    assert code == 0
    assert capsys.readouterr().out == f"Evermind -> http://localhost:{p}\n"


@pytest.mark.parametrize(
    ("host", "shown"),
    [
        ("127.0.0.1", "localhost"),
        ("localhost", "localhost"),
        ("::1", "localhost"),
        ("::", "localhost"),
        ("::0", "localhost"),
        ("192.168.1.42", "192.168.1.42"),
        ("fd00::42", "[fd00::42]"),
        ("evermind.invalid", "evermind.invalid"),
    ],
)
def test_the_printed_address_is_one_that_answers(
    clean_env, ui_built, monkeypatch, served, capsys, host, shown
):
    # Bound to one address of the network, the computer refuses connections to
    # localhost: the line has to name the address that was bound.
    monkeypatch.setenv("EVERMIND_GATE_PASSWORD", "secret")
    p = free_port()
    code = launch.main(["--no-env-file", "--host", host, "--port", str(p)])
    assert code == 0
    assert capsys.readouterr().out == f"Evermind -> http://{shown}:{p}\n"


@pytest.mark.parametrize("host", ["0", "0.0.0.0"])
def test_every_spelling_of_the_wildcard_lists_the_network_address(
    clean_env, ui_built, monkeypatch, served, capsys, host
):
    monkeypatch.setenv("EVERMIND_GATE_PASSWORD", "secret")
    monkeypatch.setattr(launch, "lan_address", lambda: "192.168.1.20")
    p = free_port()
    code = launch.main(["--no-env-file", "--host", host, "--port", str(p)])
    assert code == 0
    assert capsys.readouterr().out == (
        f"Evermind -> http://localhost:{p}\n"
        f"            http://192.168.1.20:{p}  (from the local network)\n"
    )


def test_a_specific_address_gets_no_second_line(clean_env, ui_built, monkeypatch, served, capsys):
    # The "from the local network" line is for the wildcard, where the address
    # to give other devices has to be looked up; here the first line says it.
    monkeypatch.setenv("EVERMIND_GATE_PASSWORD", "secret")
    monkeypatch.setattr(launch, "lan_address", lambda: "192.168.1.20")
    p = free_port()
    code = launch.main(["--no-env-file", "--host", "192.168.1.42", "--port", str(p)])
    assert code == 0
    assert capsys.readouterr().out == f"Evermind -> http://192.168.1.42:{p}\n"


def test_lan_without_password_warns(clean_env, ui_built, monkeypatch, served, capsys):
    monkeypatch.setattr(launch, "lan_address", lambda: "192.168.1.20")
    code = launch.main(["--no-env-file", "--lan", "--port", str(free_port())])
    assert code == 0
    err = capsys.readouterr().err
    assert "No password is set, so anyone on this network can read your conversations." in err
    assert "Put EVERMIND_GATE_PASSWORD in .env to be asked for one." in err


def test_lan_with_password_does_not_warn(clean_env, ui_built, monkeypatch, served, capsys):
    monkeypatch.setattr(launch, "lan_address", lambda: "192.168.1.20")
    monkeypatch.setenv("EVERMIND_GATE_PASSWORD", "secret")
    code = launch.main(["--no-env-file", "--lan", "--port", str(free_port())])
    assert code == 0
    assert "anyone on this network" not in capsys.readouterr().err


@pytest.mark.parametrize(
    ("flags", "warns"),
    [
        (["--host", "0.0.0.0"], True),
        (["--host", "192.168.1.5"], True),
        (["--host", "::"], True),
        (["--host", "127.0.0.1"], False),
        (["--host", "::1"], False),
        (["--host", "localhost"], False),
    ],
)
def test_warning_follows_the_host_not_the_flag(clean_env, ui_built, served, capsys, flags, warns):
    code = launch.main(["--no-env-file", "--port", str(free_port()), *flags])
    assert code == 0
    assert ("anyone on this network" in capsys.readouterr().err) is warns


def test_a_local_only_start_without_password_is_silent(clean_env, ui_built, served, capsys):
    code = launch.main(["--no-env-file", "--port", str(free_port())])
    assert code == 0
    assert capsys.readouterr().err == ""


def test_dev_starts_the_api_with_reload_and_no_built_ui(clean_env, served, capsys):
    # Nothing was built here, and nothing needs to be: in development the page
    # comes from the Vite server, so the API alone is started and watched.
    p = free_port()
    code = launch.main(["--dev", "--no-env-file", "--port", str(p)])
    assert code == 0
    app_dir = str(Path(launch.__file__).resolve().parent)
    assert served == [
        (
            "app.main:app",
            {
                "host": "127.0.0.1", "port": p, "reload": True, "root_path": "",
                "reload_dirs": [app_dir],
            },
        )
    ]
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == ""


def test_dev_on_the_network_without_password_warns(clean_env, served, capsys):
    code = launch.main(["--dev", "--lan", "--no-env-file", "--port", str(free_port())])
    assert code == 0
    assert "anyone on this network" in capsys.readouterr().err


def test_container_prints_no_addresses_and_no_warning(
    clean_env, ui_built, monkeypatch, served, capsys
):
    # docker-compose.yml decides what is exposed; from inside, 0.0.0.0 is simply
    # how the published port reaches the process.
    monkeypatch.setattr(update_check, "install_kind", lambda: "docker")
    code = launch.main(["--no-env-file", "--host", "0.0.0.0", "--port", str(free_port())])
    assert code == 0
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == ""


@pytest.mark.parametrize(
    ("flags", "expected"),
    [
        (["--no-env-file"], None),
        ([], "from-default"),
        (["--env-file", "<custom>"], "from-custom"),
        (["--no-env-file", "--env-file", "<custom>"], None),
    ],
)
def test_env_file_flags(clean_env, tmp_path, monkeypatch, flags, expected):
    default = tmp_path / "default.env"
    default.write_text("EVERMIND_GATE_PASSWORD=from-default\n", encoding="utf-8")
    custom = tmp_path / "custom.env"
    custom.write_text("EVERMIND_GATE_PASSWORD=from-custom\n", encoding="utf-8")
    monkeypatch.setattr(config, "default_env_file", lambda: default)
    argv = [str(custom) if flag == "<custom>" else flag for flag in flags]
    code = launch.main(["--check", "--port", str(free_port()), *argv])
    assert code == 0
    assert os.environ.get("EVERMIND_GATE_PASSWORD") == expected


def test_explicit_env_file_that_does_not_exist_is_an_error(clean_env, tmp_path, served, capsys):
    missing = tmp_path / "nope.env"
    code = launch.main(["--check", "--env-file", str(missing), "--port", str(free_port())])
    assert code == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err.splitlines() == [f"The settings file {missing} does not exist."]
    assert served == []


def test_missing_default_env_file_stays_silent(clean_env, served, capsys):
    # clean_env points the default file at one that does not exist.
    code = launch.main(["--check", "--port", str(free_port())])
    assert code == 0
    assert capsys.readouterr().err == ""


def test_no_env_file_wins_over_a_missing_explicit_one(clean_env, tmp_path, served, capsys):
    argv = ["--check", "--no-env-file", "--env-file", str(tmp_path / "nope.env")]
    code = launch.main([*argv, "--port", str(free_port())])
    assert code == 0
    assert capsys.readouterr().err == ""


@pytest.mark.parametrize("explicit", [True, False], ids=["explicit", "default"])
def test_undecodable_env_file_names_the_file_and_exits(
    clean_env, tmp_path, monkeypatch, served, capsys, explicit
):
    f = tmp_path / "broken.env"
    f.write_bytes(b"EVERMIND_GATE_PASSWORD=caf\xe9\n")
    flags = ["--env-file", str(f)] if explicit else []
    if not explicit:
        monkeypatch.setattr(config, "default_env_file", lambda: f)
    code = launch.main(["--check", "--port", str(free_port()), *flags])
    assert code == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err.splitlines() == [
        f"Cannot read the settings file {f}: it is not valid UTF-8, UTF-16 or UTF-32 text."
    ]
    assert served == []


@pytest.mark.parametrize("codec", ["utf-32-le", "utf-32-be"])
def test_utf32_without_a_mark_is_reported_rather_than_misread(
    clean_env, tmp_path, served, capsys, codec
):
    # Only the mark tells UTF-32 apart: without it the file is refused in one
    # line, and nothing from it is set.
    f = tmp_path / "utf32.env"
    f.write_bytes("EVERMIND_GATE_PASSWORD=secret\n".encode(codec))
    code = launch.main(["--check", "--port", str(free_port()), "--env-file", str(f)])
    assert code == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err.splitlines() == [
        f"Cannot read the settings file {f}: it is not valid UTF-8, UTF-16 or UTF-32 text."
    ]
    assert "EVERMIND_GATE_PASSWORD" not in os.environ
    assert served == []


@pytest.mark.parametrize(
    ("bom", "codec"),
    [(codecs.BOM_UTF32_LE, "utf-32-le"), (codecs.BOM_UTF32_BE, "utf-32-be")],
    ids=["little-endian", "big-endian"],
)
def test_utf32_cut_short_is_reported_and_sets_nothing(
    clean_env, tmp_path, served, capsys, bom, codec
):
    # The mark says UTF-32, and the last character is missing a byte.
    f = tmp_path / "cut.env"
    f.write_bytes(bom + "PORT=3001\nEVERMIND_GATE_PASSWORD=secret\n".encode(codec)[:-1])
    code = launch.main(["--check", "--port", str(free_port()), "--env-file", str(f)])
    assert code == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err.splitlines() == [
        f"Cannot read the settings file {f}: it is not valid UTF-8, UTF-16 or UTF-32 text."
    ]
    assert "EVERMIND_GATE_PASSWORD" not in os.environ
    assert served == []


def test_unreadable_env_file_names_the_file_and_exits(clean_env, tmp_path, served, capsys):
    # A folder where a file is expected: PermissionError on Windows, IsADirectoryError
    # elsewhere, and either way an OSError.
    code = launch.main(["--check", "--env-file", str(tmp_path), "--port", str(free_port())])
    assert code == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert len(captured.err.splitlines()) == 1
    assert captured.err.startswith(f"Cannot read the settings file {tmp_path}: ")
    assert captured.err.endswith(".\n")


def test_settings_from_the_file_decide_where_to_listen(clean_env, tmp_path, served, capsys):
    env_file = tmp_path / "custom.env"
    env_file.write_text(f"BIND=0.0.0.0\nPORT={free_port()}\n", encoding="utf-8")
    code = launch.main(["--check", "--env-file", str(env_file)])
    assert code == 0
    assert capsys.readouterr().out.strip() == os.environ["PORT"]


def test_data_dir_flag(clean_env, tmp_path):
    d = tmp_path / "elsewhere"
    code = launch.main(["--check", "--no-env-file", "--port", str(free_port()),
                        "--data-dir", str(d)])
    assert code == 0
    assert os.environ["EVERMIND_DATA_DIR"] == str(d)


def test_data_dir_flag_beats_the_env_file(clean_env, tmp_path):
    env_file = tmp_path / "custom.env"
    env_file.write_text("EVERMIND_DATA_DIR=from-the-file\n", encoding="utf-8")
    d = tmp_path / "from-the-flag"
    code = launch.main(["--check", "--env-file", str(env_file), "--port", str(free_port()),
                        "--data-dir", str(d)])
    assert code == 0
    assert os.environ["EVERMIND_DATA_DIR"] == str(d)
