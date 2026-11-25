#!/usr/bin/env bash
# Reset the working branch to main after its pull request was merged.
#
# Refuses while the branch still holds work main doesn't have. On 25 November
# the reset ran next to a merge that had failed: the branch was reset to main, its
# pull request had nothing left to merge and GitHub closed it. With this check
# that reset stops with an error instead.
#
# Merged means: the branch's commit is in main (merge or rebase), or main has the
# same tree (squash merge, the branch then has nothing main doesn't).
#
# Usage: scripts/sync-after-merge.sh [branch]   (default: the current branch)
set -euo pipefail

branch="${1:-$(git rev-parse --abbrev-ref HEAD)}"
if [ "$branch" = "main" ] || [ "$branch" = "HEAD" ]; then
  echo "sync-after-merge: name the working branch, not '$branch'" >&2
  exit 2
fi

git fetch -q origin main
remote="origin/$branch"
if git fetch -q origin "$branch" 2>/dev/null; then
  if ! git merge-base --is-ancestor "$remote" origin/main \
     && ! git diff --quiet origin/main "$remote"; then
    echo "sync-after-merge: REFUSED — $remote has changes that are not in main:" >&2
    git diff --stat origin/main "$remote" >&2 || true
    echo "Merge its pull request first (and read the result: merged: true), then run this again." >&2
    exit 1
  fi
fi

# Local commits that were never pushed would be lost by the reset as well.
if git rev-parse -q --verify "refs/heads/$branch" >/dev/null; then
  if ! git merge-base --is-ancestor "$branch" origin/main \
     && ! git diff --quiet origin/main "$branch" \
     && ! { git rev-parse -q --verify "$remote" >/dev/null && git merge-base --is-ancestor "$branch" "$remote"; }; then
    echo "sync-after-merge: REFUSED — local $branch has commits that are neither pushed nor in main." >&2
    exit 1
  fi
fi

git checkout -q -B "$branch" origin/main
git push -q --force-with-lease origin "$branch"
echo "sync-after-merge: $branch = origin/main ($(git rev-parse --short origin/main))"
