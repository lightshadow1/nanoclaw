// In-process transport. A single LoopbackTransport instance is shared
// across all souls in the NanoClaw process and held on the soul capability
// module. Each soul registers its DID and inbound handler at activation;
// unregisters at deactivation (dormant/archive). `send` looks up the
// target's handler and invokes it synchronously — no serialization, no
// network — but with the same signed envelope that an out-of-process
// transport would carry.
//
// Why loopback messages are still signed (recap of SOUL_PROTOCOL_PROMPT.md
// §3.3): the signature crosses an authority boundary, not a transport
// boundary. A compromised in-process soul still has to sign with its own
// key — meaning it cannot impersonate the main soul. The performance cost
// (tens of microseconds per call) buys protocol uniformity.

import type { SignedMessage } from './types.js';
import type { SignedRequestHandler, Transport } from './transport.js';

export class LoopbackTransport implements Transport {
  // DID → that soul's inbound handler. One entry per active soul.
  private readonly handlers = new Map<string, SignedRequestHandler>();

  registerSoul(did: string, handler: SignedRequestHandler): void {
    if (this.handlers.has(did)) {
      // A double-registration is a programming bug — two ActiveSouls with
      // the same DID would mean a duplicate folder in the registry. Throw
      // loudly so it's caught at spawn time, not as silent overwrite.
      throw new Error(`LoopbackTransport: DID already registered: ${did}`);
    }
    this.handlers.set(did, handler);
  }

  unregisterSoul(did: string): void {
    this.handlers.delete(did);
  }

  registeredCount(): number {
    return this.handlers.size;
  }

  async send(targetSoulId: string, req: SignedMessage): Promise<SignedMessage> {
    const handler = this.handlers.get(targetSoulId);
    if (!handler) {
      throw new Error(`LoopbackTransport: no handler for ${targetSoulId}`);
    }
    // Pass the SignedMessage by reference — handlers must treat the
    // envelope as immutable, which they will since they're verifying it.
    return handler(req);
  }

  // Loopback is multi-soul, so the single-handler Transport.onRequest API
  // doesn't fit. Use registerSoul/unregisterSoul instead. Calling this is
  // a programming error.
  onRequest(_handler: SignedRequestHandler): void {
    throw new Error('LoopbackTransport: use registerSoul instead of onRequest');
  }
}
