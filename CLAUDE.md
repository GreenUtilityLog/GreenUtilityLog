# Working on GreenUtilityLog

Answer the owner in Dutch. Code, commits and pull requests are in English.

## Shipping a change — strictly in this order, one step at a time

Never run two of these steps in parallel. Each step starts only after the result
of the previous one has been read.

1. Test the fix both ways: the new test fails without the fix and passes with it.
   Run the whole suite (`cd server && npm test`, and the app/e2e tests it touches).
2. Commit and push the working branch, then open the pull request.
3. Wait until **every** check on the head commit is completed and green. A job
   stuck in the queue (no runner, e.g. macOS) is not ours to wait out: cancel the
   run yourself before GitHub fails it and mails the owner, then run it again.
   Windows/macOS bridge tests run only on PRs that touch the bridge
   (`bridge-desktop.yml`); Server tests is the check Render's deploy waits for.
4. Squash merge with the **full 40-character** head SHA as `expectedHeadSha`.
   Read the result. Go on only if it says `merged: true`.
5. Only then: `scripts/sync-after-merge.sh`. It refuses while the branch holds
   work that main doesn't have. A hook (`scripts/guard-git.sh`) blocks any other
   force-push or reset to main.
6. Verify on main: Server tests, End-to-end, and Deploy to GitHub Pages
   (build → assemble → deploy) are all green for the merge commit.
7. Dispatch `watchdog.yml` and read its SNAPSHOT annotation: `commit` must be the
   last commit that changed `server/` (`git log -1 --format=%h -- server`; Render
   builds from `rootDir: server` and skips other commits), and there must be no
   error or warning annotations. Wait a few minutes after a server change for the
   deploy before reading it.
8. Only then report done. Update `docs/OPEN-ITEMS.md` when something opens or closes.

## Never

- Put keys, mnemonics or tokens in chat or git. The distributor key lives only in Render.
- Put model names or ids in commits or pull requests.
