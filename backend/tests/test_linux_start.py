"""The Linux and macOS start script, ``scripts/prod.sh``, as bash runs it.

What the script hands to ``python -m app`` goes through the shell's own argument
handling, and what it installs, builds and starts depends on a handful of stamp
files. Nothing else exercises either. The script runs from a copy of the project in
which the venv's Python, ``python3`` and ``npm`` only write down how they were
called, so nothing is installed, built or started.
"""

import os
import shlex
import shutil
import subprocess
import sys
from pathlib import Path
from typing import NamedTuple

import pytest

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="prod.sh is run by bash")

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "prod.sh"
BASH = shutil.which("bash") or "bash"

# One stand-in serves for every program the script calls. It writes down the program,
# the folder it was called from and its arguments (tab between the three, a control
# character after each argument, so that an argument with a space stays one), then
# exits with the status STAND_IN_EXIT_<kind> asks for, 0 when nothing is asked. What
# the call was for (its kind) is read from the arguments.
STAND_IN = r"""#!/usr/bin/env bash
name="$(basename "$0")"
case "$name $*" in
    "python -m pip --version"*) kind=pip_version ;;
    "python -m pip install"*) kind=pip_install ;;
    "python -m app --check"*) kind=check ;;
    "python -m app"*) kind=start ;;
    "python3 -m venv"*) kind=venv ;;
    "npm ci"*) kind=npm_ci ;;
    "npm run build"*) kind=npm_build ;;
    *) kind=other ;;
esac
{
    printf '%s\t%s\t' "$name" "$PWD"
    if [ "$#" -gt 0 ]; then printf '%s\037' "$@"; fi
    printf '\n'
} >> "$STAND_IN_LOG"
# What `--check` says is for the log, not for the window: the script must keep it quiet.
if [ "$kind" = check ]; then echo "port is taken"; fi
var="STAND_IN_EXIT_$kind"
exit "${!var:-0}"
"""


class Call(NamedTuple):
    command: str  # the program and its arguments, in the form a shell would take them
    folder: str


def make_project(root):
    """The project as far as prod.sh looks at it, with everything installed already."""
    (root / "scripts").mkdir(parents=True)
    shutil.copyfile(SCRIPT, root / "scripts" / "prod.sh")
    (root / "backend" / ".venv" / "bin").mkdir(parents=True)
    (root / "frontend" / "node_modules").mkdir(parents=True)
    for written in [
        "backend/pyproject.toml",
        "backend/.venv/.installed-pyproject.toml",
        "frontend/package-lock.json",
        "frontend/node_modules/.installed-package-lock.json",
    ]:
        (root / written).write_text('{"version": 1}', encoding="utf-8")
    # First on the PATH: the script finds these, and no python3 or npm of the machine.
    (root / "bin").mkdir()
    stand_ins = [root / "backend" / ".venv" / "bin" / "python"]
    stand_ins += [root / "bin" / "python3", root / "bin" / "npm"]
    for stand_in in stand_ins:
        stand_in.write_text(STAND_IN, encoding="utf-8")
        stand_in.chmod(0o755)
    return root


@pytest.fixture()
def project(tmp_path):
    return make_project(tmp_path.resolve() / "evermind")


def run(project, *options, cwd=None, exits=None):
    """The exit status, what the window shows (output, then errors) and the calls made, in
    order. ``exits`` maps a kind of call to the status it ends with, and ``cwd`` is the
    folder the script is launched from, the project's own by default."""
    log = project / "calls.log"
    # Each run is read on its own, whatever ran before it.
    log.unlink(missing_ok=True)
    env = {
        **os.environ,
        "PATH": f"{project / 'bin'}{os.pathsep}{os.environ['PATH']}",
        "STAND_IN_LOG": str(log),
    }
    for kind, status in (exits or {}).items():
        env[f"STAND_IN_EXIT_{kind}"] = str(status)
    done = subprocess.run(
        [BASH, str(project / "scripts" / "prod.sh"), *options],
        cwd=cwd or project,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    calls = []
    if log.exists():
        for line in log.read_text(encoding="utf-8").splitlines():
            program, folder, arguments = line.split("\t")
            arguments = arguments.split("\x1f")[:-1] if arguments else []
            calls.append(Call(shlex.join([program, *arguments]), folder))
    return done, calls


def commands(calls):
    return [call.command for call in calls]


def start_with(project, *options):
    """What a start with nothing to install does, in the order the script goes."""
    given = shlex.join(options)
    given = f" {given}" if given else ""
    return [
        "python -m pip --version",
        f"python -m app --check{given}",
        "npm run build",
        f"python -m app{given}",
    ]


def install_backend(project):
    return f"python -m pip install -q -e {shlex.quote(str(project / 'backend'))}"


@pytest.mark.parametrize(
    "options",
    [(), ("--lan",), ("--lan", "two words"), ("--note=two words",)],
    ids=["local", "--lan", "--lan and a word with a space", "an option with a space"],
)
def test_the_options_reach_python_whole(project, options):
    done, calls = run(project, *options)
    assert done.returncode == 0, done.stderr
    assert commands(calls) == start_with(project, *options)
    # Whole, not only in the log's form: the arguments are the same one by one.
    start = calls[-1]
    assert shlex.split(start.command) == ["python", "-m", "app", *options]


def test_the_check_and_the_start_run_from_the_backend_folder(project):
    done, calls = run(project, "--lan")
    assert done.returncode == 0, done.stderr
    folders = [call.folder for call in calls if call.command.startswith("python -m app")]
    assert folders == [str(project / "backend")] * 2


def test_the_build_runs_from_the_frontend_folder(project):
    run_done, calls = run(project)
    assert run_done.returncode == 0, run_done.stderr
    [build] = [call for call in calls if call.command == "npm run build"]
    assert build.folder == str(project / "frontend")


def test_the_answer_of_the_check_is_not_shown(project):
    done, _ = run(project)
    assert done.returncode == 0, done.stderr
    assert "port is taken" not in done.stdout + done.stderr


def test_the_exit_status_is_the_one_of_the_server(project):
    done, calls = run(project, exits={"start": 7})
    assert done.returncode == 7, done.stderr
    assert commands(calls) == start_with(project)


@pytest.mark.parametrize("lock_changed", [False, True], ids=["installed", "to install"])
def test_a_failed_check_starts_nothing(project, lock_changed):
    # With a lockfile that differs, the check still comes first: the interface is not
    # installed for a start that cannot happen.
    if lock_changed:
        (project / "frontend" / "package-lock.json").write_text('{"version": 2}', encoding="utf-8")
    done, calls = run(project, "--lan", exits={"check": 3})
    assert done.returncode == 1
    assert "Nothing was started." in done.stderr
    assert "Nothing was started." not in done.stdout
    assert commands(calls) == ["python -m pip --version", "python -m app --check --lan"]


def test_the_environment_is_created_when_pip_does_not_answer(project):
    done, calls = run(project, exits={"pip_version": 1})
    assert done.returncode == 0, done.stderr
    assert "First run: creating the Python environment..." in done.stdout
    venv = f"python3 -m venv --clear {shlex.quote(str(project / 'backend' / '.venv'))}"
    assert commands(calls) == [
        "python -m pip --version",
        venv,
        "python -m app --check",
        "npm run build",
        "python -m app",
    ]


def test_the_environment_is_left_alone_when_pip_answers(project):
    done, calls = run(project)
    assert done.returncode == 0, done.stderr
    assert "First run" not in done.stdout
    assert not [call for call in calls if call.command.startswith("python3")]


def test_a_changed_backend_dependency_file_is_installed_again(project):
    stamp = project / "backend" / ".venv" / ".installed-pyproject.toml"
    pyproject = project / "backend" / "pyproject.toml"

    # The same file as its stamp: nothing is installed.
    done, calls = run(project)
    assert done.returncode == 0, done.stderr
    assert install_backend(project) not in commands(calls)

    # A changed file is installed, and the stamp then holds what was installed.
    pyproject.write_text('{"version": 2}', encoding="utf-8")
    expected = [
        "python -m pip --version",
        install_backend(project),
        "python -m app --check",
        "npm run build",
        "python -m app",
    ]
    done, calls = run(project)
    assert done.returncode == 0, done.stderr
    assert "Installing backend dependencies..." in done.stdout
    assert commands(calls) == expected
    assert stamp.read_bytes() == pyproject.read_bytes()

    # So the next start installs nothing...
    done, calls = run(project)
    assert commands(calls) == start_with(project)

    # ...until the file changes again.
    pyproject.write_text('{"version": 3}', encoding="utf-8")
    done, calls = run(project)
    assert commands(calls) == expected
    assert stamp.read_bytes() == pyproject.read_bytes()


def test_a_missing_backend_stamp_is_installed(project):
    (project / "backend" / ".venv" / ".installed-pyproject.toml").unlink()
    done, calls = run(project)
    assert done.returncode == 0, done.stderr
    assert install_backend(project) in commands(calls)


def test_a_failed_backend_install_leaves_no_stamp_and_stops_the_script(project):
    stamp = project / "backend" / ".venv" / ".installed-pyproject.toml"
    (project / "backend" / "pyproject.toml").write_text('{"version": 2}', encoding="utf-8")
    done, calls = run(project, exits={"pip_install": 1})
    assert done.returncode != 0
    assert commands(calls) == ["python -m pip --version", install_backend(project)]
    # The old stamp does not stay either: it would vouch for the file it came from.
    assert not stamp.exists()

    # The next start tries again, rather than taking the failure for an install.
    done, calls = run(project)
    assert done.returncode == 0, done.stderr
    assert install_backend(project) in commands(calls)
    assert stamp.read_bytes() == (project / "backend" / "pyproject.toml").read_bytes()


def test_a_changed_lockfile_is_installed_with_ci(project):
    lock = project / "frontend" / "package-lock.json"
    stamp = project / "frontend" / "node_modules" / ".installed-package-lock.json"

    # The same file as its stamp: nothing is installed.
    done, calls = run(project)
    assert done.returncode == 0, done.stderr
    assert "npm ci" not in commands(calls)

    # A change in letter case alone is a change.
    lock.write_text('{"A": 1}', encoding="utf-8")
    stamp.write_text('{"a": 1}', encoding="utf-8")
    done, calls = run(project)
    assert done.returncode == 0, done.stderr
    assert "Installing frontend dependencies" in done.stdout
    assert commands(calls) == [
        "python -m pip --version",
        "python -m app --check",
        "npm ci",
        "npm run build",
        "python -m app",
    ]
    [install] = [call for call in calls if call.command == "npm ci"]
    assert install.folder == str(project / "frontend")
    assert stamp.read_bytes() == lock.read_bytes()

    # So the next start installs nothing.
    done, calls = run(project)
    assert commands(calls) == start_with(project)


def test_a_missing_lockfile_stamp_is_installed(project):
    (project / "frontend" / "node_modules" / ".installed-package-lock.json").unlink()
    done, calls = run(project)
    assert done.returncode == 0, done.stderr
    assert "npm ci" in commands(calls)
    assert not [call for call in calls if call.command.startswith("npm install")]


def test_a_failed_npm_ci_leaves_no_stamp_and_starts_nothing(project):
    stamp = project / "frontend" / "node_modules" / ".installed-package-lock.json"
    (project / "frontend" / "package-lock.json").write_text('{"version": 2}', encoding="utf-8")
    done, calls = run(project, exits={"npm_ci": 1})
    assert done.returncode != 0
    assert commands(calls) == ["python -m pip --version", "python -m app --check", "npm ci"]
    assert not stamp.exists()

    # The next start tries again.
    done, calls = run(project)
    assert done.returncode == 0, done.stderr
    assert "npm ci" in commands(calls)


def test_the_interface_is_built_on_every_run(project):
    for _ in range(2):
        done, calls = run(project)
        assert done.returncode == 0, done.stderr
        assert "Building the frontend" in done.stdout
        assert commands(calls).count("npm run build") == 1


def test_a_failed_build_starts_nothing(project):
    done, calls = run(project, "--lan", exits={"npm_build": 1})
    assert done.returncode != 0
    assert commands(calls) == [
        "python -m pip --version",
        "python -m app --check --lan",
        "npm run build",
    ]


@pytest.mark.parametrize(
    "folder", ["evermind", "my evermind"], ids=["plain path", "path with a space"]
)
def test_the_script_works_from_another_directory(tmp_path, folder):
    project = make_project(tmp_path.resolve() / folder)
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    # Stale files, so that the script has to reach the project's own paths and install.
    (project / "backend" / "pyproject.toml").write_text('{"version": 2}', encoding="utf-8")
    (project / "frontend" / "package-lock.json").write_text('{"version": 2}', encoding="utf-8")
    done, calls = run(project, "--lan", cwd=elsewhere)
    assert done.returncode == 0, done.stderr
    assert commands(calls) == [
        "python -m pip --version",
        install_backend(project),
        "python -m app --check --lan",
        "npm ci",
        "npm run build",
        "python -m app --lan",
    ]
    assert {call.folder for call in calls if call.command.startswith("python -m app")} == {
        str(project / "backend")
    }
