#!/bin/bash
# Sync scripts/deploy-preflight.sh into every fleet repo whose deploy script sources it.
#
# [LOCKED] [PREFLIGHT-ONE-SOURCE-COPIED-OUT] - 2026-09-05
# [NEVER] edit a repo's copy of deploy-preflight.sh in place, and [NEVER] hand-copy it.
# WHY: a deploy runs outside git, so the git-hook path (sync-hooks.sh) cannot carry this
#      guard. Same pattern, different target: one source of truth here, copied into each
#      repo, sourced by that repo's deploy script. Seven hand copies drift; the owner's own
#      recorded reasoning when declining a per-repo lock inventory (global CLAUDE.md,
#      2026-08-21) says exactly that.
# FIX: --check is the default and writes nothing. --apply replaces the copy, then PROVES it
#      by planting an untracked file in that repo and confirming the copied check refuses
#      it. A copy that cannot prove itself is reported and rolled back.
#
# Usage: scripts/sync-deploy-preflight.sh            # report drift, write nothing
#        scripts/sync-deploy-preflight.sh --apply    # replace drifted copies, prove each
set -u
cd "$(dirname "$0")/.."
SRC="$PWD/scripts/deploy-preflight.sh"
MODE="${1:---check}"
SRC_HASH=$(md5 -q "$SRC" 2>/dev/null || md5sum "$SRC" | cut -d' ' -f1)

# repo | deploy script that must source the copy. ContextEngine itself sources the
# original (server/deploy.sh), so it is not a target. bash 3.2: no declare -A.
TARGETS="compR.fr|deploy.sh
PLANK.io|scripts/deploy_backend.sh
app.CROWLR|scripts/deploy_frontend.sh
COMPR-app|scripts/deploy_frontend.sh
invoc.io|deploy.sh
admin.CROWLR|scripts/deploy_backend.sh"

current=0; drifted=0; failed=0
while IFS='|' read -r name script; do
  [ -n "$name" ] || continue
  d="$HOME/Projects/$name"
  [ -d "$d/.git" ] || { printf "  ❌ %-14s not a git repo at %s\n" "$name" "$d"; ((failed++)); continue; }
  copy="$d/scripts/deploy-preflight.sh"
  sourced="sourced by $script"
  grep -q "deploy-preflight.sh" "$d/$script" 2>/dev/null || sourced="NOT sourced by $script"

  cur_hash="none"
  [ -f "$copy" ] && cur_hash=$(md5 -q "$copy" 2>/dev/null || md5sum "$copy" | cut -d' ' -f1)
  if [ "$cur_hash" = "$SRC_HASH" ]; then
    tracked="committed"
    git -C "$d" ls-files --error-unmatch scripts/deploy-preflight.sh >/dev/null 2>&1 || tracked="NOT COMMITTED, commit it"
    printf "  ✅ %-14s current, %s, %s\n" "$name" "$sourced" "$tracked"; ((current++)); continue
  fi
  if [ "$MODE" != "--apply" ]; then
    printf "  ⚠️  %-14s %s, %s\n" "$name" "$( [ "$cur_hash" = none ] && echo missing || echo drifted )" "$sourced"; ((drifted++)); continue
  fi

  # --apply: replace, then prove.
  mkdir -p "$d/scripts"
  bak=""
  if [ -f "$copy" ]; then bak="$copy.bak.$(date +%Y%m%d-%H%M%S)"; cp "$copy" "$bak"; fi
  cp "$SRC" "$copy" && chmod +x "$copy"

  # Proof: an untracked file in that repo must be refused by the COPIED check. Never a
  # commit, never a deploy. Exit code alone is not proof: the output must name the block.
  probe=".deploy-preflight-probe.$$"
  echo probe > "$d/$probe"
  out=$( cd "$d" && . "./scripts/deploy-preflight.sh" && deploy_preflight_files "$d" "$probe" 2>&1 ); rc=$?
  rm -f "$d/$probe"
  if [ $rc -ne 0 ] && echo "$out" | grep -q "DEPLOY BLOCKED"; then
    [ -n "$bak" ] && rm -f "$bak"
    printf "  ✅ %-14s copied, refuses an untracked file, %s\n" "$name" "$sourced"; ((drifted++))
  else
    if [ -n "$bak" ]; then cp "$bak" "$copy"; rm -f "$bak"; else rm -f "$copy"; fi
    printf "  ❌ %-14s copy did NOT refuse the probe (rc=%s), rolled back\n" "$name" "$rc"; ((failed++))
  fi
done <<< "$TARGETS"

echo
echo "current=$current  $( [ "$MODE" = "--apply" ] && echo replaced || echo drifted )=$drifted  failed=$failed"
[ "$MODE" != "--apply" ] && [ $drifted -gt 0 ] && echo "Run with --apply to copy them, then commit each repo's scripts/deploy-preflight.sh."
[ $failed -eq 0 ] || exit 1
