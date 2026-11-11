// The brief-fold test day (RFC 0.9 §8, §9), shared by the brief, the spoken form and the daily push: eight decisions,
// two that need the owner (no default action) from hermes and six the mail reader proposes archiving.

import { and, eq } from 'drizzle-orm';
import { producerTokens } from '../../db/schema';
import { mintProducerToken } from '../../lib/auth/producer';
import { card, cardPath } from './cards';
import { call, OWNER, testDb } from './helpers';

export const MAIL_TITLES = ['Order receipt', 'Weekly newsletter', 'Shipping update', 'Password reset', 'Event reminder', 'Bank statement'];

/** The plain paragraph the day folds to: the spoken form, and the push's first sentence. */
export const FOLD_DAY_SPOKEN =
  '8 decisions: Reply to Anna — Anna asks whether the invoice can wait until the 20th; Join the offsite — Two days in Aarhus from the 14th, travel booked by the office; ' +
  '6 the mail reader proposes archiving: Order receipt, Weekly newsletter, Shipping update, Password reset, Event reminder and Bank statement.';

/**
 * Puts the day's cards, a minute apart from `start` (the brief lists decisions newest first: the mail oldest, Anna newest),
 * and names the mail producer "the mail reader" as Settings → Producers would.
 */
export async function putFoldDay(start: string, hermes: string): Promise<{ mail: string }> {
  const mail = `Bearer ${await mintProducerToken(testDb(), { headId: OWNER, root: 'mail', ceiling: 'immediate' })}`;
  await testDb().update(producerTokens).set({ name: 'the mail reader' }).where(and(eq(producerTokens.headId, OWNER), eq(producerTokens.root, 'mail')));
  let t = Date.parse(start);
  const tick = () => call('POST', '/api/test', { body: { clock: new Date((t += 60_000)).toISOString().replace(/\.\d+Z$/, 'Z') } });
  for (const [i, title] of [...MAIL_TITLES.entries()].reverse()) {
    await tick();
    const id = `mail:inbox:${i + 1}`;
    await call('PUT', cardPath(id), { auth: mail, body: card(id, { kind: 'decision', title, summary: `From the shop, message ${i + 1}.`, labels: ['inbox'], actions: [{ id: 'archive', label: 'Archive', default: true }, 'keep'] }) });
  }
  await tick();
  await call('PUT', cardPath('hermes:gmail:offsite'), { auth: hermes, body: card('hermes:gmail:offsite', { kind: 'decision', title: 'Join the offsite', summary: 'Two days in Aarhus from the 14th, travel booked by the office.' }) });
  await tick();
  await call('PUT', cardPath('hermes:gmail:anna'), { auth: hermes, body: card('hermes:gmail:anna', { kind: 'decision', title: 'Reply to Anna', summary: 'Anna asks whether the invoice can wait until the 20th.' }) });
  return { mail };
}
