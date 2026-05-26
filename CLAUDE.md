# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process that connects to WhatsApp, routes messages to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/whatsapp.ts` | WhatsApp connection, auth, send/receive |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/agent-browser.md` | Browser automation tool (available to all agents via Bash) |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:

macOS (dev workstation):
```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
```

Linux staging server (Ubuntu, accessed over SSH; specific host kept out of repo — see your local `~/.ssh/config` or env var):
```bash
systemctl --user status nanoclaw
systemctl --user restart nanoclaw
journalctl --user -u nanoclaw -f
```
Unit file: `~/.config/systemd/user/nanoclaw.service`. `WorkingDirectory` points at the checked-out repo on staging; `ExecStart` runs `dist/index.js` via an nvm-managed node (path under `~/.nvm/versions/node/<version>/bin/node`). Logs append to `logs/nanoclaw.{log,error.log}`.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.

## Staging Server Deploy

The staging server runs `dist/index.js` out of the checked-out repo, with state (`.env`, `groups/`, `store/messages.db`, WhatsApp/Telegram auth, `logs/`) co-located. Deploys must preserve `WorkingDirectory` — only swap the `dist/` build artifact. The specific staging host is configured per-machine outside this repo (SSH alias or env var) so it isn't committed.

Repo lives at `~/git/nanoclaw` on staging (matches systemd `WorkingDirectory`). Standard flow (from local dev machine, after the change is on `origin/staging`; replace `$STAGING` with your SSH alias / `user@host`):

```bash
# 1. Pull on remote
ssh "$STAGING" 'cd ~/git/nanoclaw && git pull --ff-only origin staging'

# 2. Build in an isolated worktree (does NOT touch the running app's state)
#    NVM is not auto-loaded in non-login ssh shells, so the bare `tsc -p .`
#    spawn fails to find `node`. Set PATH inline to the active node version.
ssh "$STAGING" 'export PATH=$HOME/.nvm/versions/node/$(ls ~/.nvm/versions/node | tail -1)/bin:$PATH && cd ~/git/nanoclaw && git worktree prune && git worktree add /tmp/nanoclaw-build origin/staging && ln -s ~/git/nanoclaw/node_modules /tmp/nanoclaw-build/node_modules && cd /tmp/nanoclaw-build && tsc -p .'

# 3. Swap dist (keep prior dist as rollback)
ssh "$STAGING" 'cd ~/git/nanoclaw && mv dist dist.old.$(date +%s) && cp -a /tmp/nanoclaw-build/dist .'

# 4. Restart and verify
ssh "$STAGING" 'systemctl --user restart nanoclaw && systemctl --user is-active nanoclaw'

# 5. Cleanup
ssh "$STAGING" 'rm /tmp/nanoclaw-build/node_modules && cd ~/git/nanoclaw && git worktree remove --force /tmp/nanoclaw-build'
```

Gotchas:

- **`/tmp` worktrees do not survive long gaps.** Ubuntu's `tmpfiles.d` (or a reboot) wipes `/tmp` periodically. If a prior session left `/tmp/nanoclaw-build` registered with git but the directory is gone, `git worktree list` shows it as `prunable`. Always `git worktree prune` before recreating. Never assume an old build artifact under `/tmp` is still there — rebuild every deploy.
- **Don't swap `dist/` if there's no source for the new dist.** If the `cp` fails after the `mv`, the live `dist/` is gone and the next service restart will fail. Order matters: build first, only then swap. The `set -e` + `mv ... && cp ...` pattern is meant to fail fast before the restart, but you still need to recover the moved-aside dist manually.
- **Don't reset the staging working tree** even if it has uncommitted changes — runtime state (`groups/main/CLAUDE.md` is rewritten by the soul capability on each init, `.env` and auth state live there too). Operate against the dist artifact only.
- **`sqlite3` is needed on the host** for one-off task-table queries (the agent containers carry their own via the image).
- **Quiet hours and proactive budget reset on local time**, not UTC. The check-in task fires every 2h but the host-side `beforeTaskRun` hook skips it during 10 PM – 7 AM local.

## Soul Identity System

The soul is a persistent identity and memory layer built as a capability (`src/capabilities/soul/`). Enable with `SOUL_ENABLED=true` in `.env`.

### Architecture: Wiki-Based Continuous Curation (Karpathy LLM Wiki pattern)

Memory Stream (SQLite, raw/immutable) → Wiki (markdown files, continuously curated) → Planning (JSON + scheduled tasks)

### Implementation Status

| Phase | Status | Coding Prompt | Key Files |
|-------|--------|--------------|-----------|
| Phase 0: Capability Registry | Done | `CAPABILITY_REGISTRY_PROMPT.md` | `src/capabilities/registry.ts`, `types.ts`, `hooks.ts`, `lifecycle.ts` |
| Phase 1: Memory Stream + Wiki Scaffold | Done | `SOUL_IDENTITY_PROMPT.md` (Section 6) | `memory-stream.ts`, `wiki-scaffold.ts`, `heuristic-score.ts`, `migrations.ts` |
| Phase 2: Wiki Curation | Done | `WIKI_CURATION_PROMPT.md` | `curator-prompts.ts`, tasks: `soul-wiki-curation-main`, `soul-evening-journal-main` |
| Phase 3: Identity | Done | `IDENTITY_PROMPT.md` | `identity.ts`, `identity-server.ts`, `agent-description.ts` |
| Phase 4: Planning + Initiative | Done | `PLANNING_PROMPT.md` | `planning-prompts.ts`, `proactive-budget.ts`, tasks: `soul-morning-plan-main`, `soul-check-in-main` |
| Phase 4.5: Experimentation + Feedback | Done | `EXPERIMENTATION_PROMPT.md` | `timing-bandit.ts`, `experiment-store.ts`; migration `1.1.0` (tables: `experiment_episodes`, `experiment_tuning`); state file: `soul/experiment-state.json` |
| Phase 5: Claw Pod (A2A) | Not started | Not yet created | `/a2a` endpoint (currently 501) |

### Soul Files

```
src/capabilities/soul/
  index.ts              # soulCapability: init, teardown, hooks, task registration
  memory-stream.ts      # addMemory(), getUncurated(), MemoryType
  heuristic-score.ts    # heuristicScore() → 1-10
  wiki-scaffold.ts      # ensureWikiForGroup() — creates starter wiki pages
  curator-prompts.ts    # Static prompts for wiki curation + evening journal tasks
  migrations.ts         # memory_stream + experiment_episodes + experiment_tuning tables
  identity.ts           # Ed25519 key management, DID document generation
  identity-server.ts    # HTTP server: /.well-known/did.json, agent-description.json
  agent-description.ts  # JSON-LD Agent Description generation
  planning-prompts.ts   # Static prompts for morning plan + check-in tasks (Step 0 evaluation)
  proactive-budget.ts   # Host-side gate: readBudget(), canSendProactive(), inWithdrawalPeriod()
  timing-bandit.ts      # Beta-Bernoulli arms, Marsaglia–Tsang Gamma sampler, Thompson ranking
  experiment-store.ts   # Episodes/posteriors/efficacy, backoff-state clamp, writeExperimentState, reviewGuardrails
  soul.test.ts          # Unit tests
```

### Key Design Decisions

- Curation runs inside containers via scheduled tasks, NOT host-side LLM calls
- Task prompts are static — the container agent reads live data (DB, files) itself
- Curation restricted to main group only (non-main containers lack DB access)
- `beforeTaskRun` hook gates curation (skip if no uncurated entries) — avoids unnecessary container spin-ups
- Identity server binds 127.0.0.1 only (Tailscale Funnel handles TLS termination)
- Private key at `~/.config/nanoclaw/soul/` (outside project, never mounted into containers)
- Staleness markers: `<!-- last_confirmed: YYYY-MM-DD -->` on wiki sections, 14-day threshold

### Scheduled Soul Tasks (Main Group)

| Task ID | Schedule | Purpose |
|---------|----------|---------|
| `soul-wiki-curation-main` | Every 2 hours (interval) | Curate uncurated memory entries into wiki pages |
| `soul-evening-journal-main` | 10 PM daily (cron) | Deep curation + plan reconciliation + staleness review |
| `soul-morning-plan-main` | 6 AM daily (cron) | Generate daily-plan.json from wiki + pending interventions + Thompson timing + backoff (gated: skip if today's plan already written; host refreshes `experiment-state.json` first) |
| `soul-check-in-main` | Every 2 hours (interval) | Step 0: evaluate `sent` plan items past the proximal window → insert episode row → flip to `done`. Step 1+: send proactive messages (gated: skip if budget exhausted, quiet hours, or withdrawal week; host refreshes `experiment-state.json` and runs self-rate-limited `reviewGuardrails` first) |

### Parent Spec

`SOUL_IDENTITY_PROMPT.md` is the master design document covering Phases 0–5. Individual coding prompts (`WIKI_CURATION_PROMPT.md`, `IDENTITY_PROMPT.md`, `PLANNING_PROMPT.md`) are implementation specs derived from it. `EXPERIMENTATION_PROMPT.md` (Phase 4.5) is an insertion not in the original numbering — it closes the feedback loop Phase 4 left open before Phase 5's peer-networking work, on the principle that a soul that hasn't evaluated its own proactivity has nothing to offer peers.

### Future: Claw Pod

Multiple NanoClaw instances connect via did:wba identity. Each has its own soul, wiki, keys. They discover each other via Tailscale DNS or peer list and exchange messages via the `/a2a` endpoint, authenticated by DID signatures. This builds on Phase 3's identity server.
