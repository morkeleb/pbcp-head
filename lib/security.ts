// Security headers. Pages get a per-request nonce CSP from proxy.ts; every /api response gets API_HEADERS
// from next.config.ts. Card HTML is sanitised on the server (lib/render); these are the second line.

/**
 * The pages' policy. Scripts run only with this request's nonce, so nothing inside rendered card HTML (an
 * inline handler, a javascript: URL, an injected <script>) can execute. Images come only from the head
 * itself (drawn diagrams at /api/me/svg, the remote-image proxy at /api/me/img) and from data: URIs, which
 * §3.1 requires a head to show (data:image/png, sanitised data:image/svg+xml). Styles allow inline style
 * attributes, which React and the sanitised diagrams use; no style can load anything from elsewhere.
 */
export function pageCsp(nonce: string, dev = process.env.NODE_ENV === 'development'): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
}

/** Headers on every response, page or API. */
export const COMMON_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};

/**
 * API responses are JSON (or an image the route types itself) and are never a document: should one be
 * opened as one, it is sandboxed with no scripts. This includes every response that carries rendered_html.
 */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'; sandbox";
