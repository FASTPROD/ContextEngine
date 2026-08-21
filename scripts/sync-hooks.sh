#!/bin/bash
# Sync hooks/pre-commit into every local repo that carries the CE secret scanner.
#
# [LOCKED] [SYNC-REPLACES-NEVER-APPENDS] - 2026-08-21
# [NEVER] append hooks/pre-commit to an existing hook, and [NEVER] write a hook
#         without proving afterwards that it blocks.
# WHY: the scanner reached 26 repos by hand. Two of them, invocme-odoo-connector and
#      fc-hf-docker, received it by append, behind an earlier unconditional `exit 0`,
#      so 120 lines of scanner never ran there while looking deployed. A deploy that
#      cannot verify itself is the mechanism that produced that state.
# FIX: --check is the default and writes nothing. --apply replaces the whole file,
#      keeps a dated backup beside it, then stages a fake secret in that repo and
#      confirms the new hook refuses it. A repo where that proof fails is reported,
#      and its backup is restored.
#
# Usage: scripts/sync-hooks.sh            # report drift, write nothing
#        scripts/sync-hooks.sh --apply    # replace drifted hooks, verify each
set -u
cd "$(dirname "$0")/.."
SRC="$PWD/hooks/pre-commit"
MODE="${1:---check}"
SRC_HASH=$(md5 -q "$SRC" 2>/dev/null || md5sum "$SRC" | cut -d' ' -f1)

# Marker every CE scanner carries, old or new. Repos without it are not ours.
MARKER='Cr0wlr_Pr0d_'

# Repos whose hook carries local logic beyond the scanner. Listed so the operator
# knows what the replacement drops; each one was checked by hand before listing.
# PLANK.io's settings.json gate was ported into the common hook on 2026-08-21, so it
# no longer loses anything. Empty today; keep the mechanism.
declare -a KNOWN_LOCAL_LOGIC=()

updated=0; current=0; failed=0; skipped=0
for d in "$HOME"/Projects/*/ "$HOME/COMPR" "$HOME/FASTPROD"; do
  [ -d "$d/.git" ] || continue
  h="$d/.git/hooks/pre-commit"
  [ -f "$h" ] || continue
  grep -q "$MARKER" "$h" || continue
  name=$(basename "$d")
  [ "$name" = "ContextEngine" ] && continue

  cur_hash=$(md5 -q "$h" 2>/dev/null || md5sum "$h" | cut -d' ' -f1)
  if [ "$cur_hash" = "$SRC_HASH" ]; then
    printf "  ✅ %-28s current\n" "$name"; ((current++)); continue
  fi

  dead=""
  first_exit=$(grep -n '^exit 0' "$h" | head -1 | cut -d: -f1)
  total=$(wc -l < "$h" | tr -d ' ')
  [ -n "$first_exit" ] && [ "$first_exit" -lt "$total" ] && dead=" (DEAD CODE after line $first_exit)"
  local_note=""
  # ${arr[@]+"${arr[@]}"} is the bash 3.2 idiom for "expand, or nothing if empty":
  # under set -u a plain "${arr[@]}" on an empty array aborts with "unbound variable".
  # This exact line killed the first real --apply before its first loop iteration.
  for k in ${KNOWN_LOCAL_LOGIC[@]+"${KNOWN_LOCAL_LOGIC[@]}"}; do [ "$k" = "$name" ] && local_note=" [drops local logic, see script header]"; done

  if [ "$MODE" != "--apply" ]; then
    printf "  ⚠️  %-28s drifted%s%s\n" "$name" "$dead" "$local_note"; ((updated++)); continue
  fi

  # --apply: replace, then prove.
  bak="$h.bak.$(date +%Y%m%d-%H%M%S)"
  cp "$h" "$bak"
  cp "$SRC" "$h" && chmod +x "$h"

  # Proof: stage a synthetic secret and run the hook directly. Never commit.
  # The probe line is assembled at runtime so this script's own source never
  # contains a literal the scanner would refuse to commit.
  probe="$d/.ce-scan-probe.$$"
  key="db_pass""word"
  printf '%s: Pr0be%sS3cret\n' "$key" "$$" > "$probe"
  # Two conditions, both required: the hook exits non-zero AND its output names the
  # secret scanner. Exit code alone is not proof: in a repo missing its CE docs the
  # doc-freshness phase also blocks, and a probe with a code extension would have
  # "passed" this check for the wrong reason. The probe carries no code extension for
  # the same reason; keep it that way.
  hook_out=$( cd "$d" && git add -f "$(basename "$probe")" >/dev/null 2>&1 && .git/hooks/pre-commit 2>&1 )
  rc=$?
  ( cd "$d" && git reset -q HEAD "$(basename "$probe")" >/dev/null 2>&1 )
  rm -f "$probe"

  if [ $rc -ne 0 ] && echo "$hook_out" | grep -q "SECRET SCANNER"; then
    printf "  ✅ %-28s replaced, blocks a planted secret%s%s\n" "$name" "$dead" "$local_note"; ((updated++))
  else
    cp "$bak" "$h"
    printf "  ❌ %-28s new hook did NOT block the probe, backup restored\n" "$name"; ((failed++))
  fi
done

echo
echo "current=$current  $( [ "$MODE" = "--apply" ] && echo replaced || echo drifted )=$updated  failed=$failed"
[ "$MODE" != "--apply" ] && [ $updated -gt 0 ] && echo "Run with --apply to replace them." 
[ $failed -eq 0 ] || exit 1
