#!/bin/sh
# ContextEngine CLI shim for git hooks. Install to /opt/homebrew/bin/contextengine.
#
#   cp scripts/contextengine-shim.sh /opt/homebrew/bin/contextengine
#   chmod +x /opt/homebrew/bin/contextengine
#
# [LOCKED] [HOOK_CLI_NEEDS_ITS_INTERPRETER_NOT_JUST_ITS_PATH] - 2026-09-04
# [NEVER] replace this shim with a bare symlink to the nvm-installed CLI, and
#         [NEVER] point it at a node version that is not installed.
# WHY: the shared pre-commit hook runs with a hardcoded
#      PATH="/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:$PATH" and takes the
#      policy branch only when `command -v contextengine` succeeds. The CLI lives
#      under nvm and its shebang is "#!/usr/bin/env node", so a plain symlink into
#      /opt/homebrew/bin makes the CLI RESOLVE while node stays unfindable: it dies
#      with "env: node: No such file or directory", exit 127, which the hook reads
#      as a policy failure and BLOCKS the commit. Measured 2026-09-04: before the
#      symlink the policy repos degraded SILENTLY to the legacy 4h timer (CE_CLI
#      empty); after it they hard-blocked in any commit context without nvm on PATH
#      (GUI git client, launchd, sanitized env). One symlink turned a silent
#      downgrade into a hard block on invoc.io and ContextEngine.
# FIX: ship the interpreter's directory with the CLI. Because the hook hardcodes
#      /opt/homebrew/bin, a shim there is reachable no matter what PATH the caller
#      had, which is what makes the policy path non-degradable. Verify any change
#      the way the hook actually runs, never from an interactive shell:
#        env -i HOME=$HOME PATH="/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin" \
#          /bin/zsh -c 'contextengine --version'
NVM_BIN="$HOME/.nvm/versions/node/v20.19.4/bin"
PATH="$NVM_BIN:$PATH"
export PATH
exec "$NVM_BIN/contextengine" "$@"
