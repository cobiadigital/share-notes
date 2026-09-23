# share-notes

Cloudflare Worker serving `notes.cobia.dev`: every path is a plain-text note stored in D1.
See README.md for behavior and deploy details.

## Workflow for changes

The owner works from a phone with no terminal or local wrangler. Cloudflare Workers Builds
deploys automatically on every merge to `main`, so `main` is production.

1. Open a GitHub issue describing the change.
2. Create a branch for it from `main`, named `issue-<number>-<short-slug>`.
3. Commit, push, and open a PR into `main` that references the issue (`Closes #<number>`).
4. Run `npm run typecheck` (and test with `npm run dev` where relevant) before merging.
5. Merge the PR into `main`; that triggers the deploy.

Never commit directly to `main`.

## Notes

- No secrets in the repo. Optional Access JWT check uses dashboard Variables
  `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` (`keep_vars` preserves them across deploys).
- The `notes` table is created lazily on first request; there are no migrations to run.
