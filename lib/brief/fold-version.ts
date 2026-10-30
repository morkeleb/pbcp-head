// The version of the nightly fold (lib/brief/fold.ts), stamped on every `head:daily` card it writes as `x-pbcp-fold`
// (a producer field in the head's private x- namespace, RFC §3.1 "Unknown fields"). A card folded by an older fold,
// or with no stamp at all, does not open today's brief: the live fold does instead. Bump it whenever the shape of
// the nightly card's body or lead changes.
//
//   1  (unstamped) counts as the summary, entries as "producer · title — lead"
//   2  the daily paragraph of leads, each linked; no summary
//   3  snoozed decisions left out of the paragraph and counted apart ("4 decisions, 1 snoozed")
//   4  each paragraph entry is the card's title, linked, then " — " and its lead
//   5  no snoozed card in the entries either (RFC 0.6 §8 correction); a thread shows its newest unsnoozed card
//   6  the day before in three parts weighted by delivery: what was decided, what mattered (named, six at most), the
//      rest counted by producer; "Nothing waiting for you." on a quiet day
//   7  orders (A.3): an order whose outcome arrived is told with what was decided ("<order> — done: <lead>"), an order
//      that only progressed is counted among the rest; their cards are not threads of their own

export const FOLD_FIELD = 'x-pbcp-fold';
export const FOLD_VERSION = 7;
/** The first fold whose lead is the daily paragraph. */
const PARAGRAPH_SINCE = 2;

const foldOf = (card: object): number => {
  const v = (card as Record<string, unknown>)[FOLD_FIELD];
  return typeof v === 'number' ? v : 1;
};

/** The card was folded by the current fold: it may open today's brief. */
export const currentFold = (card: object): boolean => foldOf(card) === FOLD_VERSION;

/** The card's lead is a daily paragraph (fold 2 on): it opens its own day on the timeline, as it was written then. */
export const hasParagraph = (card: object): boolean => foldOf(card) >= PARAGRAPH_SINCE;
