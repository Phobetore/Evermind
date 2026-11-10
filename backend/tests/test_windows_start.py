"""The Windows start script, ``scripts\\prod.ps1``, as Windows PowerShell runs it.

What the script hands to ``python -m app`` goes through PowerShell's own argument
handling, which nothing else exercises: 3.1.0 passed ``-Lan`` on letter by letter.
The script runs from a copy of the project in which python.exe and npm only write
down how they were called, so nothing is installed, built or started.
"""

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(
    sys.platform != "win32" or shutil.which("powershell") is None,
    reason="prod.ps1 is run by Windows PowerShell",
)

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "prod.ps1"

# The python.exe of the copy: it writes down its arguments and succeeds. An empty
# argument, or one with a space, is written in quotes, so that one argument stays one.
STAND_IN_SOURCE = """
using System;
using System.IO;
public static class StandIn {
    public static int Main(string[] args) {
        string line = "python";
        foreach (string arg in args) {
            line += " " + (arg.Length == 0 || arg.IndexOf(' ') >= 0 ? "\\"" + arg + "\\"" : arg);
        }
        File.AppendAllText(Environment.GetEnvironmentVariable("STAND_IN_LOG"), line + Environment.NewLine);
        return 0;
    }
}
"""

# A start with nothing to install, in the order the script goes.
START = ["python -m pip --version", "python -m app --check{lan}", "npm run build", "python -m app{lan}"]


def powershell(*argv, **kwargs):
    # Windows PowerShell writes in the console's OEM code page, not the ANSI one Python assumes.
    return subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", *argv],
        capture_output=True, encoding="oem", errors="replace", timeout=120, check=False, **kwargs,
    )


@pytest.fixture(scope="module")
def python_stand_in(tmp_path_factory):
    folder = tmp_path_factory.mktemp("stand-in")
    source, exe = folder / "python.cs", folder / "python.exe"
    source.write_text(STAND_IN_SOURCE, encoding="utf-8")
    # The paths go through the environment, where a quote in them breaks nothing.
    done = powershell(
        "-Command", "Add-Type -Path $env:STAND_IN_CS -OutputAssembly $env:STAND_IN_EXE -OutputType ConsoleApplication",
        env={**os.environ, "STAND_IN_CS": str(source), "STAND_IN_EXE": str(exe)},
    )
    assert done.returncode == 0, done.stdout + done.stderr
    # Where unsigned programs are blocked, the script would go on to the real Python:
    # better to stop here, with the reason Windows gives.
    probe = folder / "probe.log"
    subprocess.run([exe], env={**os.environ, "STAND_IN_LOG": str(probe)}, timeout=60, check=True)
    assert probe.exists()
    return exe


@pytest.fixture()
def project(tmp_path, python_stand_in):
    """The project as far as prod.ps1 looks at it, with everything installed already."""
    (tmp_path / "scripts").mkdir()
    shutil.copyfile(SCRIPT, tmp_path / "scripts" / "prod.ps1")
    (tmp_path / "backend" / ".venv" / "Scripts").mkdir(parents=True)
    shutil.copyfile(python_stand_in, tmp_path / "backend" / ".venv" / "Scripts" / "python.exe")
    (tmp_path / "frontend" / "node_modules").mkdir(parents=True)
    for written in ["backend/pyproject.toml", "backend/.venv/.installed-pyproject.toml",
                    "frontend/package-lock.json", "frontend/node_modules/.installed-package-lock.json"]:
        (tmp_path / written).write_text("{}", encoding="utf-8")
    # First on the PATH: whichever form PowerShell prefers, the npm it finds is one of
    # these, and so is any python the script would look for there.
    (tmp_path / "bin").mkdir()
    (tmp_path / "bin" / "npm.cmd").write_text('@>>"%STAND_IN_LOG%" echo npm %*\n', encoding="ascii")
    (tmp_path / "bin" / "npm.ps1").write_text(
        'Add-Content -LiteralPath $env:STAND_IN_LOG -Value ("npm " + ($args -join " "))\n', encoding="ascii"
    )
    shutil.copyfile(python_stand_in, tmp_path / "bin" / "python.exe")
    return tmp_path


def run(project, *options, typed=False):
    """The exit status, what the window shows, and the calls made, in order.
    ``typed`` runs the script as when typed at a PowerShell prompt, rather than
    through ``powershell -File`` as the documentation has it."""
    log = project / "calls.log"
    script = project / "scripts" / "prod.ps1"
    env = {**os.environ, "PATH": f"{project / 'bin'}{os.pathsep}{os.environ['PATH']}",
           "STAND_IN_LOG": str(log), "PROD_PS1": str(script)}
    if typed:
        done = powershell("-Command", f"& $env:PROD_PS1 {' '.join(options)}; exit $LASTEXITCODE", cwd=project, env=env)
    else:
        done = powershell("-File", str(script), *options, cwd=project, env=env)
    calls = log.read_text(encoding="utf-8").splitlines() if log.exists() else []
    return done.returncode, done.stdout + done.stderr, calls


@pytest.mark.parametrize("typed", [False, True], ids=["-File", "typed"])
@pytest.mark.parametrize(("options", "lan"), [
    ((), ""),
    (("-Lan",), " --lan"),
    (("--lan",), " --lan"),  # as the Linux script spells it
    (("--LAN",), " --lan"),
], ids=["local", "-Lan", "--lan", "--LAN"])
def test_the_option_reaches_python_whole(project, typed, options, lan):
    status, shown, calls = run(project, *options, typed=typed)
    assert status == 0, shown
    assert calls == [call.format(lan=lan) for call in START]


@pytest.mark.parametrize(("options", "typed", "lan"), [
    (("",), False, ""),  # an empty argument, as a .bat passing "%1" on gives
    (("'-Lan'",), True, " --lan"),  # -Lan as text: quoted, or passed on by another script
], ids=["empty", "-Lan as text"])
def test_what_another_script_passes_on_is_understood(project, options, typed, lan):
    status, shown, calls = run(project, *options, typed=typed)
    assert status == 0, shown
    assert calls == [call.format(lan=lan) for call in START]


@pytest.mark.parametrize("typed", [False, True], ids=["-File", "typed"])
def test_an_unknown_option_starts_nothing(project, typed):
    status, shown, calls = run(project, "--port", "4000", typed=typed)
    assert status == 1
    assert "Unknown option: --port 4000. The only option is -Lan" in shown
    assert "Nothing was started." in shown
    assert calls == []
