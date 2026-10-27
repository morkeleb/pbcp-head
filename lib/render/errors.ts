/** A fence mermaid could not draw: deterministic, so it is cached and shown as the §3.1 fallback with this message. */
export class DiagramError extends Error {
  override readonly name = 'DiagramError';
}
