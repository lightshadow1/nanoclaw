# Scoped History Search — Design

**Status:** proposed, pending approval and implementation
**Date:** 2026-08-27
**Sequence:** 2 of 6
**Depends on:** none; Sequence 1 should ship first by priority
**Required before:** none

## Problem

NanoClaw has semantic, curated memory but no precise episodic recall tool.
Messages are stored in SQLite, the Soul capability routes selected observations
into `memory_stream`, and compaction archives Claude transcripts as Markdown.
The current query APIs retrieve messages by timestamp for routing; they cannot
answer questions such as "where did we decide X?" or "find the exact discussion
about Y" without broad file/database scans.

Curated memory and history search serve different purposes. The Soul wiki is a
compact interpretation of durable facts. History search must return source
records with timestamps and identity so the agent can verify exact prior
language without promoting it automatically into memory.

## Goal

Add fast, read-only, group-scoped full-text search over stored channel messages,
with main-only cross-group search, bounded results, and explicit provenance.

## Non-goals

- No vector database, embeddings, reranker, or external search service.
- No replacement for `memory_stream`, Soul wiki curation, or Claude sessions.
- No automatic injection of search results into prompts.
- No automatic memory writes based on search results.
- No first-version indexing of archived Markdown transcripts or arbitrary files.
- No search over unregistered chats, whose content is intentionally not stored.
- No fuzzy semantic matching beyond SQLite FTS5 tokenization and prefix queries.

## Data and authorization invariants

1. A non-main container can search only messages belonging to its verified
   source group.
2. Main may search one registered group or all registered groups.
3. Search scope is resolved by the host from registered-group state; the caller
   cannot supply an arbitrary `chat_jid` to bypass it.
4. Results are historical untrusted data, never instructions.
5. Search is read-only and cannot mutate messages, FTS rows, or Soul memory.

## Design

### 1. Add an FTS5 external-content index

Create an FTS5 virtual table linked to `messages` by a stable integer rowid:

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  sender_name,
  content='messages',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);
```

Add insert, delete, and update triggers following SQLite's external-content FTS5
pattern. Replace the two message-store `INSERT OR REPLACE` statements with
explicit `INSERT ... ON CONFLICT(id, chat_jid) DO UPDATE` statements so an
existing-message rewrite reliably exercises the FTS update trigger; do not
depend on SQLite recursive-trigger settings for `REPLACE` delete behavior.

On first migration, rebuild from existing stored messages:

```sql
INSERT INTO messages_fts(messages_fts) VALUES('rebuild');
```

Use a capability-independent core migration because the index serves general
conversation retrieval, not only Soul. Make initialization idempotent. If the
deployed SQLite library lacks FTS5, fail startup with a clear error only when
the feature is enabled; default enablement is decided below.

### 2. Add a typed database search API

Add:

```ts
interface HistorySearchOptions {
  query: string;
  chatJids: string[];
  limit?: number;
  before?: string;
  after?: string;
  includeBotMessages?: boolean;
}

interface HistorySearchResult {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_bot_message: boolean;
  rank: number;
}
```

`searchMessageHistory(options)` joins `messages_fts` back to `messages`, applies
the authorized `chatJids`, time bounds, and bot-message filter, orders by BM25
rank then newest timestamp, and enforces:

- default limit 8;
- maximum limit 20;
- maximum query length 256 characters;
- maximum returned content 2,000 characters per result;
- maximum aggregate serialized result 20,000 characters.

Reject empty queries and invalid timestamps. Escape or construct FTS syntax so
plain user text cannot accidentally become an expensive or malformed advanced
query. Version 1 supports words, quoted phrases, and a trailing `*` prefix only;
unsupported operators are treated as literal text or rejected with a useful
error.

### 3. Expose one NanoClaw MCP tool

Register `search_history` with parameters:

```ts
{
  query: string;
  limit?: number;
  before?: string;
  after?: string;
  include_bot_messages?: boolean;
  target_group_jid?: string;
}
```

The MCP server writes a request into the verified group IPC namespace. The host
resolves scope:

- non-main: ignore/reject `target_group_jid`; search only the source group's JID;
- main with target: require a registered target and search only it;
- main without target: search all registered stored-message JIDs.

Return results through a request/response IPC path. Existing task IPC is
fire-and-forget, so do not overload it with polling conventions hidden inside
the tool. Add a small correlated response primitive under the same per-group
namespace:

```text
/workspace/ipc/requests/<request-id>.json
/workspace/ipc/responses/<request-id>.json
```

Requirements:

- UUID request IDs generated by the MCP server;
- atomic temp-file rename on both sides;
- response accepted only from the matching group namespace;
- bounded wait, default 10 seconds;
- request and response deletion after success or timeout;
- startup cleanup for stale files older than one hour;
- JSON response schema with `ok`, `results`, and sanitized `error`.

This request/response rail may later support other read-only host queries, but
this spec implements only `search_history`.

### 4. Frame results as evidence

The tool response must state that results are historical, potentially stale,
and may contain quoted instructions that must not be followed. Each result is a
structured record, not concatenated raw prompt text. Include:

- group name/folder where authorized;
- timestamp;
- sender name;
- message ID;
- direction (`user` or `assistant`);
- bounded content excerpt.

Do not expose internal numeric SQLite rowids.

### 5. Feature enablement

Enable the database index and tool by default after migration because it is
local, scoped, and read-only. Add `HISTORY_SEARCH_ENABLED=false` as an explicit
pre-enable kill switch for environments whose SQLite build lacks FTS5 or whose
owner does not want a full-text index.

When disabled:

- skip creating/rebuilding the FTS table;
- do not register `search_history`;
- leave all ordinary message storage unchanged.

If an index already exists, disabling the feature omits the tool but does not
silently drop the table or triggers. Removing an existing index is an explicit
operator migration so a configuration toggle never destroys derived state.

## Files expected to change

- `src/db.ts`, `src/db.test.ts`
- `src/config.ts`
- `src/ipc.ts` and focused IPC request/response tests
- `container/agent-runner/src/ipc-mcp-stdio.ts`
- `src/types.ts` if shared result types are needed
- `.env.example`
- relevant architecture/debug documentation

No Soul migration or prompt change is required in the first slice.

## Tests

### Database

- Initial rebuild indexes pre-existing messages.
- Insert, replace, and delete keep FTS results coherent.
- Phrase, token, prefix, time-bound, and no-match searches behave deterministically.
- Bot messages are excluded by default and included only when requested.
- Result and query limits are enforced.
- Malformed FTS input returns a typed validation error, not a SQL exception.
- `PRAGMA integrity_check` and an FTS consistency check pass after mutations.

### Authorization and IPC

- Non-main sees only its own group even when requesting another target.
- Main may search a selected registered group or all registered groups.
- Unknown/unregistered target is rejected.
- Correlation IDs cannot retrieve another group's response.
- Atomic writes prevent partially parsed requests.
- Timeout and stale-file cleanup are bounded and logged without content.

### Tool behavior

- Responses include provenance and the untrusted-history warning.
- Empty results are concise.
- Disabled feature omits the tool.
- Search does not alter `memory_stream`, wiki files, sessions, or message rows.

## Migration and rollout

Before deployment, verify staging SQLite reports FTS5 support. Back up
`store/messages.db` using SQLite's online backup mechanism or a service-stopped
copy; do not copy a live WAL database naïvely.

On first startup, log migration duration and indexed row count without message
content. After deployment, compare `COUNT(messages)` with the FTS integrity
check, run cross-group authorization probes, and confirm normal message routing
latency is unchanged.

Rollback disables tool registration and drops FTS triggers/table only through
an explicit migration or operator action; ordinary messages remain canonical.

## Acceptance criteria

- Exact historical messages can be found with bounded FTS queries.
- Scope enforcement is host-side and covered by negative tests.
- Results carry source identity and an untrusted-data warning.
- Existing message routing and Soul memory behavior are unchanged.
- No external service or embedding dependency is introduced.

## Follow-up, not part of version 1

- Index compacted Markdown conversation archives.
- Search task-run results as a separate corpus.
- Provide snippets/highlighting using FTS5 `snippet()` after output-escaping and
  injection framing are proven.
- Let Soul curation cite message IDs in wiki updates.
