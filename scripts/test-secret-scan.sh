#!/bin/bash
# Runs hooks/pre-commit's SECRET_PATTERNS against the fixture files.
# Exit 1 if any must-block line passes, or any must-pass line is blocked.
set -u
cd "$(dirname "$0")/.."
HOOK=hooks/pre-commit
# Extract the patterns array exactly as the hook defines it.
eval "$(sed -n '/^SECRET_PATTERNS=(/,/^)/p' "$HOOK")"
# Extract the allowlist if the hook defines one.
eval "$(grep -E '^SECRET_ALLOWLIST=' "$HOOK" || echo 'SECRET_ALLOWLIST=""')"

# Mirror the hook exactly: it sees diff lines, so every line carries a leading "+".
# Without that prefix this bench once passed while the real hook did not.
scan_line() {
  local line="+$1"
  for entry in "${SECRET_PATTERNS[@]}"; do
    local p="${entry%%:::*}"
    if echo "$line" | grep -E '^\+[^+]' | grep -iE "$p" | grep -qviE "$SECRET_ALLOWLIST"; then
      return 0
    fi
  done
  return 1
}

fail=0
while IFS= read -r l; do
  [[ -z "$l" ]] && continue
  if ! scan_line "$l"; then echo "MISSED (should block): $l"; fail=1; fi
done < tests/fixtures/secret-scan/must-block.txt
while IFS= read -r l; do
  [[ -z "$l" ]] && continue
  if scan_line "$l"; then echo "FALSE POSITIVE (should pass): $l"; fail=1; fi
done < tests/fixtures/secret-scan/must-pass.txt
[[ $fail -eq 0 ]] && echo "secret-scan fixtures: all good"
exit $fail
