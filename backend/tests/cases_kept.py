"""Whether the engine's recorded cases of a commit are all still there, unchanged.

``python tests/cases_kept.py <commit>`` from backend/: every case of ``tests/cases/*.json`` as it
was at <commit>, found by (fn, name), exists today with the same input and the same expected
output (compared as JSON). Cases may be added; none is removed or rewritten, because the two
engines and the requests an update sends are held by them. Prints ``kept: <n> cases of <commit>``
and exits 0, or prints each case that is missing or changed and exits 1.
"""

import json
import subprocess
import sys
from pathlib import Path

CASES = Path(__file__).resolve().parent / "cases"


def git(*args: str) -> str:
    done = subprocess.run(["git", *args], cwd=CASES, capture_output=True, text=True,
                          encoding="utf-8", check=False)
    if done.returncode:
        sys.exit(f"git {' '.join(args)}: {done.stderr.strip()}")
    return done.stdout


def canonical(value) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False)


def main(commit: str) -> int:
    top = Path(git("rev-parse", "--show-toplevel").strip())
    folder = CASES.relative_to(top).as_posix()
    files = [name for name in git("ls-tree", "--full-tree", "--name-only", commit, f"{folder}/").split("\n")
             if name.endswith(".json")]
    if not files:
        sys.exit(f"no case file at {commit} under {folder}")
    kept, wrong = 0, []
    for name in files:
        before = json.loads(git("show", f"{commit}:{name}"))["cases"]
        path = CASES / Path(name).name
        now = {}
        if path.exists():
            for case in json.loads(path.read_text(encoding="utf-8"))["cases"]:
                now[(case["fn"], case["name"])] = case
        for case in before:
            key = (case["fn"], case["name"])
            there = now.get(key)
            if (there is None or canonical(there["input"]) != canonical(case["input"])
                    or canonical(there["expected"]) != canonical(case["expected"])):
                wrong.append((Path(name).name, *key))
            else:
                kept += 1
    if wrong:
        for file, fn, name in wrong:
            print(f"missing or changed: {file} {fn} {name!r}")
        return 1
    print(f"kept: {kept} cases of {commit}")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: python tests/cases_kept.py <commit>")
    sys.exit(main(sys.argv[1]))
