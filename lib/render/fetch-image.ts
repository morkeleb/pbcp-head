// Fetching a remote image for the proxy (§3.1 Images): https only, public addresses only (checked at
// connect time, so a DNS answer cannot change between the check and the connection), no cookies, bounded
// size and time, image types only; SVG is sanitised like any inline SVG.

import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { Agent, fetch } from 'undici';
import { sanitiseSvg } from './svg';

const MAX_BYTES = 5 * 1024 * 1024;
const TYPES = /^image\/(png|jpeg|gif|webp|avif|svg\+xml)$/;

/** Loopback, private, link-local, CGNAT, multicast and reserved ranges, v4 and v6. */
export function isPublicAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)));
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPublicAddress(v6.slice(7));
  return !(v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith('ff'));
}

const agent = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
        if (err) return callback(err, '', 0);
        const list = addresses as LookupAddress[];
        const bad = list.find((a) => !isPublicAddress(a.address));
        if (bad || list.length === 0) return callback(new Error(`refusing to fetch from ${bad?.address ?? 'nowhere'}`), '', 0);
        if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
        callback(null, list[0]!.address, list[0]!.family);
      });
    },
  },
});

export interface FetchedImage {
  type: string;
  body: Uint8Array<ArrayBuffer>;
}

export async function fetchImage(url: string): Promise<FetchedImage | null> {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    let u: URL;
    try {
      u = new URL(current);
    } catch {
      return null;
    }
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    if (isIP(u.hostname.replace(/^\[|\]$/g, '')) && !isPublicAddress(u.hostname.replace(/^\[|\]$/g, ''))) return null;
    const res = await fetch(u, { dispatcher: agent, redirect: 'manual', signal: AbortSignal.timeout(10_000), headers: { accept: 'image/*' } }).catch(() => null);
    if (!res) return null;
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location')!, u).href;
      continue;
    }
    const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!res.ok || !TYPES.test(type) || Number(res.headers.get('content-length') ?? 0) > MAX_BYTES || !res.body) return null;
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > MAX_BYTES) return null;
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);
    if (type === 'image/svg+xml') return { type, body: new Uint8Array(Buffer.from(sanitiseSvg(body.toString("utf8")))) };
    return { type, body: new Uint8Array(body) };
  }
  return null;
}
