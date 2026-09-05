#!/usr/bin/env bash
# deploy-preflight.sh — shared guard: never ship what is not committed.
#
# Source it from a deploy script, then call ONE of the three checks below, chosen by
# what that script actually ships. Distributed to the fleet the same way sync-hooks.sh
# distributes the git hook: one source of truth here, copied into each repo.
#
# ── Why this exists ───────────────────────────────────────────────────────────
# The global CLAUDE.md multi-tenant deploy rule has always said: "Commit the script
# BEFORE running it the first time (so there's a rollback for the script itself)."
# On 2026-09-05 two separate agent sessions broke that rule on the same day, in two
# different repos, independently. Both then hit their deploy script's own drift guard,
# because the server held content matching no commit, and neither could follow the
# printed fix: one reconciliation commit was rejected by the secret scanner, and the
# target directory was root-owned, so the owner had to run a privileged delete by hand.
#
# The rule was loaded in context both times and simply not applied. A third restatement
# of the rule would not have helped. This is the check.
#
# [LOCKED] [DEPLOY_ONLY_COMMITTED] — 2026-09-05
# [NEVER] call these with an unconditional override, and never "fix" a refusal by
#         deleting the call. The override exists to be typed deliberately by a human.
# WHY: an uncommitted deploy has NO rollback for the shipped content, and afterwards
#      nothing can say which commit the server is running, which is the entire purpose
#      of every drift check in this fleet.
# FIX: commit first. It costs seconds and it is what makes the drift check answerable.
#
# ── Which check to use ────────────────────────────────────────────────────────
#   ships named source files            -> deploy_preflight_files "$REPO_ROOT" f1 f2 ...
#   ships a BUILT artifact (dist/, out/) -> deploy_preflight_tree  "$REPO_ROOT" [subdir]
#   server pulls from git itself         -> deploy_preflight_pushed "$REPO_ROOT" [remote] [branch]
#
# All three return 0 when clean and print a refusal and return 1 when not. The caller
# decides whether to exit; the recommended caller line is:
#   deploy_preflight_files "$REPO_ROOT" "${FILES[@]}" || exit 1
#
# Every check is skipped when ALLOW_UNCOMMITTED=1 is exported, which is the deliberate
# human exception. Each check SAYS SO when it skips, so a skip is never silent.

_dp_red() { printf '\033[0;31m%s\033[0m\n' "$1"; }

_dp_skip_note() {
  echo ""
  _dp_red "  [deploy-preflight] SKIPPED by ALLOW_UNCOMMITTED=1 — you are shipping uncommitted content on purpose."
  echo ""
}

# ── ships named source files ──────────────────────────────────────────────────
# Refuses an untracked file, and a tracked file with uncommitted changes.
deploy_preflight_files() {
  local root="$1"; shift
  if [ "${ALLOW_UNCOMMITTED:-0}" = "1" ]; then _dp_skip_note; return 0; fi
  local bad=""
  local f
  for f in "$@"; do
    if ! git -C "$root" ls-files --error-unmatch "$f" >/dev/null 2>&1; then
      bad="$bad
    $f  (untracked, never committed)"
    elif ! git -C "$root" diff --quiet HEAD -- "$f" 2>/dev/null; then
      bad="$bad
    $f  (committed, but has uncommitted changes)"
    fi
  done
  if [ -n "$bad" ]; then
    echo ""
    _dp_red "═══════════════════════════════════════════════════════════"
    _dp_red "  DEPLOY BLOCKED — file(s) not committed"
    _dp_red "═══════════════════════════════════════════════════════════"
    printf '%s\n' "$bad"
    echo ""
    echo "  Commit first, so the shipped content has a rollback and so the drift"
    echo "  check can later say WHICH commit the server is running."
    echo "  Deliberate exception: ALLOW_UNCOMMITTED=1 $0 ..."
    return 1
  fi
  return 0
}

# ── ships a BUILT artifact ────────────────────────────────────────────────────
# The artifact itself is gitignored, so checking it would refuse every deploy. What
# matters is the SOURCE the bundle was built from: if the working tree is dirty, the
# deployed bundle corresponds to no commit and nothing can ever identify it again.
# Optional second argument narrows the check to a subdirectory (e.g. "src").
deploy_preflight_tree() {
  local root="$1"; local sub="${2:-}"
  if [ "${ALLOW_UNCOMMITTED:-0}" = "1" ]; then _dp_skip_note; return 0; fi
  local dirty
  if [ -n "$sub" ]; then
    dirty=$(git -C "$root" status --porcelain -- "$sub" 2>/dev/null)
  else
    dirty=$(git -C "$root" status --porcelain 2>/dev/null)
  fi
  if [ -n "$dirty" ]; then
    echo ""
    _dp_red "═══════════════════════════════════════════════════════════"
    _dp_red "  DEPLOY BLOCKED — source tree has uncommitted changes"
    _dp_red "═══════════════════════════════════════════════════════════"
    printf '%s\n' "$dirty" | head -20
    echo ""
    echo "  This deploy ships a BUILT bundle. A bundle built from a dirty tree"
    echo "  matches no commit, so nothing can ever say what is running in production."
    echo "  Commit first, then build, then deploy."
    echo "  Deliberate exception: ALLOW_UNCOMMITTED=1 $0 ..."
    return 1
  fi
  return 0
}

# ── server pulls from git itself ──────────────────────────────────────────────
# Uncommitted work cannot reach the server by construction. The real risk here is the
# opposite one: deploying while your commit is not PUSHED, so the server pulls older
# code than you think and the deploy silently does nothing.
deploy_preflight_pushed() {
  local root="$1"; local remote="${2:-origin}"; local branch="${3:-}"
  if [ "${ALLOW_UNCOMMITTED:-0}" = "1" ]; then _dp_skip_note; return 0; fi
  [ -n "$branch" ] || branch=$(git -C "$root" rev-parse --abbrev-ref HEAD 2>/dev/null)
  local dirty; dirty=$(git -C "$root" status --porcelain 2>/dev/null)
  local local_sha remote_sha
  local_sha=$(git -C "$root" rev-parse HEAD 2>/dev/null)
  git -C "$root" fetch "$remote" "$branch" >/dev/null 2>&1
  remote_sha=$(git -C "$root" rev-parse "$remote/$branch" 2>/dev/null)
  if [ -n "$dirty" ] || [ "$local_sha" != "$remote_sha" ]; then
    echo ""
    _dp_red "═══════════════════════════════════════════════════════════"
    _dp_red "  DEPLOY BLOCKED — the server pulls from $remote/$branch, which is not what you have"
    _dp_red "═══════════════════════════════════════════════════════════"
    [ -n "$dirty" ] && { echo "  uncommitted changes:"; printf '%s\n' "$dirty" | head -10; }
    [ "$local_sha" != "$remote_sha" ] && {
      echo "  local  HEAD : ${local_sha:-unknown}"
      echo "  $remote/$branch : ${remote_sha:-unknown (not fetched?)}"
      echo "  The server would pull the remote one, not yours."
    }
    echo ""
    echo "  Commit and push first."
    echo "  Deliberate exception: ALLOW_UNCOMMITTED=1 $0 ..."
    return 1
  fi
  return 0
}
