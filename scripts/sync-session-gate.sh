#!/bin/bash
# Sync scripts/session-gate.sh (the Claude Code Stop hook) into every fleet repo, and wire it
# into that repo's .claude/settings.json.
#
# [LOCKED] [SESSION-GATE-ONE-SOURCE-COPIED-OUT] 2026-09-06
# [NEVER] hand-copy the gate, edit a repo's copy in place, overwrite a repo's settings.json, or
#         commit in another repo from here (their post-commit hooks push the owner's unpushed work).
# WHY: Yan: "why do I have to write 'check and update session and ce docs' systematically?" The
#      gate answers it for one repo; a rule that exists in one repo is not a rule for the fleet.
#      Same shape as sync-hooks.sh and sync-deploy-preflight.sh: one source, copied out, proved.
# FIX: --check is the default and writes nothing. --apply copies the script, merges one Stop entry
#      into .claude/settings.json (created if missing, other hooks kept), then PROVES the copy: an
#      old session must block (exit 2) and stop_hook_active must pass (exit 0).
#
# RETIRED 2026-09-06, same day, by 2.7.0: the gate now ships in the package (`contextengine
# session-gate`, src/session-gate.ts) and `contextengine install-claude-hook` wires one Stop entry
# at user scope, which covers every repo without a copy. The LOCK above keeps its WHY; the only
# live mode left is --remove, which takes the 33 copies and their Stop entries back out.
#
# Usage: scripts/sync-session-gate.sh            # report copies still present
#        scripts/sync-session-gate.sh --remove   # delete each repo's copy and its Stop entry (ours only)
#        scripts/sync-session-gate.sh --apply    # retired: refuses
set -u
if [ "${1:-}" = "--apply" ]; then echo "retired: the gate ships in the package since 2.7.0; run: contextengine install-claude-hook"; exit 1; fi
cd "$(dirname "$0")/.."
SRC="$PWD/scripts/session-gate.sh"
MODE="${1:---check}"
SRC_HASH=$( [ -f "$SRC" ] && (md5 -q "$SRC" 2>/dev/null || md5sum "$SRC" | cut -d' ' -f1) || echo retired )
SELF="$PWD"

merge_settings() { # $1 = repo dir; prints "added" | "present"
  node -e '
    const fs = require("fs"), path = require("path");
    const repo = process.argv[1], file = path.join(repo, ".claude", "settings.json");
    const cmd = "bash \"" + path.join(repo, "scripts", "session-gate.sh") + "\""; // quoted: two repo paths carry spaces
    let c = {};
    if (fs.existsSync(file)) { try { c = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { console.log("unparseable"); process.exit(0); } }
    c.hooks = c.hooks || {};
    const stop = Array.isArray(c.hooks.Stop) ? c.hooks.Stop : [];
    const present = stop.some((e) => (e.hooks || []).some((h) => String(h.command || "").includes("session-gate.sh")));
    if (present) { console.log("present"); process.exit(0); }
    stop.push({ hooks: [{ type: "command", command: cmd }] });
    c.hooks.Stop = stop;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(c, null, 2) + "\n");
    console.log("added");
  ' "$1"
}

remove_entry() { # $1 = repo dir; prints removed | absent
  node -e '
    const fs = require("fs"), path = require("path");
    const file = path.join(process.argv[1], ".claude", "settings.json");
    if (!fs.existsSync(file)) { console.log("absent"); process.exit(0); }
    let c; try { c = JSON.parse(fs.readFileSync(file, "utf8")); } catch { console.log("absent"); process.exit(0); }
    const stop = (c.hooks && c.hooks.Stop) || [];
    const kept = stop.filter((e) => !(e.hooks || []).some((h) => String(h.command || "").includes("scripts/session-gate.sh")));
    if (kept.length === stop.length) { console.log("absent"); process.exit(0); }
    if (kept.length) c.hooks.Stop = kept; else delete c.hooks.Stop;
    if (c.hooks && Object.keys(c.hooks).length === 0) delete c.hooks;
    if (Object.keys(c).length === 0) fs.unlinkSync(file); else fs.writeFileSync(file, JSON.stringify(c, null, 2) + "\n");
    console.log("removed");
  ' "$1"
}

current=0; todo=0; failed=0; applied=0; removed=0
for d in "$HOME"/Projects/*/ "$HOME/COMPR" "$HOME/FASTPROD"; do
  d="${d%/}"; name="$(basename "$d")"
  [ "$d" = "$SELF" ] && continue
  git -C "$d" rev-parse --git-dir >/dev/null 2>&1 || continue
  copy="$d/scripts/session-gate.sh"; settings="$d/.claude/settings.json"
  if [ -f "$copy" ]; then h=$(md5 -q "$copy" 2>/dev/null || md5sum "$copy" | cut -d' ' -f1); [ "$h" = "$SRC_HASH" ] && cstate="current" || cstate="drifted"; else cstate="missing"; fi
  grep -q "session-gate.sh" "$settings" 2>/dev/null && wstate="wired" || wstate="unwired"
  ign=""; git -C "$d" check-ignore -q .claude/settings.json 2>/dev/null && ign=" (settings gitignored: local only)"
  if [ "$MODE" = "--remove" ]; then
    r="nothing"; [ -f "$copy" ] && { rm -f "$copy"; r="copy"; }
    e=$(remove_entry "$d"); [ "$e" = "removed" ] && r="$r+entry"
    rmdir "$d/scripts" 2>/dev/null; rmdir "$d/.claude" 2>/dev/null
    printf "  🧹 %-26s %s\n" "$name" "$r"; [ "$r" != "nothing" ] && ((removed++)); continue
  fi
  if [ "$cstate" = "current" ] && [ "$wstate" = "wired" ]; then printf "  ✅ %-26s current, wired%s\n" "$name" "$ign"; ((current++)); continue; fi
  if [ "$MODE" != "--apply" ]; then printf "  ⚠  %-26s copy %s, %s%s\n" "$name" "$cstate" "$wstate" "$ign"; ((todo++)); continue; fi
  mkdir -p "$d/scripts" && cp "$SRC" "$copy" && chmod +x "$copy" || { printf "  ❌ %-26s copy failed\n" "$name"; ((failed++)); continue; }
  m=$(merge_settings "$d")
  [ "$m" = "unparseable" ] && { printf "  ❌ %-26s .claude/settings.json is not JSON; not touched\n" "$name"; ((failed++)); continue; }
  # Prove the copy in its new home: an old session blocks, the loop guard passes.
  old=$(mktemp); touch -t 202601010000 "$old"
  echo '{"stop_hook_active":false}' | CE_GATE_SESSION_FILE="$old" CLAUDE_PROJECT_DIR="$d" bash "$copy" >/dev/null 2>&1; r1=$?
  echo '{"stop_hook_active":true}'  | CE_GATE_SESSION_FILE="$old" CLAUDE_PROJECT_DIR="$d" bash "$copy" >/dev/null 2>&1; r2=$?
  rm -f "$old"
  if [ $r1 -eq 2 ] && [ $r2 -eq 0 ]; then printf "  ✅ %-26s copied, settings %s, proved (block=2, guard=0)%s\n" "$name" "$m" "$ign"; ((applied++)); else printf "  ❌ %-26s copied but the proof failed (block=%s, guard=%s)\n" "$name" "$r1" "$r2"; ((failed++)); fi
done
[ "$MODE" = "--remove" ] && { echo "removed from $removed repo(s)"; exit 0; }
echo "current=$current  $( [ "$MODE" = "--apply" ] && echo applied=$applied || echo todo=$todo )  failed=$failed"
[ "$MODE" != "--apply" ] && [ $todo -gt 0 ] && echo "Copies are retired: the gate comes from 'contextengine install-claude-hook' (user scope). Run --remove to clean any copy left."
[ $failed -eq 0 ]
