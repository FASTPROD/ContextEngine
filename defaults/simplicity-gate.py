#!/usr/bin/env python3
"""OpsContext simplicity gate: a Claude Code PostToolUse hook (Edit, Write, MultiEdit).

Reads the hook JSON on stdin, runs ruff's complexity rules (C901, PLR0911, PLR0912, PLR0915)
on the edited Python file and on the same file at git HEAD, and exits 2 (stderr goes back to
Claude) only for functions that are new offenders or got worse. Installed by
`opscontext install-claude-hook --simplicity`; removed by `uninstall-claude-hook --simplicity`.

[LOCKED] [SIMPLICITY-GATE-SILENT-WHEN-BLIND] 2026-09-17
[NEVER] exit 2 for complexity that was already there at HEAD, or when ruff, git, the file or
        the input cannot be read. A gate that nags about code the edit did not touch, or that
        fails when a tool is missing, gets disabled and then protects nothing.
WHY: the 2026-09-15 bake-off on KONIVE: three simplification tools cut branches, none cut
     lines, and a guidelines-only pass deleted a function a newer commit used. Only a diff
     against HEAD, per (rule, function), tells "this edit made it worse" from "it was like that".
FIX: compare per (rule, function) against HEAD; every blind path returns 0 with no output.
     ruff is looked up in SIMPLICITY_RUFF, then PATH, then the usual install dirs, because
     Claude Code runs hooks without the user's shell PATH.
"""
import ast
import json
import os
import re
import shutil
import subprocess
import sys

RULES = "C901,PLR0911,PLR0912,PLR0915"


def find_ruff():
    """ruff to run: SIMPLICITY_RUFF, then PATH, then where brew, pipx and cargo put it."""
    env = os.environ.get("SIMPLICITY_RUFF")
    if env:
        return env
    on_path = shutil.which("ruff")
    if on_path:
        return on_path
    home = os.path.expanduser("~")
    for candidate in (
        "/opt/homebrew/bin/ruff",
        "/usr/local/bin/ruff",
        os.path.join(home, ".local", "bin", "ruff"),
        os.path.join(home, ".cargo", "bin", "ruff"),
    ):
        if os.access(candidate, os.X_OK):
            return candidate
    return "ruff"  # run() then fails with OSError and the gate stays silent


RUFF = find_ruff()


def run(cmd, **kwargs):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, **kwargs)
    except OSError:
        return None


def def_names(source):
    """Map a def line number to its function name."""
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return {}
    return {n.lineno: n.name for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}


def violations(path, source):
    """{(rule, function): (value, message)}; None when ruff cannot run."""
    if not source:
        return {}
    done = run([RUFF, "check", "--no-cache", "--select", RULES, "--output-format", "json",
                "--stdin-filename", path, "-"], input=source)
    if done is None:
        return None
    try:
        items = json.loads(done.stdout or "[]")
    except ValueError:
        return None
    names = def_names(source)
    found = {}
    for v in items:
        if v.get("code") not in RULES.split(","):
            continue  # ruff always reports syntax errors; a half-written file is not "complex"
        row = (v.get("location") or {}).get("row")
        numbers = re.findall(r"\((\d+) > \d+\)", v.get("message", ""))
        found[(v.get("code"), names.get(row, f"line {row}"))] = (int(numbers[0]) if numbers else 0, v.get("message", ""))
    return found


def head_source(path):
    """File content at HEAD; "" when the file is new; None when not inside a git repo."""
    top = run(["git", "-C", os.path.dirname(path) or ".", "rev-parse", "--show-toplevel"])
    if top is None or top.returncode != 0:
        return None
    root = top.stdout.strip()
    rel = os.path.relpath(os.path.realpath(path), os.path.realpath(root))
    shown = run(["git", "-C", root, "show", f"HEAD:{rel}"])
    return shown.stdout if shown is not None and shown.returncode == 0 else ""


def main():
    try:
        event = json.load(sys.stdin)
    except ValueError:
        return 0
    path = (event.get("tool_input") or {}).get("file_path", "")
    if not path.endswith(".py") or not os.path.isfile(path):
        return 0
    baseline = head_source(path)
    if baseline is None:
        return 0
    with open(path, encoding="utf-8", errors="replace") as fh:
        now = violations(path, fh.read())
    before = violations(path, baseline)
    if now is None or before is None:
        return 0
    worse = [key for key, (value, _) in now.items() if key not in before or value > before[key][0]]
    if not worse:
        return 0
    lines = "\n".join(f"- {name}: {now[(code, name)][1]}" for code, name in worse)
    print(
        f"Simplicity gate: your edit of {os.path.basename(path)} made these functions more complex than the limit:\n"
        f"{lines}\n"
        "Simplify them now without changing behavior (early returns, a lookup table instead of branches, "
        "split one job per function). Keep every LOCK comment. Do not touch functions you did not edit.",
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    sys.exit(main())
