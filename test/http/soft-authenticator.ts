// A software WebAuthn authenticator for the tests: a P-256 key, "none" attestation, signed assertions.
// It produces exactly the JSON a browser's navigator.credentials returns, so the head verifies it with the
// same code path as a real passkey.

import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

type Cbor = number | string | Uint8Array | Cbor[] | Map<Cbor, Cbor> | { [k: string]: Cbor };

function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

/** The CBOR subset WebAuthn needs: small ints, byte and text strings, arrays, maps. */
function cbor(v: Cbor): Buffer {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') {
    const b = Buffer.from(v, 'utf8');
    return Buffer.concat([head(3, b.length), b]);
  }
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
  const entries = v instanceof Map ? [...v.entries()] : Object.entries(v);
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, x]) => [cbor(k), cbor(x)])]);
}

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest();
const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64url');

export class SoftAuthenticator {
  readonly credentialId = randomBytes(16);
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  private signCount = 0;
  private userHandle = '';

  constructor(private readonly origin: string) {
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey;
  }

  get id(): string {
    return b64u(this.credentialId);
  }

  private authData(rpId: string, flags: number, attested?: Buffer): Buffer {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(this.signCount);
    return Buffer.concat([sha256(rpId), Buffer.from([flags]), count, ...(attested ? [attested] : [])]);
  }

  /** navigator.credentials.create() for the given PublicKeyCredentialCreationOptionsJSON. */
  create(options: { challenge: string; rp: { id?: string }; user: { id: string } }) {
    const rpId = options.rp.id ?? new URL(this.origin).hostname;
    this.userHandle = options.user.id;
    const jwk = this.publicKey.export({ format: 'jwk' });
    const coseKey = new Map<Cbor, Cbor>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, Buffer.from(jwk.x!, 'base64url')],
      [-3, Buffer.from(jwk.y!, 'base64url')],
    ]);
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(this.credentialId.length);
    const attested = Buffer.concat([Buffer.alloc(16), idLen, this.credentialId, cbor(coseKey)]);
    const authData = this.authData(rpId, 0x45, attested); // UP | UV | AT
    const clientData = JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: this.origin, crossOrigin: false });
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64u(Buffer.from(clientData)),
        attestationObject: b64u(cbor({ fmt: 'none', attStmt: {}, authData })),
        transports: ['internal'],
      },
      clientExtensionResults: {},
    };
  }

  /** navigator.credentials.get() for the given PublicKeyCredentialRequestOptionsJSON. */
  get(options: { challenge: string; rpId?: string }) {
    const rpId = options.rpId ?? new URL(this.origin).hostname;
    this.signCount++;
    const authData = this.authData(rpId, 0x05); // UP | UV
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: this.origin, crossOrigin: false }));
    const signature = sign('sha256', Buffer.concat([authData, sha256(clientData)]), this.privateKey);
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64u(clientData),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
        userHandle: this.userHandle,
      },
      clientExtensionResults: {},
    };
  }
}
