# NanoClaw operations dashboard

Build the host and launch the separate read-only process:

```sh
npm run build
npm run dashboard
```

Open http://127.0.0.1:4690. Node 22.5+ is required by the upstream dashboard.
Use `PORT=4691 npm run dashboard` if the default port is busy. The fork launcher
always binds localhost; `BIND` and `CLIDASH_CONFIG` do not override it.
For a remote installation, use an SSH tunnel to the chosen deployment host:

```sh
ssh -N -L 4690:127.0.0.1:4690 USER@HOST
```

## Views and interpretation

- Tasks: schedules, next/last run, capability profile, runtime budget, claim age.
  Claimed means reserved, not proof that a container is currently executing it.
- Runs: latest 500 outcomes and durations; inspect private host logs for details.
- Souls: identity, parent, lifecycle state and timestamps.
- Bets: latest 500 titles and statuses; full bodies remain private.
- Containers: Docker containers whose names start with `nanoclaw-`. This is a
  separate observation, not a task-to-container join or service health check.

The UI refreshes every 60 seconds and shows collection times. Rows are bounded
to 500 per view; counts summarize the displayed snapshot. Missing databases,
optional tables, lock contention, or unavailable Docker display errors rather
than healthy empty results. Last successful snapshots are marked when stale.

The data CLI uses this checkout's `store/messages.db`, opens it read-only, and
never imports the host bootstrap or initializes a database. It exposes no SQL,
mutation commands, prompts, credentials, claim tokens, full results, or raw
errors. Bet titles and operational metadata are still private information.
Localhost binding plus Host/Origin checks are the access boundary, not user
authentication. Do not expose it through a public reverse proxy.

Generic upstream log/file/activity/command features are not configured in this
fork's launcher. Logs are a future optional addition requiring filtering and a
fixed allowlist. Use `npm run dashboard`, not upstream's generic `server.js`
entry point or its v2 example configuration.

## Checks

```sh
npm run typecheck
npm test
npm run test:dashboard
```

Deploy it independently of the bot as a separate user service if desired. Use
the installation's actual Node executable and checkout path. Stopping the
dashboard does not stop the bot; no database migrations or agent image changes
are needed. No service is installed automatically.

## Upstream attribution

`tools/clidash` is adapted from `nanocoai/nanoclaw` commit `74224f62`,
`.claude/skills/add-clidash/add/tools/clidash`. The MIT license is retained in
`tools/clidash/UPSTREAM-LICENSE`. The fork adds a launcher and data adapter,
private-access checks, an operations overview, collection/error indicators,
and offline fonts. Upstream tests are retained, with the page-title expectation
updated for the fork. The original generic README/example remain reference
material; this document describes the supported fork configuration.
