// The daily paragraph in parts (lib/brief/fold.ts writes it): each entry is one card's "<title> — <lead>", kept with
// the card's id and labels, so a view can show only the entries of the labels the owner filters by and still write
// the same sentence. Pure and dependency-free: the fold composes markdown with it, the head HTML, the browser the
// filtered paragraph.
//
//   "4 decisions, 1 snoozed: <entry>; <entry>. Yesterday: <entry>; <entry>."

export interface ParagraphEntry {
  id: string;
  labels: string[];
  /** The entry as the paragraph writes it: markdown in the fold, safe inline HTML from the head. */
  text: string;
}

export interface ParagraphParts {
  /** Open decisions that are not snoozed, listed (§8). */
  decisions: ParagraphEntry[];
  /** Snoozed decisions, counted and never listed (§8): only their labels, so a filtered count stays right. */
  snoozed: string[][];
  /** The previous day's threads, by their newest unsnoozed card. */
  yesterday: ParagraphEntry[];
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Whether a card with `labels` passes a filter of `chosen` labels: any of them, or every card when none is chosen. */
export const matchesLabels = (labels: readonly string[], chosen: readonly string[]) => chosen.length === 0 || labels.some((l) => chosen.includes(l));

/**
 * The paragraph from its parts, keeping only the entries (and snoozed counts) whose card carries one of `chosen`.
 * Empty when nothing is left: no sentence for its own sake.
 */
export function composeParagraph(parts: ParagraphParts, chosen: readonly string[] = []): string {
  const keep = (labels: readonly string[]) => matchesLabels(labels, chosen);
  const decisions = parts.decisions.filter((e) => keep(e.labels));
  const snoozed = parts.snoozed.filter(keep).length;
  const yesterday = parts.yesterday.filter((e) => keep(e.labels));
  const sentences: string[] = [];
  if (decisions.length + snoozed > 0) {
    const count = `${plural(decisions.length, 'decision')}${snoozed > 0 ? `, ${snoozed} snoozed` : ''}`;
    sentences.push(`${count}${decisions.length ? `: ${decisions.map((e) => e.text).join('; ')}` : ''}.`);
  }
  if (yesterday.length > 0) sentences.push(`Yesterday: ${yesterday.map((e) => e.text).join('; ')}.`);
  return sentences.join(' ');
}
