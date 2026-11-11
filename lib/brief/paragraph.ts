// The daily paragraph in parts (lib/brief/fold.ts writes it): each entry is one card's "<title> — <lead>" (or
// "<title> — decided <value>"), kept with the card's id and labels, so a view can show only the entries of the labels
// the owner filters by and still write the same sentences. Pure and dependency-free: the fold composes markdown with
// it, the head HTML, the browser the filtered paragraph.
//
// A brief names everything and explains only what needs the person (RFC 0.9 §8), and counts the rest, weighted by
// `delivery` (§9). Up to five sentences, each a paragraph of its own in a view, one run of prose in the card's lead:
//
//   "8 decisions, 1 snoozed: <title> — <lead>; <title> — <lead>; 6 the mail reader proposes archiving: <title>, … and <title>."
//                                                                   (or "Nothing waiting for you.")
//   "Tasks: 23 due, 21 overdue and 5 routine."                       (RFC 0.9 §8, §9; none when no task is due)
//   "Yesterday you decided: <title> — decided <value>; …; and your orders came back: <order> — done: <lead>."
//   "What mattered yesterday: <entry>; …; and 3 more."              (at most MATTERED_SHOWN entries)
//   "And 9 updates from mail, goalpath, hermes and obsidian."        (counted, no titles)
//
// A part with nothing is left out. Fold 5 and earlier kept one `yesterday` list instead of the last three; a day
// folded then is still written its way ("Yesterday: <entry>; ….").
//
// The fold (§8): a decision with no `default` action, or whose `urgency` is `immediate`, is named with its lead. Every
// other open decision is folded under its default action with the other cards from its producer that share it, each
// named by its title: "6 the mail reader proposes archiving: Order receipt, Weekly newsletter, …". A fold offers no
// control; each card is decided on its own card. Tasks are counted here and listed in the brief's Tasks section; tasks
// under a label the owner set to fold as a count (§9 `count`) are counted apart, as routine.

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

/**
 * Decisions folded under their producer's shared default action (RFC 0.9 §8): named, never decided, by the fold. The
 * cards are entries of `decisions` (each its linked title alone); `ids` is their order in the fold.
 */
export interface ParagraphFold {
  /** The producer's root. */
  producer: string;
  /** How the brief names the producer: its display name when the owner gave one (producer_tokens.name), else the root. */
  name: string;
  /** The default action's id, and its label from the card (the id when the card gives none). */
  action: string;
  action_label: string;
  ids: string[];
}

export interface ParagraphParts {
  /** Open decisions that are not snoozed, every one named (§8): "<title> — <lead>", or the title alone when folded. */
  decisions: ParagraphEntry[];
  /** Fold 9 on: the decisions folded by producer and default action, beside the entries. */
  folds?: ParagraphFold[];
  /** Snoozed decisions, counted and never listed (§8): only their labels, so a filtered count stays right. */
  snoozed: string[][];
  /**
   * Open tasks due on the day or before, by when they are due (RFC 0.9 §8): "<title> — <lead>", whether overdue, and
   * whether routine (a label the owner set to fold as a count, §9). The paragraph counts them; the Tasks section lists them.
   */
  tasks?: Array<ParagraphEntry & { overdue: boolean; routine?: boolean }>;
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

/**
 * An action's label as what the producer proposes doing: "Archive" → "archiving", "Pay now" → "paying now", "Ship" →
 * "shipping". Mechanical, on the first word: a closing silent e is dropped, a short closing consonant after one vowel
 * doubled; a word already ending in -ing stays.
 */
export function proposing(label: string): string {
  const [first = '', ...rest] = label.trim().split(/\s+/);
  const w = /^[A-Z][a-z]*$/.test(first) ? first.toLowerCase() : first;
  let g: string;
  if (!/^[a-z]+$/.test(w) || w.endsWith('ing')) g = w;
  else if (/ie$/.test(w)) g = `${w.slice(0, -2)}ying`;
  else if (/[^aeiou]e$/.test(w) && w.length > 2) g = `${w.slice(0, -1)}ing`;
  else if (/^[^aeiou]*[aeiou][^aeiouwxy]$/.test(w)) g = `${w}${w.at(-1)}ing`;
  else g = `${w}ing`;
  return [g, ...rest].join(' ');
}

/** "the mail reader proposes archiving" */
export const foldPhrase = (f: Pick<ParagraphFold, 'name' | 'action_label'>) => `${f.name} proposes ${proposing(f.action_label)}`;

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
  /**
   * For a view that shows each fold as one line it can open (DailyBrief): a fold is written as FOLD_MARK, its index in
   * `parts.folds`, FOLD_MARK, and foldViews gives what the line says and the cards it opens to.
   */
  foldMarks?: boolean;
}

/** Brackets a fold's index in a paragraph composed with `foldMarks`. */
export const FOLD_MARK = '\u0001';

/** A fold as a view shows it: "6 the mail reader proposes archiving", and its cards' entries the filter kept. */
export interface FoldView {
  index: number;
  phrase: string;
  entries: ParagraphEntry[];
}

/** Each fold of `parts` after the label filter, by its index; a fold with no card left is absent. */
export function foldViews(parts: ParagraphParts, chosen: readonly string[] = []): FoldView[] {
  const byId = new Map(parts.decisions.filter((e) => matchesLabels(e.labels, chosen)).map((e) => [e.id, e]));
  return (parts.folds ?? []).flatMap((f, index) => {
    const entries = f.ids.map((id) => byId.get(id)).filter((e): e is ParagraphEntry => e !== undefined);
    return entries.length === 0 ? [] : [{ index, phrase: `${entries.length > 1 ? `${entries.length} ` : ''}${foldPhrase(f)}`, entries }];
  });
}

/**
 * The decisions sentence's items (§8): first each card that needs the person, "<title> — <lead>", in the parts' order;
 * then each fold, "6 the mail reader proposes archiving: <title>, … and <title>", its cards those the filter kept. Spoken,
 * a private card is named nowhere, in a fold or out of one, and all of them are counted last ("and 2 private decisions").
 */
function decisionItems(decisions: readonly ParagraphEntry[], folds: readonly ParagraphFold[], opts: ComposeOptions, say: (e: ParagraphEntry) => string): string[] {
  const hide = (e: ParagraphEntry) => opts.spoken === true && isPrivateEntry(e);
  const folded = new Set(folds.flatMap((f) => f.ids));
  const byId = new Map(decisions.map((e) => [e.id, e]));
  const own = decisions.filter((e) => !folded.has(e.id) && !hide(e)).map(say);
  const grouped = folds.flatMap((f, i) => {
    const named = f.ids.map((id) => byId.get(id)).filter((e): e is ParagraphEntry => e !== undefined && !hide(e));
    if (named.length === 0) return [];
    if (opts.foldMarks) return [`${FOLD_MARK}${i}${FOLD_MARK}`];
    return [`${named.length > 1 ? `${named.length} ` : ''}${foldPhrase(f)}: ${listing(named.map(say))}`];
  });
  const hidden = decisions.filter(hide).length;
  const shown = [...own, ...grouped];
  return hidden === 0 ? shown : [...shown, `${shown.length > 0 ? 'and ' : ''}${plural(hidden, 'private decision')}`];
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
        : `${plural(decisions.length, 'decision')}${snoozed > 0 ? `, ${snoozed} snoozed` : ''}: ${decisionItems(decisions, parts.folds ?? [], opts, say).join('; ')}.`,
    );
  else if (tasks.length === 0) out.push(snoozed > 0 ? `Nothing waiting for you; ${plural(snoozed, 'decision')} snoozed.` : 'Nothing waiting for you.');
  else if (snoozed > 0) out.push(`No decisions; ${snoozed} snoozed.`);
  if (tasks.length > 0) {
    // Counted, not named: the Tasks section names each with when it is due (§8). Routine ones (§9 `count`) apart.
    const named = tasks.filter((t) => !t.routine);
    const overdue = named.filter((t) => t.overdue).length;
    const routine = tasks.length - named.length;
    // Overdue is among the due ("23 due, 21 overdue", §4.5); routine is apart ("… and 5 routine").
    const due = named.length > 0 ? `${named.length} due${overdue > 0 ? `, ${overdue} overdue` : ''}` : '';
    out.push(`Tasks: ${[due, routine > 0 ? `${routine} routine` : ''].filter(Boolean).join(' and ')}.`);
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
