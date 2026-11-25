#!/usr/bin/env bash
# Claude Code PreToolUse hook (Bash): a branch is only reset to main or
# force-pushed through scripts/sync-after-merge.sh, which first checks that the
# branch's pull request was merged. Exit 2 blocks the command; stderr tells why.
cmd=$(python3 -c 'import sys,json; print(json.load(sys.stdin).get("tool_input",{}).get("command",""))' 2>/dev/null)
case "$cmd" in
  *sync-after-merge.sh*) exit 0 ;;
esac
if printf '%s' "$cmd" | grep -Eq 'git[^|;&]* push[^|;&]*(--force|--force-with-lease|[[:space:]]-f([[:space:]]|$)|[[:space:]]\+)' \
   || printf '%s' "$cmd" | grep -Eq 'git[^|;&]* (checkout|switch)[^|;&]* -[BC][^|;&]*origin/main' \
   || printf '%s' "$cmd" | grep -Eq 'git[^|;&]* reset[^|;&]*--hard[^|;&]*origin/main'; then
  echo "Blocked: reset a branch to main / force-push only with scripts/sync-after-merge.sh, after the merge result says merged: true." >&2
  exit 2
fi
exit 0
