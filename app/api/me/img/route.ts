// GET /api/me/img?u=<https url>&s=<signature> — the remote-image proxy (§3.1: no cookies, size-limited).
// The renderer signs every image URL it emits; anything unsigned is refused, so this is not an open proxy.

import { json } from '../../../../lib/http';
import { fetchImage } from '../../../../lib/render/fetch-image';
import { verifyImageUrl } from '../../../../lib/render/proxy';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const url = q.get('u') ?? '';
  if (!verifyImageUrl(url, q.get('s') ?? '')) return json({ error: 'forbidden', message: 'the image URL is not signed by this head' }, 403);
  const image = await fetchImage(url);
  if (!image) return json({ error: 'image_unavailable', message: 'the image could not be fetched, or is not an image of at most 2 MB' }, 502);
  return new Response(new Uint8Array(image.body), {
    headers: {
      'content-type': image.type,
      'cache-control': 'public, max-age=86400',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      'x-content-type-options': 'nosniff',
    },
  });
}
