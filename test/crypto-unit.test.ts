// lib/crypto.ts: sealing values under a head's data key, wrapping the data key under the master key, and failing closed.

import { describe, expect, it } from 'vitest';
import { canonicalJson, CryptoError, digest, isSealed, masterKey, MasterKeyWrap, newDataKey, open, seal } from '../lib/crypto';
import { openCardRow, sealDoc, splitDoc } from '../lib/vault';

const flip = (sealed: string, at: number) => {
  const b = Buffer.from(sealed.slice(3), 'base64');
  b[at] = b[at]! ^ 0x01;
  return `e1:${b.toString('base64')}`;
};

describe('values', () => {
  it('round-trips, with a fresh nonce each time', () => {
    const k = newDataKey();
    const a = seal(k, 'morten', 'cards.doc', 'Reply to Anna');
    const b = seal(k, 'morten', 'cards.doc', 'Reply to Anna');
    expect(isSealed(a)).toBe(true);
    expect(a).not.toBe(b);
    expect(a).not.toContain('Anna');
    expect(open(k, 'morten', 'cards.doc', a)).toBe('Reply to Anna');
  });

  it('fails closed on a flipped byte anywhere, another key, another head or another column', () => {
    const k = newDataKey();
    const s = seal(k, 'morten', 'cards.doc', 'Reply to Anna');
    const n = Buffer.from(s.slice(3), 'base64').length;
    for (const at of [0, 11, 12, n - 17, n - 1]) expect(() => open(k, 'morten', 'cards.doc', flip(s, at))).toThrow(CryptoError);
    expect(() => open(newDataKey(), 'morten', 'cards.doc', s)).toThrow(CryptoError);
    expect(() => open(k, 'lena', 'cards.doc', s)).toThrow(CryptoError);
    expect(() => open(k, 'morten', 'cards.rendered_html', s)).toThrow(CryptoError);
    expect(() => open(k, 'morten', 'cards.doc', 'Reply to Anna')).toThrow(CryptoError);
  });

  it('digests equal content equally, under the key only', () => {
    const k = newDataKey();
    expect(digest(k, 'cards.doc', canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }))).toBe(digest(k, 'cards.doc', canonicalJson({ a: [2, { c: 4, d: 3 }], b: 1 })));
    expect(digest(k, 'cards.doc', 'x')).not.toBe(digest(newDataKey(), 'cards.doc', 'x'));
  });
});

describe('the data key under the master key', () => {
  it('wraps and unwraps per head, and refuses another head, another master key or a tampered wrap', () => {
    const m = new MasterKeyWrap(Buffer.alloc(32, 1));
    const k = newDataKey();
    const w = m.wrap('morten', k);
    expect(w.startsWith('m1:')).toBe(true);
    expect(m.unwrap('morten', w).equals(k)).toBe(true);
    expect(() => m.unwrap('lena', w)).toThrow(CryptoError);
    expect(() => new MasterKeyWrap(Buffer.alloc(32, 2)).unwrap('morten', w)).toThrow(CryptoError);
    const b = Buffer.from(w.slice(3), 'base64');
    b[20] = b[20]! ^ 1;
    expect(() => m.unwrap('morten', `m1:${b.toString('base64')}`)).toThrow(CryptoError);
  });

  it('reads HEAD_MASTER_KEY as 32 bytes of base64, and nothing else', () => {
    expect(masterKey({})).toBeNull();
    expect(masterKey({ HEAD_MASTER_KEY: Buffer.alloc(32, 9).toString('base64') })!.length).toBe(32);
    expect(() => masterKey({ HEAD_MASTER_KEY: 'too-short' })).toThrow(CryptoError);
    expect(() => masterKey({ HEAD_MASTER_KEY: Buffer.alloc(16).toString('base64') })).toThrow(CryptoError);
  });
});

describe('a card at rest (lib/vault.ts)', () => {
  const doc = {
    protocol: 'pbcp/1', id: 'mail:x:1', kind: 'decision', to_person: 'morten', producer: 'mail', title: 'Divorce lawyer', summary: 'Fees attached.',
    body: 'The fee is DKK 40,000.', labels: ['divorce-lawyer'], source: { url: 'https://mail.example/1', label: 'Mail' }, actions: [{ id: 'pay', label: 'Pay', body: 'Now.' }],
    thread: 't-1', about: '2026-11-10', urgency: 'brief', sensitivity: 'private', emitted_at: '2026-11-10T09:00:00Z', 'x-custom': 'secret too',
  };

  it('keeps routing metadata clear and seals the rest, labels and unknown fields included', () => {
    const { clear, secret } = splitDoc(doc);
    expect(Object.keys(clear).sort()).toEqual(['about', 'emitted_at', 'id', 'kind', 'producer', 'protocol', 'sensitivity', 'thread', 'to_person', 'urgency']);
    expect(Object.keys(secret).sort()).toEqual(['actions', 'body', 'labels', 'source', 'summary', 'title', 'x-custom']);
  });

  it('opens a row back to the document as accepted', () => {
    const k = newDataKey();
    const s = sealDoc(k, 'morten', doc);
    expect(JSON.stringify(s.clear)).not.toMatch(/Divorce|40,000|divorce-lawyer|secret too/);
    const row = { headId: 'morten', id: 'mail:x:1', producerDoc: s.clear, content: { v: 1, mac: s.mac, doc: s.doc } } as unknown as Parameters<typeof openCardRow>[0];
    expect(openCardRow(row, k).producerDoc).toEqual(doc);
  });
});
