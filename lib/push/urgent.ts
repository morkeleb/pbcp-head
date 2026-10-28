// A push for each card stored with `delivery: immediate` (§9: the urgency after the ceiling, the producer's and its
// labels'), to every device of the owner with "Urgent cards" on and a subscription (Settings → Devices). The PUT route
// calls this after its transaction commits, off the producer's response path: best effort, so a push that fails never
// fails the PUT, and a 410 from the push service removes the subscription (sendPush, lib/push/send.ts).
//
// A replacement of an immediate card sends again only if its title or lead changed; a card that is no longer open by
// the time the push goes (decided, superseded) is not sent.

import { leadOf, type Card } from '@pbcp/core';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { devices } from '../../db/schema';
import { cutSummary } from '../render/lead';
import { load } from '../store';
import { sendPush, type PushPayload, type SendResult } from './send';

export const URGENT_LEAD_MAX = 120;

/** A lead as plain text for a notification: markdown's links, images, emphasis and code marks taken out. */
export function plainLead(card: { summary?: string; body: string }): string {
  const lead = leadOf(card);
  const text =
    lead.source === 'summary'
      ? lead.text
      : lead.text
          .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
          .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
          .replace(/<([a-z]+:[^>\s]+)>/gi, '$1')
          .replace(/^\s*(?:[-*+]|\d{1,9}[.)])[ \t]+/, '')
          .replace(/^\s*(?:>[ \t]?)+/, '')
          .replace(/(\*\*|__|\*|_|~~|`)/g, '');
  return cutSummary(text.replace(/\s+/g, ' ').trim(), URGENT_LEAD_MAX);
}

export function urgentPayload(card: Pick<Card, 'id' | 'title' | 'summary' | 'body'>): PushPayload {
  // The tag replaces an earlier notification for the same card on the device, rather than stacking another.
  return { title: card.title, body: plainLead(card), data: { url: `/card/${encodeURIComponent(card.id)}` }, tag: `pbcp-card:${card.id}` };
}

/** Whether storing `card` over `previous` is a push: immediate now, and new, newly immediate, or with another title or lead. */
export function isUrgentNews(card: Card, previous: Card | null): boolean {
  if (card.delivery !== 'immediate' || card.state !== 'open') return false;
  if (!previous || previous.delivery !== 'immediate') return true;
  return previous.title !== card.title || plainLead(previous) !== plainLead(card);
}

/** Sends the push for a stored card, if it is one; never throws. */
export async function notifyUrgent(db: Db, headId: string, card: Card, previous: Card | null): Promise<Array<{ device: string; result: SendResult }>> {
  try {
    if (!isUrgentNews(card, previous)) return [];
    // As it stands now: decided or superseded since the PUT answered, it is not news any more.
    const current = (await load(db, headId, card.id))?.card;
    if (!current || current.state !== 'open' || current.delivery !== 'immediate') return [];
    const targets = await db
      .select()
      .from(devices)
      .where(and(eq(devices.headId, headId), isNull(devices.revokedAt), eq(devices.notifyUrgent, true), isNotNull(devices.pushEndpoint)));
    const payload = urgentPayload(current);
    const sent: Array<{ device: string; result: SendResult }> = [];
    for (const d of targets) sent.push({ device: d.id, result: await sendPush(db, d, payload).catch((): SendResult => 'failed') });
    return sent;
  } catch {
    return [];
  }
}
