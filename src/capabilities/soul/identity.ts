import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { canonicalize } from './protocol/canonical.js';

export interface LoadedKeypair {
  privateKey: crypto.KeyObject;
  publicKey: crypto.KeyObject;
  publicKeyRaw: Uint8Array;
}

const BASE58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

// Multicodec varint for Ed25519 public keys: 0xed 0x01.
// The Ed25519VerificationKey2020 spec requires this prefix on the raw 32-byte
// public key before base58btc encoding. Without it, conformant verifiers will
// reject the key. Properly prefixed Ed25519 multibase strings start with "z6Mk".
// Reference: https://w3c-ccg.github.io/lds-ed25519-2020/
const ED25519_MULTICODEC_PREFIX = new Uint8Array([0xed, 0x01]);

export function encodeMultibase(bytes: Uint8Array): string {
  return 'z' + base58btcEncode(bytes);
}

export function encodeEd25519PublicKeyMultibase(
  rawPublicKey: Uint8Array,
): string {
  if (rawPublicKey.length !== 32) {
    throw new Error(
      `Ed25519 public key must be 32 bytes, got ${rawPublicKey.length}`,
    );
  }
  const prefixed = new Uint8Array(2 + rawPublicKey.length);
  prefixed.set(ED25519_MULTICODEC_PREFIX, 0);
  prefixed.set(rawPublicKey, 2);
  return encodeMultibase(prefixed);
}

function base58btcEncode(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

  const size = (((bytes.length - zeros) * 138) / 100 + 1) | 0;
  const b58 = new Uint8Array(size);
  let length = 0;
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    let it = 0;
    for (let j = size - 1; (carry !== 0 || it < length) && j >= 0; j--, it++) {
      carry += 256 * b58[j];
      b58[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    length = it;
  }

  let it2 = size - length;
  while (it2 < size && b58[it2] === 0) it2++;

  let result = '1'.repeat(zeros);
  for (; it2 < size; it2++) result += BASE58_ALPHABET[b58[it2]];
  return result;
}

// Path resolution for a soul's keypair directory.
//
// Phase 3 stored a single keypair at `~/.config/nanoclaw/soul/` for the main
// soul. Phase 5 introduces spawned souls; each gets its own subdir. Main is
// represented as `folder = null` and keeps the legacy path so existing keys
// require no migration. Spawned souls go in `{base}/{folder}/`.
//
// Folder names must be alphanumeric + hyphens (the same constraint enforced
// at spawn time) — anything that could traverse out of the base dir is
// rejected here as a defense-in-depth check.
export function soulKeyDir(homedir: string, folder: string | null): string {
  const base = path.join(homedir, '.config', 'nanoclaw', 'soul');
  if (folder === null) return base;
  if (!/^[a-z0-9-]+$/i.test(folder) || folder === '..' || folder === '.') {
    throw new Error(`Invalid soul folder name: ${folder}`);
  }
  return path.join(base, folder);
}

export function generateKeypair(keyDir: string): void {
  const privatePath = path.join(keyDir, 'private-key.pem');
  const publicPath = path.join(keyDir, 'public-key.pem');
  if (fs.existsSync(privatePath) && fs.existsSync(publicPath)) return;

  fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({
    format: 'pem',
    type: 'pkcs8',
  }) as string;
  const publicPem = publicKey.export({ format: 'pem', type: 'spki' }) as string;

  fs.writeFileSync(privatePath, privatePem, { mode: 0o600 });
  fs.writeFileSync(publicPath, publicPem, { mode: 0o644 });
}

export function loadKeypair(keyDir: string): LoadedKeypair {
  const privatePath = path.join(keyDir, 'private-key.pem');
  const publicPath = path.join(keyDir, 'public-key.pem');
  if (!fs.existsSync(privatePath) || !fs.existsSync(publicPath)) {
    throw new Error(
      `Soul keypair not found in ${keyDir}. Run /add-soul or call generateKeypair() first.`,
    );
  }

  const privateKey = crypto.createPrivateKey(
    fs.readFileSync(privatePath, 'utf-8'),
  );
  const publicKey = crypto.createPublicKey(
    fs.readFileSync(publicPath, 'utf-8'),
  );

  // The last 32 bytes of an Ed25519 SPKI DER-encoded key is the raw public key.
  const spkiDer = publicKey.export({ format: 'der', type: 'spki' });
  const publicKeyRaw = Uint8Array.from(spkiDer.subarray(spkiDer.length - 32));

  return { privateKey, publicKey, publicKeyRaw };
}

export interface DIDDocumentInput {
  domain: string;
  agentName: string;
  publicKeyMultibase: string;
}

export function generateDIDDocument(opts: DIDDocumentInput): object {
  const did = `did:wba:${opts.domain}:agent:${opts.agentName}`;
  const vmId = `${did}#key-1`;
  return {
    '@context': [
      'https://www.w3.org/ns/did/v1',
      'https://w3id.org/security/suites/ed25519-2020/v1',
    ],
    id: did,
    verificationMethod: [
      {
        id: vmId,
        type: 'Ed25519VerificationKey2020',
        controller: did,
        publicKeyMultibase: opts.publicKeyMultibase,
      },
    ],
    authentication: [vmId],
    service: [
      {
        id: '#agent-description',
        type: 'AgentDescription',
        serviceEndpoint: `https://${opts.domain}/.well-known/agent-description.json`,
      },
      {
        id: '#a2a',
        type: 'Agent2Agent',
        serviceEndpoint: `https://${opts.domain}/a2a`,
      },
    ],
  };
}

export interface SignedDocument {
  [key: string]: unknown;
  'anp:signature': {
    type: 'Ed25519Signature2020';
    created: string;
    verificationMethod: string;
    proofValue: string;
  };
}

export function signDocument(
  document: object,
  privateKey: crypto.KeyObject,
  verificationMethodId: string,
  now: Date = new Date(),
): SignedDocument {
  const { 'anp:signature': _ignore, ...unsigned } = document as Record<
    string,
    unknown
  >;
  const canonical = canonicalize(unsigned);
  const signature = crypto.sign(
    null,
    Buffer.from(canonical, 'utf-8'),
    privateKey,
  );
  return {
    ...unsigned,
    'anp:signature': {
      type: 'Ed25519Signature2020',
      created: now.toISOString(),
      verificationMethod: verificationMethodId,
      proofValue: signature.toString('base64url'),
    },
  };
}
