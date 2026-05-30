// Soul-to-soul protocol types.
//
// v1 verbs are the minimum needed for one-owner multi-soul coordination.
// Verb-specific body shapes (request/response unions) are defined in their
// own files as they come online — step 4 in the implementation order.

export type Verb =
  | 'get_agent_card'
  | 'query_wiki'
  | 'propose_intervention'
  | 'query_state';

// The signed object. Same shape for loopback, IPC, and HTTPS — the signature
// is what crosses the authority boundary, not the transport. A buggy or
// compromised in-process soul still has to sign with its own key.
export interface MessageEnvelope {
  id: string; // UUID, unique per request — also serves as the replay nonce
  from: string; // sender DID (e.g. did:wba:host:agent:main)
  to: string; // recipient DID
  verb: Verb;
  ts: string; // ISO timestamp the envelope was built
  body: unknown; // verb-specific payload; typed by the verb's own module
}

export interface MessageSignature {
  alg: 'Ed25519';
  keyId: string; // DID URL — e.g. did:wba:host:agent:main#key-1
  proof: string; // base64url Ed25519 signature over canonicalized envelope
}

export interface SignedMessage {
  envelope: MessageEnvelope;
  signature: MessageSignature;
}

// Result type for verifyMessage. Discriminated on `ok` so callers must handle
// the failure case explicitly — there is no implicit "verified" state.
export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: VerifyFailReason };

export type VerifyFailReason =
  | 'unknown_key' // resolvePublicKey returned null for keyId
  | 'invalid_signature' // signature bytes don't match canonical envelope
  | 'envelope_to_mismatch' // envelope.to is not the receiving soul
  | 'replay' // envelope.id was already verified within REPLAY_TTL_SEC
  | 'malformed'; // structural problem in the SignedMessage itself

// --- Verb request/response bodies ---------------------------------------
//
// Each verb gets a Request type, a Response type, and a runtime guard that
// narrows `unknown` (which is how envelope.body arrives — see
// MessageEnvelope.body above). Guards reject anything missing required
// fields but permit extra fields, so receivers stay forward-compatible
// with senders that grew new optional payload keys.

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// get_agent_card -------------------------------------------------------------
// Empty request; receiver responds with its signed v1.2 AgentCard. The
// inner `card` shape is intentionally `unknown` here — agent-card.ts (step
// 7 in the spec's order) will declare and narrow `SignedAgentCard`; the
// protocol layer doesn't need to know its internals to route the verb.

export type GetAgentCardRequest = Record<string, never>;

export interface GetAgentCardResponse {
  card: unknown;
}

export function isGetAgentCardRequest(v: unknown): v is GetAgentCardRequest {
  // Empty object only; null/undefined/non-objects fail. Forward-compat
  // would also accept extra keys, so don't reject those.
  return isObject(v);
}

// query_wiki -----------------------------------------------------------------
// page is a wiki page name relative to the receiving soul's wiki root.
// Slash/`..` rejection is the handler's job (capability-tier check too) —
// the type guard only enforces shape.

export interface QueryWikiRequest {
  page: string;
}

export interface QueryWikiResponse {
  content: string;
  // null = page not found; otherwise epoch ms of mtime for cache hints.
  lastModifiedMs: number | null;
}

export function isQueryWikiRequest(v: unknown): v is QueryWikiRequest {
  return isObject(v) && typeof v.page === 'string' && v.page.length > 0;
}

// propose_intervention -------------------------------------------------------
// Spawned soul → main. Mirrors the structured intervention shape Phase 4
// already stores in memory_stream.metadata, plus an `origin_folder` so the
// main soul can attribute the proposal back to its source ("your
// project-rust soul wants me to mention...").

export type InterventionPriority = 'high' | 'medium' | 'low';

export interface ProposeInterventionRequest {
  intervention_type: string;
  question: string;
  // Optional Phase 4 fields — receivers store what's present, ignore the rest.
  context?: string;
  options?: string[];
  priority?: InterventionPriority;
  // Forward-compat metadata bag for fields not yet in the typed surface.
  metadata?: Record<string, unknown>;
}

export interface ProposeInterventionResponse {
  accepted: boolean;
  // Set when accepted=true and the receiver stored the intervention.
  interventionId?: string;
  // Set when accepted=false to explain (e.g. "unrecognized origin").
  reason?: string;
}

export function isProposeInterventionRequest(
  v: unknown,
): v is ProposeInterventionRequest {
  if (!isObject(v)) return false;
  if (
    typeof v.intervention_type !== 'string' ||
    v.intervention_type.length === 0
  ) {
    return false;
  }
  if (typeof v.question !== 'string' || v.question.length === 0) return false;
  if (v.context !== undefined && typeof v.context !== 'string') return false;
  if (v.options !== undefined) {
    if (!Array.isArray(v.options)) return false;
    if (!v.options.every((o) => typeof o === 'string')) return false;
  }
  if (
    v.priority !== undefined &&
    v.priority !== 'high' &&
    v.priority !== 'medium' &&
    v.priority !== 'low'
  ) {
    return false;
  }
  if (v.metadata !== undefined && !isObject(v.metadata)) return false;
  return true;
}

// query_state ----------------------------------------------------------------
// Selected slices of the receiving soul's runtime state. Response is a
// discriminated union on `slice` so the caller's narrow matches the
// request it sent.

export type QueryStateSlice = 'plan_summary' | 'recent_episodes' | 'backoff';

export interface QueryStateRequest {
  slice: QueryStateSlice;
}

export interface PlanSummary {
  slice: 'plan_summary';
  date: string | null; // null = no plan written yet
  itemCount: number;
  notes: string | null;
}

export interface RecentEpisodesSlice {
  slice: 'recent_episodes';
  episodes: Array<{
    sent_at: string;
    target: string | null;
    timing_arm: string;
    outcome: string;
    sentiment: string | null;
  }>;
}

export interface BackoffSlice {
  slice: 'backoff';
  targets: Record<string, { outreach_multiplier: number }>;
}

export type QueryStateResponse =
  | PlanSummary
  | RecentEpisodesSlice
  | BackoffSlice;

export function isQueryStateRequest(v: unknown): v is QueryStateRequest {
  if (!isObject(v)) return false;
  return (
    v.slice === 'plan_summary' ||
    v.slice === 'recent_episodes' ||
    v.slice === 'backoff'
  );
}

// Verb → (request, response) mapping. Useful for the handler to declare
// which body shape it returns per verb without leaking the runtime guards.
export interface VerbBodies {
  get_agent_card: { req: GetAgentCardRequest; res: GetAgentCardResponse };
  query_wiki: { req: QueryWikiRequest; res: QueryWikiResponse };
  propose_intervention: {
    req: ProposeInterventionRequest;
    res: ProposeInterventionResponse;
  };
  query_state: { req: QueryStateRequest; res: QueryStateResponse };
}
