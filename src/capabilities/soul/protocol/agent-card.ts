// v1.2-shaped AgentCard for the soul-to-soul protocol's `get_agent_card`
// verb. Distinct from the JSON-LD AgentDescription served by Phase 3's
// identity server at /.well-known/agent-description.json — that document
// is for public discovery; the AgentCard here is for protocol-level
// exchange between souls and is what the handler returns under `card`.
//
// Signed via Phase 3's signDocument (canonicalize → Ed25519 → embed proof
// inside an `anp:signature` field). Receivers can verify with the
// authoring soul's public key resolved through the protocol's existing
// resolvePublicKey path.

import crypto from 'crypto';

import type {
  CapabilityTier,
  DiscoveredCapability,
} from '../agent-description.js';
import {
  encodeEd25519PublicKeyMultibase,
  signDocument,
  type SignedDocument,
} from '../identity.js';

export const AGENT_CARD_SCHEMA_VERSION = '1.2';

export interface AgentCardCapability {
  name: string;
  description: string;
  tier: CapabilityTier;
}

export interface AgentCardInput {
  did: string;
  agentName: string;
  owner: string;
  description?: string;
  traits?: string[];
  capabilities: AgentCardCapability[];
  publicKeyRaw: Uint8Array; // 32-byte raw Ed25519 public key
  verificationMethodId: string; // typically `${did}#key-1`
  // null / omitted = loopback-only soul (no networked endpoint).
  endpoint?: string | null;
  now?: Date;
}

export type SignedAgentCard = SignedDocument;

// Build the unsigned card object. Stable key order is *not* required here —
// signDocument canonicalizes before signing, so a reader can't tell what
// order we serialized in.
export function buildAgentCard(opts: AgentCardInput): Record<string, unknown> {
  const card: Record<string, unknown> = {
    schemaVersion: AGENT_CARD_SCHEMA_VERSION,
    did: opts.did,
    name: opts.agentName,
    description:
      opts.description ?? `Personal AI assistant operated by ${opts.owner}.`,
    owner: opts.owner,
    capabilities: opts.capabilities,
    publicKey: {
      type: 'Ed25519VerificationKey2020',
      keyId: opts.verificationMethodId,
      publicKeyMultibase: encodeEd25519PublicKeyMultibase(opts.publicKeyRaw),
    },
    endpoints: {
      a2a: opts.endpoint ?? 'loopback',
    },
    createdAt: (opts.now ?? new Date()).toISOString(),
  };
  if (opts.traits && opts.traits.length > 0) {
    card.traits = opts.traits;
  }
  return card;
}

// Build + sign in one call. The signature is over the canonicalized card
// (sortedkeys + tight JSON) — same scheme as the Phase 3 DID document.
export function buildSignedAgentCard(
  opts: AgentCardInput,
  privateKey: crypto.KeyObject,
): SignedAgentCard {
  return signDocument(
    buildAgentCard(opts),
    privateKey,
    opts.verificationMethodId,
    opts.now,
  );
}

// Convenience: derive AgentCardCapability[] from DiscoveredCapability[]
// (which already carries tier). Existed as a thin shim so callers don't
// have to map manually.
export function capabilitiesForCard(
  discovered: DiscoveredCapability[],
): AgentCardCapability[] {
  return discovered.map((c) => ({
    name: c.name,
    description: c.description,
    tier: c.tier,
  }));
}
