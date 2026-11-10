'use client';

// The index (docs/local-first.md): a projection of the store, built in memory from it when search first opens,
// updated card by card as the sync applies them, and pruned when retention evicts a day. It is never sent anywhere,
// and the head holds no index of the person's content. Title, summary, the lead and the body's plain text (stripped
// from rendered_html: the store holds rendered output, never markdown).

import MiniSearch from 'minisearch';
import type { MeCard } from '../components';
import { allCards, getCard, onStore } from './store';

interface Doc {
  id: string;
  title: string;
  summary: string;
  lead: string;
  body: string;
  producer: string;
  day: string;
  kind: string;
}

const text = (html: string | undefined) =>
  (html ?? '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

const doc = (c: MeCard): Doc => ({
  id: c.id,
  title: c.title,
  summary: c.summary ?? '',
  lead: text(c.rendered_lead),
  body: text(c.rendered_html),
  producer: c.producer,
  day: c.day ?? c.received_at.slice(0, 10),
  kind: c.kind,
});

let index: MiniSearch<Doc> | null = null;
let building: Promise<MiniSearch<Doc> | null> | null = null;

function fresh(): MiniSearch<Doc> {
  return new MiniSearch<Doc>({
    fields: ['title', 'summary', 'lead', 'body', 'producer'],
    storeFields: ['title', 'producer', 'day', 'kind'],
    searchOptions: { boost: { title: 3, summary: 2, lead: 1.5 }, prefix: true, fuzzy: 0.15, combineWith: 'AND' },
  });
}

/** The index, built from the store the first time it is asked for; null when there is no store. */
export function searchIndex(): Promise<MiniSearch<Doc> | null> {
  if (index) return Promise.resolve(index);
  building ??= (async () => {
    const cards = await allCards();
    if (!cards) return null;
    const m = fresh();
    m.addAll(cards.map(doc));
    index = m;
    return m;
  })().finally(() => (building = null));
  return building;
}

// Card by card as the store changes: replaced when the sync applies it, removed when it is evicted.
if (typeof window !== 'undefined') {
  onStore(async (e) => {
    if (!index || !e.cards) return;
    for (const id of e.cards) {
      const c = await getCard(id);
      if (index.has(id)) index.discard(id);
      if (c) index.add(doc(c));
    }
  });
}

export interface Hit {
  id: string;
  title: string;
  producer: string;
  day: string;
  kind: string;
}

/** Cards matching every word of `q`, best first, grouped by day, newest day first. */
export async function search(q: string, limit = 50): Promise<Array<{ day: string; hits: Hit[] }> | null> {
  const m = await searchIndex();
  if (!m) return null;
  if (!q.trim()) return [];
  const hits = m.search(q).slice(0, limit) as unknown as Hit[];
  const days = new Map<string, Hit[]>();
  for (const h of hits) days.set(h.day, [...(days.get(h.day) ?? []), h]);
  return [...days.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([day, hits]) => ({ day, hits }));
}

/** Forgets the index (sign-out, or a store rebuilt). */
export function dropIndex(): void {
  index = null;
}
