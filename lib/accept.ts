// Content negotiation for GET / (RFC §7.5): the describe JSON to producers and the conformance suite, the head's
// front door to a browser. A browser says so in Accept ("text/html,…,*/*;q=0.8"); a client that sends no Accept,
// `*/*`, or `application/json` gets the JSON, exactly as before. HTML only when it is strictly preferred.

/** The q-value a media range gives `type` (e.g. "text/html"): the most specific range that matches, else 0. */
function quality(ranges: Array<{ type: string; q: number }>, type: string): number {
  const [major] = type.split('/');
  const exact = ranges.find((r) => r.type === type);
  if (exact) return exact.q;
  const sub = ranges.find((r) => r.type === `${major}/*`);
  if (sub) return sub.q;
  return ranges.find((r) => r.type === '*/*')?.q ?? 0;
}

function parse(accept: string): Array<{ type: string; q: number }> {
  return accept
    .split(',')
    .map((part) => {
      const [type = '', ...params] = part.split(';').map((s) => s.trim().toLowerCase());
      const q = params.find((p) => p.startsWith('q='));
      const value = q ? Number(q.slice(2)) : 1;
      return { type, q: Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0 };
    })
    .filter((r) => r.type.includes('/'));
}

/** True when the request prefers `text/html` over `application/json`: a browser opening the head's address. */
export function prefersHtml(accept: string | null): boolean {
  if (!accept) return false;
  const ranges = parse(accept);
  return quality(ranges, 'text/html') > quality(ranges, 'application/json');
}
