// Response helpers. Every refusal that does not return a card is `{ error, message }` (RFC §7.4).

import { PbcpError } from '@pbcp/core';

export function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(body, { status, headers });
}

export function refusal(e: PbcpError): Response {
  const headers = e.retryAfter !== undefined ? { 'retry-after': String(e.retryAfter) } : undefined;
  return json(e.toJSON(), e.status, headers);
}

/** Runs a handler body; a PbcpError becomes its §7.4 error response, anything else a 500. */
export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PbcpError) return refusal(e);
    if (e instanceof HttpError) return json({ error: e.code, message: e.message }, e.status);
    console.error(e);
    return json({ error: 'internal', message: 'internal error' }, 500);
  }
}

/** A refusal outside the protocol's code table: the auth routes and test hooks, never a producer route. */
export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

/** The raw (still percent-encoded) path segment at `index`, e.g. 3 for the `{id}` of `/api/cards/{id}`. */
export function rawSegment(req: Request, index: number): string {
  return new URL(req.url).pathname.split('/')[index] ?? '';
}

/**
 * A card id from the URL, percent-decoded exactly once (§7.1). Routes read it from the raw URL rather than
 * the router's params so that an id such as `mail:acme:%3Ca%40b%3E` is never decoded twice or normalised (§5).
 */
export function decodeId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new PbcpError('invalid_id', 'the id in the URL is not valid percent-encoding');
  }
}

/** No request body the head accepts is larger: §3.1's hard card limit. */
export const MAX_BODY_BYTES = 1024 * 1024;

/**
 * The request body as text, read no further than `max` bytes. A declared Content-Length over the limit is
 * refused before a byte of the body is read; a body without one (chunked) is cut off as soon as it passes
 * the limit instead of being buffered whole. Producer routes call this after authenticating and rate
 * limiting, which keeps §7.1's order: 401, 429, then 413.
 */
export async function readBody(req: Request, max = MAX_BODY_BYTES): Promise<string> {
  const tooLarge = () => new PbcpError('too_large', `a request body may be at most ${max} bytes`);
  if (Number(req.headers.get('content-length') ?? 0) > max) throw tooLarge();
  if (!req.body) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = req.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks)); // as Request.text() decodes
}

/** A JSON object body for the auth routes; an empty body is `{}`. */
export async function readObject(req: Request): Promise<Record<string, unknown>> {
  const text = await readBody(req);
  if (text.trim() === '') return {};
  try {
    const v: unknown = JSON.parse(text);
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new HttpError(400, 'invalid_request', 'the body must be a JSON object');
}

/** A protocol request body (§7.3): JSON, or 400 malformed_json. Shape is the core's to judge. */
export async function readJson(req: Request): Promise<unknown> {
  const text = await readBody(req);
  try {
    return JSON.parse(text);
  } catch {
    throw new PbcpError('malformed_json', 'the body is not JSON');
  }
}
