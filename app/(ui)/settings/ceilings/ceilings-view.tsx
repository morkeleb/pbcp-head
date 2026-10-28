'use client';

// Ceilings (RFC §9): how far each producer's cards may reach, and, optionally, a ceiling per label (§9, 0.7: a head MAY
// set ceilings per label; a card under both takes the lower). Both apply to cards stored from now on; a card already
// stored keeps the delivery it was given. Minimal: one table of producers, one of labels, a select in each row.

import { useCallback, useEffect, useState } from 'react';
import { PageRow } from '../../chrome';
import { api, OfflineError, useOnline } from '../../client';
import { NOT_SENT } from '../../components';

type Urgency = 'log' | 'brief' | 'immediate';
const URGENCIES: Urgency[] = ['log', 'brief', 'immediate'];
const MEANS: Record<Urgency, string> = { log: 'only in the day’s cards', brief: 'in the brief', immediate: 'at once' };

interface Producer { root: string; ceiling: Urgency; revoked: boolean }
interface Label { label: string; cards: number; ceiling: Urgency | null }

export function CeilingsView() {
  const [producers, setProducers] = useState<Producer[] | null>(null);
  const [labels, setLabels] = useState<Label[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const online = useOnline();

  const load = useCallback(async () => {
    const [p, l] = await Promise.all([api<{ producers: Producer[] }>('/api/me/producers'), api<{ labels: Label[] }>('/api/me/labels')]);
    if (p.status !== 200 || l.status !== 200) return setError(`Could not load the ceilings (${p.status === 200 ? l.status : p.status}).`);
    setProducers(p.body.producers.filter((x) => !x.revoked));
    setLabels(l.body.labels);
  }, []);
  useEffect(() => void load(), [load]);

  const patch = async (path: string, ceiling: Urgency | null) => {
    setError(null);
    try {
      const r = await api<{ message?: string }>(path, { method: 'PATCH', body: { ceiling } });
      if (r.status !== 200) setError(r.body?.message ?? `the head answered ${r.status}`);
    } catch (e) {
      setError(e instanceof OfflineError ? NOT_SENT : e instanceof Error ? e.message : 'the request failed');
    }
    await load();
  };

  const select = 'rounded-md border border-input bg-background px-2 py-1 text-body text-foreground disabled:opacity-50';
  return (
    <>
      <PageRow title="Ceilings" />
      <main className="mx-auto max-w-2xl px-4 pb-24 pt-4 min-[900px]:px-6">
        <p className="text-lead text-muted-foreground">
          A ceiling is the furthest a card may reach: {URGENCIES.map((u) => `${u}, ${MEANS[u]}`).join('; ')}. A card under a producer’s ceiling and a label’s takes the lower. Changes apply to cards stored from now on.
        </p>
        {error && <p className="mt-2 text-lead text-destructive" role="alert">{error}</p>}

        <section className="pt-6" aria-labelledby="producers">
          <h3 id="producers" className="pb-2 text-meta font-semibold uppercase tracking-meta text-muted-foreground">Producers</h3>
          {producers === null ? (
            <p className="text-lead text-muted-foreground">Loading…</p>
          ) : (
            <table className="w-full text-body" data-producer-ceilings>
              <tbody className="divide-y border-y">
                {producers.map((p) => (
                  <tr key={p.root}>
                    <th scope="row" className="py-2 pr-3 text-left font-normal">{p.root}</th>
                    <td className="py-2 text-right">
                      <select aria-label={`Ceiling for ${p.root}`} className={select} value={p.ceiling} disabled={!online} onChange={(e) => void patch(`/api/me/producers/${encodeURIComponent(p.root)}`, e.target.value as Urgency)}>
                        {URGENCIES.map((u) => <option key={u} value={u}>{u}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="pt-6" aria-labelledby="labels">
          <h3 id="labels" className="pb-2 text-meta font-semibold uppercase tracking-meta text-muted-foreground">Labels</h3>
          {labels === null ? (
            <p className="text-lead text-muted-foreground">Loading…</p>
          ) : labels.length === 0 ? (
            <p className="text-lead text-muted-foreground">No card carries a label yet.</p>
          ) : (
            <table className="w-full text-body" data-label-ceilings>
              <tbody className="divide-y border-y">
                {labels.map((l) => (
                  <tr key={l.label}>
                    <th scope="row" className="py-2 pr-3 text-left font-normal">
                      {l.label} <span className="text-lead text-muted-foreground">· {l.cards} {l.cards === 1 ? 'card' : 'cards'}</span>
                    </th>
                    <td className="py-2 text-right">
                      <select aria-label={`Ceiling for label ${l.label}`} className={select} value={l.ceiling ?? ''} disabled={!online}
                        onChange={(e) => void patch(`/api/me/labels/${encodeURIComponent(l.label)}`, (e.target.value || null) as Urgency | null)}>
                        <option value="">no ceiling</option>
                        {URGENCIES.map((u) => <option key={u} value={u}>{u}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </main>
    </>
  );
}
