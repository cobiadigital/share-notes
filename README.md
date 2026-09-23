# share-notes

A tiny notepad on Cloudflare Workers. Visit `notes.cobia.dev/<anything>` and you get a
text box. Whatever you type is saved to D1 automatically, and the same URL shows the same
note from any device. There is no index page; the only list of notes is the D1 table itself.

## How it works

- `GET /<name>`: the editor. Names are case-insensitive, trailing slashes are ignored,
  and nesting like `/work/todo` is fine.
- `GET /`: redirects to a new note with a random 6-character name, e.g. `/k7m2qx`.
- `GET /<name>?raw`: the note as plain text (handy for `curl`).
- `GET /<name>?json`: `{ content, version, updated_at }`.
- `PUT /<name>` with `{ content, baseVersion, force? }`: save. Returns `409` with the
  server copy if someone else saved first.
- Autosaves ~0.7s after you stop typing, and keeps an unsaved draft in `localStorage`
  if you go offline.
- While a note is open and untouched, it checks for changes every 10s and whenever the
  tab regains focus, so edits from another device show up.
- If two devices edit at once, a banner offers **Load theirs** or **Keep mine**.
- Saving an empty note deletes its row.

## Deploy (Workers Builds, all from the dashboard, no local wrangler needed)

1. **Workers & Pages → Create → Import a repository**, connect GitHub, pick this repo.
   - Project name: `share-notes` (must match `name` in `wrangler.jsonc`).
   - Build command: *(leave empty)*. Deploy command: `npx wrangler deploy`.
   - Production branch: `main`. Under **Builds for non-production branches**, turn it off
     so only merges to `main` deploy.
2. Every push or merge to `main` now builds and deploys. On the first deploy, wrangler
   creates the `share-notes` D1 database and attaches the custom domain `notes.cobia.dev`
   (the `cobia.dev` zone must be in the same account). The `notes` table is created
   automatically on the first request. Build logs are under the Worker's **Deployments** tab.
3. **Zero Trust → Access → Applications → Add → Self-hosted**, domain `notes.cobia.dev`,
   with a policy allowing just you.

The `*.workers.dev` and preview URLs are turned off in `wrangler.jsonc`, so the only way in
is through Access.

### Optional: verify the Access token in the Worker

For defense in depth, add two **Variables** under Worker → Settings → Variables
(they aren't secret, and `keep_vars` keeps them across deploys):

| Name | Value |
| --- | --- |
| `ACCESS_TEAM_DOMAIN` | `yourteam.cloudflareaccess.com` |
| `ACCESS_AUD` | the Access application's *Application Audience (AUD) Tag* |

When both are set, any request without a valid Access JWT gets a 403.

### If the automatic D1 creation doesn't happen

Create a D1 database named `share-notes` in the dashboard, copy its ID, and add
`"database_id": "<id>"` to the `d1_databases` entry in `wrangler.jsonc`.

## Browsing all notes

Dashboard → D1 → `share-notes` → Console:

```sql
SELECT key, length(content) AS chars, datetime(updated_at / 1000, 'unixepoch') AS updated
FROM notes ORDER BY updated_at DESC;
```

## Local development

```sh
npm install
npm run dev      # http://localhost:8787, with a local D1
npm run typecheck
```
