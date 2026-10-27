// POST /api/render/draw — draws one sanitised mermaid fence to SVG (lib/render/drawer.ts). Internal: the
// head calls it while rendering a card, with a key derived from SESSION_SECRET. It is the only route that
// loads Chromium, so on Vercel it is its own function with the memory and duration set in vercel.json.

import { handle, HttpError, json, readObject } from '../../../../lib/http';
import { drawSvg } from '../../../../lib/render/draw';
import type { DrawResponse } from '../../../../lib/render/drawer';
import { verifyDrawKey } from '../../../../lib/render/drawer';
import { DiagramError } from '../../../../lib/render/errors';
import { MAX_FENCE_BYTES } from '../../../../lib/render/mermaid';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export function POST(req: Request): Promise<Response> {
  return handle(async () => {
    if (!verifyDrawKey(req.headers.get('x-pbcp-draw-key'))) throw new HttpError(401, 'unauthorized', 'internal route');
    const { source, svgId, theme } = await readObject(req);
    if (typeof source !== 'string' || typeof svgId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(svgId) || Buffer.byteLength(source) > MAX_FENCE_BYTES || (theme !== undefined && theme !== 'light' && theme !== 'dark')) {
      throw new HttpError(400, 'invalid_request', 'expected { source, svgId, theme? }');
    }
    try {
      return json({ svg: await drawSvg(source, svgId, theme ?? 'light') } satisfies DrawResponse);
    } catch (e) {
      if (e instanceof DiagramError) return json({ error: 'diagram', message: e.message } satisfies DrawResponse, 422);
      throw e;
    }
  });
}
