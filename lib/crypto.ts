// Card content at rest (docs/trust.md, docs/deploy.md "At rest"): every head has a data key, 32 random bytes, which
// encrypts its content; the data key is stored only wrapped. Step one wraps it under HEAD_MASTER_KEY; step two adds
// wraps under each passkey's PRF output and moves the unwrapping to the session, without touching a card. So the
// wrapping is pluggable (`KeyWrap`); the data key and the sealed values are not.
//
//   value      AES-256-GCM, a random 96-bit nonce per value, the head id and the column as associated data:
//              "e1:" + base64(nonce ‖ ciphertext ‖ tag). A flipped byte fails closed (CryptoError).
//   data key   wrapped with the same construction under the wrapping key, the head id as associated data:
//              "<kind>1:" + base64(nonce ‖ ciphertext ‖ tag).
//   digest     HMAC-SHA-256 under a key derived from the data key: equal content compares equal without being readable.

import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

export class CryptoError extends Error {
  override readonly name = 'CryptoError';
}

const NONCE = 12;
const TAG = 16;

function gcmSeal(key: Buffer, aad: string, plain: Buffer): Buffer {
  const nonce = randomBytes(NONCE);
  const c = createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([nonce, body, c.getAuthTag()]);
}

function gcmOpen(key: Buffer, aad: string, sealed: Buffer): Buffer {
  if (sealed.length < NONCE + TAG) throw new CryptoError('sealed value too short');
  try {
    const d = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, NONCE));
    d.setAAD(Buffer.from(aad, 'utf8'));
    d.setAuthTag(sealed.subarray(sealed.length - TAG));
    return Buffer.concat([d.update(sealed.subarray(NONCE, sealed.length - TAG)), d.final()]);
  } catch {
    throw new CryptoError('a sealed value failed its integrity check (wrong key, wrong head or column, or tampered)');
  }
}

/** The associated data of a value: which head, which column (or field). */
const aadOf = (headId: string, column: string) => `${headId}\u0000${column}`;

/** Encrypts `plain` under the head's data key for one column. */
export function seal(key: Buffer, headId: string, column: string, plain: string): string {
  return `e1:${gcmSeal(key, aadOf(headId, column), Buffer.from(plain, 'utf8')).toString('base64')}`;
}

/** Decrypts a value `seal` made; CryptoError when it is not one, or does not authenticate. */
export function open(key: Buffer, headId: string, column: string, sealed: string): string {
  if (!sealed.startsWith('e1:')) throw new CryptoError('not a sealed value');
  return gcmOpen(key, aadOf(headId, column), Buffer.from(sealed.slice(3), 'base64')).toString('utf8');
}

export const isSealed = (v: unknown): v is string => typeof v === 'string' && v.startsWith('e1:');

/** A keyed digest: equal inputs give equal digests, and the digest says nothing without the key. */
export function digest(key: Buffer, purpose: string, value: string): string {
  const k = Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), `pbcp-digest:${purpose}`, 32));
  return createHmac('sha256', k).update(value, 'utf8').digest('hex');
}

/** JSON with object keys sorted at every depth: a stable string for a digest. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as Record<string, unknown>)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

export const newDataKey = (): Buffer => randomBytes(32);

// --- wrapping the data key ----------------------------------------------------------------------------------------

/** How a head's data key is kept at rest. Step one: under HEAD_MASTER_KEY. Step two adds per-passkey wraps. */
export interface KeyWrap {
  /** The prefix of the wraps this implementation makes ("m" for the master key). */
  readonly kind: string;
  wrap(headId: string, dataKey: Buffer): string;
  unwrap(headId: string, wrapped: string): Buffer;
}

/** The data key wrapped under the deployment's master key (AES-256-GCM, the head id as associated data). */
export class MasterKeyWrap implements KeyWrap {
  readonly kind = 'm';
  constructor(private readonly master: Buffer) {
    if (master.length !== 32) throw new CryptoError('HEAD_MASTER_KEY must be 32 bytes, base64 (openssl rand -base64 32)');
  }

  wrap(headId: string, dataKey: Buffer): string {
    return `m1:${gcmSeal(this.master, aadOf(headId, 'heads.data_key'), dataKey).toString('base64')}`;
  }

  unwrap(headId: string, wrapped: string): Buffer {
    if (!wrapped.startsWith('m1:')) throw new CryptoError('not a master-key wrap');
    const key = gcmOpen(this.master, aadOf(headId, 'heads.data_key'), Buffer.from(wrapped.slice(3), 'base64'));
    if (key.length !== 32) throw new CryptoError('a data key is 32 bytes');
    return key;
  }
}

/** HEAD_MASTER_KEY from the environment: null when unset; CryptoError when it is not 32 bytes of base64. */
export function masterKey(env: Record<string, string | undefined> = process.env): Buffer | null {
  const v = env.HEAD_MASTER_KEY?.trim();
  if (!v) return null;
  const key = /^[A-Za-z0-9+/]{43}=?$/.test(v) ? Buffer.from(v, 'base64') : Buffer.alloc(0);
  if (key.length !== 32) throw new CryptoError('HEAD_MASTER_KEY must be 32 random bytes, base64 (openssl rand -base64 32)');
  return key;
}

/** The deployment's wrap, from HEAD_MASTER_KEY; CryptoError when it is not set. */
export function masterWrap(env: Record<string, string | undefined> = process.env): MasterKeyWrap {
  const key = masterKey(env);
  if (!key) throw new CryptoError('HEAD_MASTER_KEY is not set: the head cannot read or write card content (docs/deploy.md "At rest")');
  return new MasterKeyWrap(key);
}
