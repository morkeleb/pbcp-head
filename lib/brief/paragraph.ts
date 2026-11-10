// The daily paragraph in parts (lib/brief/fold.ts writes it): each entry is one card's "<title> — <lead>" (or
// "<title> — decided <value>"), kept with the card's id and labels, so a view can show only the entries of the labels
// the owner filters by and still write the same sentences. Pure and dependency-free: the fold composes markdown with
// it, the head HTML, the browser the filtered paragraph.
//
// A brief says the few things and counts the rest, weighted by `delivery` (RFC §9). Up to four sentences, each a
// paragraph of its own in a view, one run of prose in the card's lead:
//
//   "2 decisions, 1 snoozed: <entry>; <entry>."                     (or "Nothing waiting for you.")
//   "Tasks: 3 due, 1 overdue: <entry>; <entry>; <entry>."            (RFC 0.9 §8; none when no task is due)
//   "Yesterday you decided: <title> — decided <value>; …; and your orders came back: <order> — done: <lead>."
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
  /** The entry's card's producer, kind and title, added by the head when it serves the parts. */
  producer?: string;
  kind?: string;
  title?: string;
  /** RFC 0.9 §4.1: the entry's card's `sensitivity` as sent, added by the head when it serves the parts. */
  sensitivity?: 'normal' | 'private' | 'confirm';
  /** RFC 0.9 §9: the card's sensitivity raised by the owner's floors, added by the head when it serves the parts. */
  effective_sensitivity?: 'normal' | 'private' | 'confirm';
}

/** Whether an entry is `private` (or `confirm`) as the head served it: counted, never named, outside the signed-in session. */
const isPrivateEntry = (e: ParagraphEntry) => e.effective_sensitivity !== undefined && e.effective_sensitivity !== 'normal';

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
  /** Open tasks due on the day or before, by when they are due (RFC 0.9 §8): "<title> — <lead>", and whether overdue. */
  tasks?: Array<ParagraphEntry & { overdue: boolean }>;
  /** Decisions the owner made the day before: "<title> — decided <value>" ("<title> — done" for a task). */
  decided?: ParagraphEntry[];
  /** The day before's signals delivered immediate or brief, and its brief artifacts from quiet producers, newest first. */
  mattered?: ParagraphEntry[];
  /** Every other thread of the day before (log delivery, or an artifact from a producer that sent many): counted. */
  rest?: CountedThread[];
  /** Orders whose outcome arrived the day before: "<order title> — done: <outcome lead>" (A.3). */
  orders?: ParagraphEntry[];
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

/** Inline HTML (or the fold's markdown) as plain text: tags and markdown link syntax out, entities decoded. */
export function plainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface ComposeOptions {
  /**
   * For a surface outside the owner's signed-in session (an assistant, a voice client, a notification; RFC 0.9 §4.1
   * `private`): entries the head marked private or confirm are counted ("and 1 private decision"), never named, and the
   * text is plain, not HTML.
   */
  spoken?: boolean;
}

/**
 * The paragraph's sentences from its parts, keeping only the entries (and counts) whose card carries one of `chosen`.
 * The first always says what waits ("Nothing waiting for you." when nothing does); the rest are left out when empty.
 */
export function composeParagraphs(parts: ParagraphParts, chosen: readonly string[] = [], opts: ComposeOptions = {}): string[] {
  const keep = <T extends { labels: readonly string[] }>(xs: readonly T[] | undefined) => (xs ?? []).filter((x) => matchesLabels(x.labels, chosen));
  const say = (e: ParagraphEntry) => (opts.spoken ? plainText(e.text) : e.text);
  /** The entries as items: named ones, then the private ones as one count ("and 2 private decisions") when spoken. */
  const items = (xs: readonly ParagraphEntry[], noun: string): string[] => {
    if (!opts.spoken) return xs.map(say);
    const named = xs.filter((e) => !isPrivateEntry(e)).map(say);
    const hidden = xs.length - named.length;
    return hidden === 0 ? named : [...named, `${named.length > 0 ? 'and ' : ''}${plural(hidden, `private ${noun}`)}`];
  };
  const decisions = keep(parts.decisions);
  const snoozed = parts.snoozed.filter((l) => matchesLabels(l, chosen)).length;
  const tasks = keep(parts.tasks);
  const out: string[] = [];
  const allPrivate = (xs: readonly ParagraphEntry[]) => opts.spoken === true && xs.length > 0 && xs.every(isPrivateEntry);
  if (decisions.length > 0)
    out.push(
      allPrivate(decisions)
        ? `${plural(decisions.length, 'private decision')}${snoozed > 0 ? `, ${snoozed} snoozed` : ''}.`
        : `${plural(decisions.length, 'decision')}${snoozed > 0 ? `, ${snoozed} snoozed` : ''}: ${items(decisions, 'decision').join('; ')}.`,
    );
  else if (tasks.length === 0) out.push(snoozed > 0 ? `Nothing waiting for you; ${plural(snoozed, 'decision')} snoozed.` : 'Nothing waiting for you.');
  else if (snoozed > 0) out.push(`No decisions; ${snoozed} snoozed.`);
  if (tasks.length > 0) {
    const overdue = tasks.filter((t) => t.overdue).length;
    const head = `Tasks: ${tasks.length} due${overdue > 0 ? `, ${overdue} overdue` : ''}`;
    out.push(allPrivate(tasks) ? `${head}, ${tasks.length === 1 ? 'a private one' : 'all private'}.` : `${head}: ${items(tasks, 'task').join('; ')}.`);
  }

  const before = keep(parts.yesterday);
  if (before.length > 0) out.push(`Yesterday: ${items(before, 'matter').join('; ')}.`);

  const decided = keep(parts.decided);
  const orders = keep(parts.orders);
  const told = (xs: ParagraphEntry[], noun: string) => items(xs, noun).join('; ');
  if (decided.length > 0 && orders.length > 0) out.push(`Yesterday you decided: ${told(decided, 'matter')}; and your orders came back: ${told(orders, 'order')}.`);
  else if (decided.length > 0) out.push(`Yesterday you decided: ${told(decided, 'matter')}.`);
  else if (orders.length > 0) out.push(`Yesterday your orders came back: ${told(orders, 'order')}.`);
  const mattered = keep(parts.mattered);
  if (mattered.length > 0) {
    // Spoken, the private ones are left out of the six named and counted after them.
    const open = opts.spoken ? mattered.filter((e) => !isPrivateEntry(e)) : mattered;
    const hidden = mattered.length - open.length;
    const shown = open.slice(0, MATTERED_SHOWN).map(say);
    const more = open.length - shown.length;
    const tail = [...(more > 0 ? [`and ${more} more`] : []), ...(hidden > 0 ? [`and ${plural(hidden, 'private matter')}`] : [])];
    out.push(`What mattered yesterday: ${(shown.length > 0 ? [...shown, ...tail] : [plural(hidden, 'private matter')]).join('; ')}.`);
  }
  const rest = keep(parts.rest);
  if (rest.length > 0) out.push(decided.length + orders.length + mattered.length > 0 ? `And ${counted(rest)}.` : `Yesterday: ${counted(rest)}.`);
  return out;
}

/** The paragraph as one run of prose: the nightly card's lead (§3.1), and the head's `daily_paragraph.html`. */
export function composeParagraph(parts: ParagraphParts, chosen: readonly string[] = [], opts: ComposeOptions = {}): string {
  return composeParagraphs(parts, chosen, opts).join(' ');
}
