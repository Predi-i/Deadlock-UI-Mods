"""Run source-only regressions without the native compiler or VPK filesystem tests."""
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]


def main():
    for pattern in ("test_*update*.py", "test_native_review_workflow.py",
                    "test_hud_dumper_receiver.py"):
        subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "tools/tests", "-p", pattern],
                       cwd=ROOT, check=True)
    subprocess.run(["node", "tools/tests/runtime_regressions.cjs"], cwd=ROOT, check=True)
    subprocess.run(["node", "--test", "HUD-Dumper/tests/hud_dumper.test.cjs"], cwd=ROOT, check=True)
    for mode in ([], ["--delayed-layout"], ["--old-layout"], ["--modern-layout"], ["--wrapped-effects"]):
        subprocess.run(["node", "Djinn-Mark-In-TopBar/tests/djinn_mark.test.cjs", *mode], cwd=ROOT, check=True)


if __name__ == "__main__":
    main()
