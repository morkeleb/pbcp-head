// SVG sanitising (§3.1 "Images"): no <script>, no event attributes, no <foreignObject>, no external hrefs,
// no <use> of remote documents. Applied to producers' inline SVG and, as a second line, to mermaid output.

import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';

const g = globalThis as unknown as { __pbcpPurify?: ReturnType<typeof createDOMPurify> };

function purifier() {
  if (!g.__pbcpPurify) {
    const purify = createDOMPurify(new JSDOM('').window as unknown as Parameters<typeof createDOMPurify>[0]);
    purify.addHook('uponSanitizeAttribute', (_node, data) => {
      const name = data.attrName.toLowerCase();
      // Only same-document references (#id) survive; anything else could load or navigate.
      if ((name === 'href' || name === 'xlink:href' || name === 'src') && !data.attrValue.trim().startsWith('#')) data.keepAttr = false;
      if (/url\(\s*['"]?(?!#)/i.test(data.attrValue)) data.keepAttr = false;
    });
    purify.addHook('uponSanitizeElement', (node, data) => {
      // CSS in <style> may @import or url() a remote resource.
      if (data.tagName === 'style' && /@import|url\(\s*['"]?(?!#)/i.test(node.textContent ?? '')) node.textContent = (node.textContent ?? '').replace(/@import[^;]*;?/gi, '').replace(/url\(\s*['"]?(?!#)[^)]*\)/gi, 'none');
    });
    g.__pbcpPurify = purify;
  }
  return g.__pbcpPurify;
}

export function sanitiseSvg(svg: string, opts: { allowStyle?: boolean } = {}): string {
  return purifier().sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ['script', 'foreignObject', 'iframe', 'a', ...(opts.allowStyle ? [] : ['style'])],
    ...(opts.allowStyle ? { ADD_TAGS: ['style'] } : {}),
    FORBID_ATTR: ['onload', 'onclick', 'onerror'],
    WHOLE_DOCUMENT: false,
  });
}
