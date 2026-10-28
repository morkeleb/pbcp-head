// The daily paragraph in parts (lib/brief/fold.ts writes it): each entry is one card's "<title> — <lead>" (or
// "<title> — decided <value>"), kept with the card's id and labels, so a view can show only the entries of the labels
// the owner filters by and still write the same sentences. Pure and dependency-free: the fold composes markdown with
// it, the head HTML, the browser the filtered paragraph.
//
// A brief says the few things and counts the rest, weighted by `delivery` (RFC §9). Up to four sentences, each a
// paragraph of its own in a view, one run of prose in the card's lead:
//
//   "2 decisions, 1 snoozed: <entry>; <entry>."                     (or "Nothing waiting for you.")
//   "Yesterday you decided: <title> — decided <value>; …."
//   "What mattered yesterday: <entry>; …; and 3 more."              (at most MATTERED_SHOWN entries)
//   "And 9 updates from mail, goalpath, hermes and obsidian."        (counted, no titles)
//
// A part with nothing is left out. Fold 5 and earlier kept one `yesterday` list instead of the last three; a day
// folded then is still written its way ("Yesterday: <entry>; ….").

export interface ParagraphEntry {
  id: string;
  labels: string[];
  /** The entry as the paragraph writes it: markdown in the fold, safe inline HTML from the head. */
  text: string;
}

/** A thread that is counted, not named: its producer and labels only. */
export interface CountedThread {
  producer: string;
  labels: string[];
}

export interface ParagraphParts {
  /** Open decisions that are not snoozed, listed (§8). */
  decisions: ParagraphEntry[];
  /** Snoozed decisions, counted and never listed (§8): only their labels, so a filtered count stays right. */
  snoozed: string[][];
  /** Decisions the owner made the day before: "<title> — decided <value>". */
  decided?: ParagraphEntry[];
  /** The day before's signals delivered immediate or brief, and its brief artifacts from quiet producers, newest first. */
  mattered?: ParagraphEntry[];
  /** Every other thread of the day before (log delivery, or an artifact from a producer that sent many): counted. */
  rest?: CountedThread[];
  /** Fold 5 and earlier: the previous day's threads, one list. */
  yesterday?: ParagraphEntry[];
}

/** How many entries "What mattered" names before "and N more". */
export const MATTERED_SHOWN = 6;

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Whether a card with `labels` passes a filter of `chosen` labels: any of them, or every card when none is chosen. */
export const matchesLabels = (labels: readonly string[], chosen: readonly string[]) => chosen.length === 0 || labels.some((l) => chosen.includes(l));

/** "a", "a and b", "a, b and c". */
export const listing = (items: readonly string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/** "9 updates from mail, goalpath and hermes": producers by how many threads each has, most first, then by name. */
function counted(rest: CountedThread[]): string {
  const by = new Map<string, number>();
  for (const t of rest) by.set(t.producer, (by.get(t.producer) ?? 0) + 1);
  const producers = [...by.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([p]) => p);
  return `${plural(rest.length, 'update')} from ${listing(producers)}`;
}

/**
 * The paragraph's sentences from its parts, keeping only the entries (and counts) whose card carries one of `chosen`.
 * The first always says what waits ("Nothing waiting for you." when nothing does); the rest are left out when empty.
 */
export function composeParagraphs(parts: ParagraphParts, chosen: readonly string[] = []): string[] {
  const keep = <T extends { labels: readonly string[] }>(xs: readonly T[] | undefined) => (xs ?? []).filter((x) => matchesLabels(x.labels, chosen));
  const decisions = keep(parts.decisions);
  const snoozed = parts.snoozed.filter((l) => matchesLabels(l, chosen)).length;
  const out: string[] = [];
  if (decisions.length > 0) out.push(`${plural(decisions.length, 'decision')}${snoozed > 0 ? `, ${snoozed} snoozed` : ''}: ${decisions.map((e) => e.text).join('; ')}.`);
  else out.push(snoozed > 0 ? `Nothing waiting for you; ${plural(snoozed, 'decision')} snoozed.` : 'Nothing waiting for you.');

  const before = keep(parts.yesterday);
  if (before.length > 0) out.push(`Yesterday: ${before.map((e) => e.text).join('; ')}.`);

  const decided = keep(parts.decided);
  if (decided.length > 0) out.push(`Yesterday you decided: ${decided.map((e) => e.text).join('; ')}.`);
  const mattered = keep(parts.mattered);
  if (mattered.length > 0) {
    const shown = mattered.slice(0, MATTERED_SHOWN).map((e) => e.text);
    const more = mattered.length - shown.length;
    out.push(`What mattered yesterday: ${[...shown, ...(more > 0 ? [`and ${more} more`] : [])].join('; ')}.`);
  }
  const rest = keep(parts.rest);
  if (rest.length > 0) out.push(decided.length + mattered.length > 0 ? `And ${counted(rest)}.` : `Yesterday: ${counted(rest)}.`);
  return out;
}

/** The paragraph as one run of prose: the nightly card's lead (§3.1), and the head's `daily_paragraph.html`. */
export function composeParagraph(parts: ParagraphParts, chosen: readonly string[] = []): string {
  return composeParagraphs(parts, chosen).join(' ');
}
