import { randomUUID } from 'crypto';

import { canonicalize } from './canonical.js';
import type { MessageEnvelope, Verb } from './types.js';

export interface BuildEnvelopeOpts {
  from: string;
  to: string;
  verb: Verb;
  body: unknown;
  now?: Date;
  id?: string; // optional override so tests can pin nonces
}

export function buildEnvelope(opts: BuildEnvelopeOpts): MessageEnvelope {
  return {
    id: opts.id ?? randomUUID(),
    from: opts.from,
    to: opts.to,
    verb: opts.verb,
    ts: (opts.now ?? new Date()).toISOString(),
    body: opts.body,
  };
}

// The bytes that get signed. Canonicalize sorts keys recursively, so
// two structurally-identical envelopes produce identical bytes regardless
// of insertion order — a signature stays valid even if a hop re-serializes
// the envelope (e.g. JSON.parse(JSON.stringify(env))) along the way.
export function canonicalEnvelopeBytes(env: MessageEnvelope): Buffer {
  return Buffer.from(canonicalize(env), 'utf-8');
}
