// GET /api/me/svg/{hash} — a drawn diagram, by sha256 of its sanitised fence (docs/head-skeleton.md, step 4).
//
// No session: an <img> (and the phone's native image view) cannot send one. The hash is of content the
// reader already has in the card, so it grants nothing new; the bytes are immutable, hence the long cache.

import { eq } from 'drizzle-orm';
import { db } from '../../../../../db/client';
import { diagrams } from '../../../../../db/schema';
import { json } from '../../../../../lib/http';

const notFound = () => json({ error: 'not_found', message: 'no such diagram' }, 404);

/**
 * mermaid sizes its SVG `width="100%"` with no height, which an <img> reads as no intrinsic size at all: the
 * browser falls back to 300px wide, and the full-screen viewer, which starts from the natural size, shows the
 * diagram smaller than its thumbnail. The served SVG declares the size its viewBox gives; in a card it is
 * still scaled to the card's width by CSS.
 */
function withIntrinsicSize(svg: string): string {
  return svg.replace(/<svg\b[^>]*>/, (root) => {
    const box = /\sviewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"/.exec(root);
    if (!box || /\sheight="/.test(root)) return root;
    return root.replace(/\swidth="[^"]*"/, '').replace(/^<svg/, `<svg width="${box[1]}" height="${box[2]}"`);
  });
}

export const dynamic = 'force-dynamic';

/** A light drawing shown on a dark page: on its own white ground, so it stays readable there. */
function onWhite(svg: string): string {
  return svg.replace(/<svg\b[^>]*>/, (root) =>
    /\sstyle="/.test(root)
      ? root.replace(/\sstyle="([^"]*)"/, (_m, style: string) => ` style="${style.replace(/;?\s*$/, ';')}background-color:#fff"`)
      : root.replace(/^<svg/, '<svg style="background-color:#fff"'),
  );
}

/**
 * `?theme=dark` (the page is dark): the fence as drawn for a dark page; if that drawing does not exist (it failed, or
 * the card has not been rendered since dark drawings began), the light one on white, cached only briefly so the dark
 * one is served once it exists.
 */
export async function GET(req: Request, { params }: { params: Promise<{ hash: string }> }): Promise<Response> {
  const { hash } = await params;
  if (!/^[0-9a-f]{64}$/.test(hash)) return notFound();
  const dark = new URL(req.url).searchParams.get('theme') === 'dark';
  const [row] = await db().select({ svg: diagrams.svg, svgDark: diagrams.svgDark }).from(diagrams).where(eq(diagrams.hash, hash));
  if (!row?.svg) return notFound();
  const fallback = dark && !row.svgDark;
  const svg = dark ? (row.svgDark ?? onWhite(row.svg)) : row.svg;
  return new Response(withIntrinsicSize(svg), {
    headers: {
      'content-type': 'image/svg+xml; charset=utf-8',
      'cache-control': fallback ? 'public, max-age=60' : 'public, max-age=31536000, immutable',
      ...(fallback ? { 'x-pbcp-theme': 'light' } : {}),
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      'x-content-type-options': 'nosniff',
    },
  });
}
