// Card builders for the HTTP tests.

export function card(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const producer = id.split(':')[0];
  return {
    protocol: 'pbcp/1',
    id,
    kind: 'decision',
    to_person: 'morten',
    producer,
    title: `Card ${id}`,
    body: 'Evidence.\n\n## Proposal\n\nDo the thing.',
    emitted_at: '2026-10-07T06:00:00Z',
    ...extra,
  };
}

export const cardPath = (id: string) => `/api/cards/${encodeURIComponent(id)}`;
