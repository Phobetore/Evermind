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

pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="prod.ps1 is run by Windows PowerShell")

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "prod.ps1"
POWERSHELL = shutil.which("powershell") or "powershell"

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


def powershell(*argv, env=None, module_path=None, **kwargs):
    # Under PowerShell 7 (the CI's shell, or a developer's terminal) the environment lists
    # 7's module folders first, and a Windows PowerShell that inherits them fails to load
    # some of its own commands. Without the variable, it builds its own, as when typed.
    env = {name: value for name, value in (os.environ if env is None else env).items()
           if name.upper() != "PSMODULEPATH"}
    if module_path:
        env["PSModulePath"] = module_path
    # Windows PowerShell writes in the console's OEM code page, not the ANSI one Python assumes.
    return subprocess.run(
        [POWERSHELL, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", *argv], env=env,
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


def run(project, *options, typed=False, path=None, module_path=None):
    """The exit status, what the window shows, and the calls made, in order.
    ``typed`` runs the script as when typed at a PowerShell prompt, rather than
    through ``powershell -File`` as the documentation has it. ``path`` replaces
    the PATH, which otherwise has the stand-ins in front of the real one, and
    ``module_path`` is the PSModulePath Windows PowerShell inherits."""
    log = project / "calls.log"
    script = project / "scripts" / "prod.ps1"
    env = {**os.environ, "PATH": path or f"{project / 'bin'}{os.pathsep}{os.environ['PATH']}",
           "STAND_IN_LOG": str(log), "PROD_PS1": str(script)}
    if typed:
        command = f"& $env:PROD_PS1 {' '.join(options)}; exit $LASTEXITCODE"
        done = powershell("-Command", command, cwd=project, env=env, module_path=module_path)
    else:
        done = powershell("-File", str(script), *options, cwd=project, env=env, module_path=module_path)
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
    assert calls == [call.format(lan=lan) for call in START], shown


@pytest.mark.parametrize(("options", "typed", "lan"), [
    (("",), False, ""),  # an empty argument, as a .bat passing "%1" on gives
    (("'-Lan'",), True, " --lan"),  # -Lan as text: quoted, or passed on by another script
], ids=["empty", "-Lan as text"])
def test_what_another_script_passes_on_is_understood(project, options, typed, lan):
    status, shown, calls = run(project, *options, typed=typed)
    assert status == 0, shown
    assert calls == [call.format(lan=lan) for call in START], shown


@pytest.mark.parametrize(("options", "typed", "named"), [
    (("-SkipBuild",), False, "-SkipBuild"),  # an option of 3.0.x
    (("--port", "4000"), True, "--port 4000"),
    (("-Lan", "$false"), True, "False"),  # meant as "off": refused rather than started on the network
], ids=["-SkipBuild", "--port 4000", "-Lan $false"])
def test_an_unknown_option_starts_nothing(project, options, typed, named):
    status, shown, calls = run(project, *options, typed=typed)
    assert status == 1, shown
    assert f"Unknown option: {named}. The only option is -Lan" in shown
    assert "Nothing was started." in shown
    assert calls == []


def test_a_changed_dependency_file_is_installed_again(project):
    (project / "backend" / "pyproject.toml").write_text('{"version": 2}', encoding="utf-8")
    # A change in letter case alone is a change.
    (project / "frontend" / "node_modules" / ".installed-package-lock.json").write_text('{"a": 1}', encoding="utf-8")
    (project / "frontend" / "package-lock.json").write_text('{"A": 1}', encoding="utf-8")
    status, shown, calls = run(project)
    assert status == 0, shown
    install = calls.pop(1)
    assert install.startswith("python -m pip install -q -e ") and install.rstrip('"').endswith("backend"), install
    assert calls == ["python -m pip --version", "python -m app --check", "npm ci", "npm run build", "python -m app"], shown
    # The stamps now hold what was installed, so the next start installs nothing.
    for source, stamp in [("backend/pyproject.toml", "backend/.venv/.installed-pyproject.toml"),
                          ("frontend/package-lock.json", "frontend/node_modules/.installed-package-lock.json")]:
        assert (project / stamp).read_bytes() == (project / source).read_bytes()


def test_the_module_folders_of_powershell_7_change_nothing(project):
    # What a Windows PowerShell inherits when a program run from PowerShell 7 starts it:
    # 7's Microsoft.PowerShell.Utility first, which Windows PowerShell cannot load.
    utility = project / "ps7-modules" / "Microsoft.PowerShell.Utility"
    utility.mkdir(parents=True)
    (utility / "Microsoft.PowerShell.Utility.psd1").write_text(
        "@{ ModuleVersion = '7.0.0.0'; CompatiblePSEditions = @('Core'); RootModule = 'missing.dll'\n"
        "   FunctionsToExport = @('Get-FileHash', 'Format-Hex'); CmdletsToExport = @() }\n", encoding="ascii")
    status, shown, calls = run(project, "-Lan", module_path=str(project / "ps7-modules"))
    assert status == 0, shown
    assert calls == [call.format(lan=" --lan") for call in START], shown


def test_a_command_that_cannot_run_stops_with_the_reason(project):
    for npm in (project / "bin").glob("npm.*"):
        npm.unlink()
    # The stand-ins and Windows itself, and no npm anywhere: Node.js is not installed.
    status, shown, calls = run(project, path=f"{project / 'bin'}{os.pathsep}{Path(os.environ['SystemRoot']) / 'System32'}")
    assert status == 1, shown
    assert "npm" in shown and "Nothing was started." in shown
    assert calls == ["python -m pip --version", "python -m app --check"]
