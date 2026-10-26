// https images in card bodies are loaded through the head (§3.1: a head SHOULD proxy remote images and MUST
// NOT send cookies fetching them). The URL is signed so the route is not an open proxy; an <img> cannot
// carry a Session header, so the signature is the credential.

import { createHmac, timingSafeEqual } from 'node:crypto';

const key = () => {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error('SESSION_SECRET is not set');
  return `image-proxy:${s}`;
};

export const signImageUrl = (url: string): string => createHmac('sha256', key()).update(url).digest('base64url');

export function verifyImageUrl(url: string, sig: string): boolean {
  const expected = Buffer.from(signImageUrl(url));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export const proxiedImageSrc = (url: string): string => `/api/me/img?u=${encodeURIComponent(url)}&s=${signImageUrl(url)}`;
