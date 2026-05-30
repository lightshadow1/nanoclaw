// Protocol verb handler. The single entry point a transport calls after it
// has verified an inbound SignedMessage. Per SOUL_PROTOCOL_PROMPT.md §10
// this handler is *pure* — no extra I/O beyond what each verb needs — and
// it returns a SignedMessage addressed back to the caller, regardless of
// whether the underlying verb succeeded or failed.
//
// Error convention: structural / protocol-level failures (malformed body,
// tier denial, unknown verb) come back as `{ error: { code, message } }`.
// Verb-typed semantic refusals (propose_intervention with `accepted: false`)
// use the verb's own response shape. Callers narrow on the `error` key
// before treating a body as the verb's typed response.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';

import { getRecentEpisodes, readBackoffState } from '../experiment-store.js';
import { addMemory } from '../memory-stream.js';
import { buildEnvelope } from './envelope.js';
import { signMessage } from './signing.js';
import {
  isGetAgentCardRequest,
  isProposeInterventionRequest,
  isQueryStateRequest,
  isQueryWikiRequest,
  type SignedMessage,
  type Verb,
} from './types.js';

// Trust tiers, lowest → highest. v1 loopback stamps every caller `trusted`,
// so the only way to exercise denial in production is to lower a verb's
// required tier or to plug in an IPC/network transport that assigns
// `public`. Tests exercise the denial path directly.
export type CallerTier = 'public' | 'trusted' | 'inner_circle';

// Per spec §17: every loopback caller is `trusted` because same-process
// callers are by-construction known-and-attested. IPC/network transports
// (deferred) will assign lower tiers based on signature provenance and
// peer DID resolution.
export const LOOPBACK_DEFAULT_TIER: CallerTier = 'trusted';

const TIER_RANK: Record<CallerTier, number> = {
  public: 0,
  trusted: 1,
  inner_circle: 2,
};

function tierMeets(actual: CallerTier, required: CallerTier): boolean {
  return TIER_RANK[actual] >= TIER_RANK[required];
}

// Minimum tier per verb. get_agent_card is `public` — anyone can fetch a
// soul's card. State and intervention verbs require trust because they
// either reveal internal slices or write into the receiver's memory.
export const REQUIRED_TIER: Record<Verb, CallerTier> = {
  get_agent_card: 'public',
  query_wiki: 'trusted',
  propose_intervention: 'trusted',
  query_state: 'trusted',
};

// Optional provider plugged in by step 7 (agent-card.ts). When absent the
// handler returns a minimal placeholder so verb wire-up is independently
// testable before the signed-AgentCard implementation lands.
export type AgentCardProvider = () => unknown;

export interface SoulContext {
  did: string;
  keyId: string; // DID URL — typically `${did}#key-1`
  privateKey: crypto.KeyObject;
  folder: string;
  agentName: string;
  groupsDir: string;
  db: Database.Database;
  getAgentCard?: AgentCardProvider;
}

type ErrorCode = 'bad_request' | 'forbidden' | 'not_found' | 'unknown_verb';

function errorBody(
  code: ErrorCode,
  message: string,
): {
  error: { code: ErrorCode; message: string };
} {
  return { error: { code, message } };
}

// Wiki page names are flat slugs: alphanumeric + `_-`. No slashes, no dots
// (so `..` and absolute paths are structurally impossible). Rejection
// happens here, not via path.resolve gymnastics.
function pageNameOk(name: string): boolean {
  return /^[a-z0-9_-]+$/i.test(name);
}

// Parse the folder slug out of `did:wba:{domain}:agent:{folder}`. Used to
// stamp the originating soul on a propose_intervention insert so the main
// soul's morning plan can attribute the proposal back. Returns null if the
// DID doesn't match the expected shape.
export function folderFromDid(did: string): string | null {
  const m = did.match(/:agent:([a-z0-9_-]+)$/i);
  return m ? m[1] : null;
}

async function dispatch(
  msg: SignedMessage,
  receiver: SoulContext,
): Promise<unknown> {
  const body = msg.envelope.body;

  switch (msg.envelope.verb) {
    case 'get_agent_card': {
      if (!isGetAgentCardRequest(body)) {
        return errorBody('bad_request', 'expected an object body');
      }
      const card = receiver.getAgentCard?.() ?? {
        did: receiver.did,
        agentName: receiver.agentName,
        placeholder: true,
      };
      return { card };
    }

    case 'query_wiki': {
      if (!isQueryWikiRequest(body)) {
        return errorBody('bad_request', 'expected { page: string }');
      }
      if (!pageNameOk(body.page)) {
        return errorBody('bad_request', `invalid page name: ${body.page}`);
      }
      const filePath = path.join(
        receiver.groupsDir,
        receiver.folder,
        'soul',
        'wiki',
        `${body.page}.md`,
      );
      if (!fs.existsSync(filePath)) {
        return { content: '', lastModifiedMs: null };
      }
      const content = fs.readFileSync(filePath, 'utf-8');
      const lastModifiedMs = fs.statSync(filePath).mtimeMs;
      return { content, lastModifiedMs };
    }

    case 'propose_intervention': {
      if (!isProposeInterventionRequest(body)) {
        return errorBody('bad_request', 'malformed intervention payload');
      }
      const originFolder = folderFromDid(msg.envelope.from);
      const interventionId = addMemory(receiver.db, {
        groupFolder: receiver.folder,
        timestamp: new Date().toISOString(),
        type: 'intervention',
        source: 'spawned-soul',
        content: body.question,
        importance: 8,
        metadata: {
          intervention_type: body.intervention_type,
          question: body.question,
          context: body.context,
          options: body.options,
          priority: body.priority ?? 'medium',
          status: 'pending',
          origin_folder: originFolder,
          origin_did: msg.envelope.from,
          ...(body.metadata ?? {}),
        },
      });
      return { accepted: true, interventionId };
    }

    case 'query_state': {
      if (!isQueryStateRequest(body)) {
        return errorBody('bad_request', 'expected { slice: ... }');
      }
      switch (body.slice) {
        case 'plan_summary': {
          const planPath = path.join(
            receiver.groupsDir,
            receiver.folder,
            'soul',
            'daily-plan.json',
          );
          if (!fs.existsSync(planPath)) {
            return {
              slice: 'plan_summary',
              date: null,
              itemCount: 0,
              notes: null,
            };
          }
          try {
            const plan = JSON.parse(fs.readFileSync(planPath, 'utf-8')) as {
              date?: string;
              items?: unknown[];
              notes?: string;
            };
            return {
              slice: 'plan_summary',
              date: plan.date ?? null,
              itemCount: Array.isArray(plan.items) ? plan.items.length : 0,
              notes: plan.notes ?? null,
            };
          } catch {
            return {
              slice: 'plan_summary',
              date: null,
              itemCount: 0,
              notes: null,
            };
          }
        }
        case 'recent_episodes': {
          const eps = getRecentEpisodes(receiver.db, receiver.folder, 7);
          return {
            slice: 'recent_episodes',
            episodes: eps.map((e) => ({
              sent_at: e.sentAt,
              target: e.target,
              timing_arm: e.timingArm,
              outcome: e.outcome,
              sentiment: e.sentiment,
            })),
          };
        }
        case 'backoff': {
          const state = readBackoffState(receiver.db, receiver.folder);
          // Project onto the contract — strip `since` timestamps and any
          // forward-compat fields so internal bookkeeping doesn't leak.
          const targets: Record<string, { outreach_multiplier: number }> = {};
          for (const [name, entry] of Object.entries(state.targets)) {
            targets[name] = {
              outreach_multiplier: entry.outreach_multiplier,
            };
          }
          return { slice: 'backoff', targets };
        }
      }
      // Unreachable — the guard above narrowed body.slice exhaustively.
      return errorBody('bad_request', 'unknown slice');
    }

    default: {
      // Exhaustiveness check. If a new Verb is added without a case here,
      // this assignment fails at compile time.
      const _exhaustive: never = msg.envelope.verb;
      void _exhaustive;
      return errorBody('unknown_verb', `verb not supported`);
    }
  }
}

export async function handleRequest(
  msg: SignedMessage,
  callerTier: CallerTier,
  receiver: SoulContext,
): Promise<SignedMessage> {
  let body: unknown;
  const required = REQUIRED_TIER[msg.envelope.verb];

  if (required === undefined) {
    body = errorBody(
      'unknown_verb',
      `verb not supported: ${msg.envelope.verb}`,
    );
  } else if (!tierMeets(callerTier, required)) {
    body = errorBody(
      'forbidden',
      `verb ${msg.envelope.verb} requires tier ${required}; caller has ${callerTier}`,
    );
  } else {
    body = await dispatch(msg, receiver);
  }

  const responseEnv = buildEnvelope({
    from: receiver.did,
    to: msg.envelope.from,
    verb: msg.envelope.verb,
    body,
  });
  return signMessage(responseEnv, receiver.privateKey, receiver.keyId);
}
