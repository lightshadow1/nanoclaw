// Transport-agnostic boundary for soul-to-soul messages. Implementations
// shipped in this phase: LoopbackTransport (in-process, no serialization).
// Future implementations (out of v1, designed-for):
//
//   - IpcTransport: Unix socket / localhost HTTP; serializes the envelope
//     at the boundary. Multi-soul (the daemon hosts several souls).
//   - NetworkTransport: HTTPS over Tailscale Funnel; resolves remote
//     public keys by fetching the peer's did.json.
//
// The protocol handler is transport-blind: it accepts a SignedMessage and
// returns a SignedMessage; it never knows whether the request came over
// loopback or HTTPS. That is the whole point of the seam.

import type { SignedMessage } from './types.js';

export type SignedRequestHandler = (
  req: SignedMessage,
) => Promise<SignedMessage>;

export interface Transport {
  // Receiver-side registration. Single-handler transports (IPC daemon
  // listening on one socket, networked HTTPS server listening on one port)
  // use this to install their inbound handler. Multi-soul transports — of
  // which LoopbackTransport is the only v1 example — implement per-soul
  // registration on the concrete class instead and throw from this method.
  onRequest(handler: SignedRequestHandler): void;

  // Sender-side. Send a signed message addressed to `targetSoulId` and
  // await the signed response. The target identifier is whatever the
  // transport understands — a DID for loopback (resolved via the in-process
  // registry), a socket path for IPC, an HTTPS URL for the network.
  send(targetSoulId: string, req: SignedMessage): Promise<SignedMessage>;
}
