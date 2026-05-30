import crypto from 'crypto';

import { canonicalEnvelopeBytes } from './envelope.js';
import type { MessageEnvelope, SignedMessage, VerifyResult } from './types.js';

export const REPLAY_TTL_SEC = 60;

// Process-wide replay cache. envelope.id → epoch ms when first verified.
// Single map across all souls is correct: a UUID collision across souls
// would mean two different senders independently generated the same v4
// in 60s, which is astronomically unlikely and would still be safe to
// reject conservatively.
const seenIds = new Map<string, number>();

function sweepStaleNonces(now: number): void {
  const cutoff = now - REPLAY_TTL_SEC * 1000;
  for (const [id, ts] of seenIds) {
    if (ts < cutoff) seenIds.delete(id);
  }
}

// Test helper. Production code never calls this — the cache self-prunes
// via the TTL sweep on every verify.
export function _resetReplayCacheForTests(): void {
  seenIds.clear();
}

export function signMessage(
  envelope: MessageEnvelope,
  privateKey: crypto.KeyObject,
  keyId: string,
): SignedMessage {
  const sig = crypto.sign(null, canonicalEnvelopeBytes(envelope), privateKey);
  return {
    envelope,
    signature: {
      alg: 'Ed25519',
      keyId,
      proof: sig.toString('base64url'),
    },
  };
}

export interface VerifyContext {
  // Look up the public key bound to a keyId. Loopback walks the in-process
  // soul registry; networked transport (later) would fetch did.json and
  // pluck the matching verificationMethod.
  resolvePublicKey(keyId: string): crypto.KeyObject | null;

  // The DID of the receiving soul. Rejects messages addressed elsewhere —
  // prevents a buggy router from delivering a message to the wrong soul
  // and the wrong soul accepting it.
  expectedTo: string;

  // Injected for tests; defaults to Date.now() at call time.
  now?: Date;
}

export function verifyMessage(
  msg: SignedMessage,
  ctx: VerifyContext,
): VerifyResult {
  // Structural sanity. A caller might hand us anything if it deserialized
  // a malformed wire frame.
  if (
    !msg ||
    !msg.envelope ||
    !msg.signature ||
    msg.signature.alg !== 'Ed25519' ||
    typeof msg.signature.keyId !== 'string' ||
    typeof msg.signature.proof !== 'string' ||
    typeof msg.envelope.id !== 'string' ||
    typeof msg.envelope.to !== 'string'
  ) {
    return { ok: false, reason: 'malformed' };
  }

  if (msg.envelope.to !== ctx.expectedTo) {
    return { ok: false, reason: 'envelope_to_mismatch' };
  }

  const pubKey = ctx.resolvePublicKey(msg.signature.keyId);
  if (!pubKey) return { ok: false, reason: 'unknown_key' };

  let sigBuf: Buffer;
  try {
    sigBuf = Buffer.from(msg.signature.proof, 'base64url');
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  let valid = false;
  try {
    valid = crypto.verify(
      null,
      canonicalEnvelopeBytes(msg.envelope),
      pubKey,
      sigBuf,
    );
  } catch {
    return { ok: false, reason: 'invalid_signature' };
  }
  if (!valid) return { ok: false, reason: 'invalid_signature' };

  // Replay protection. Check AFTER signature passes so a forged ID with a
  // bad signature can't grief us by burning a slot in the cache.
  const nowMs = (ctx.now ?? new Date()).getTime();
  sweepStaleNonces(nowMs);
  if (seenIds.has(msg.envelope.id)) {
    return { ok: false, reason: 'replay' };
  }
  seenIds.set(msg.envelope.id, nowMs);

  return { ok: true };
}
