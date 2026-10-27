// The version of the nightly fold (lib/brief/fold.ts), stamped on every `head:daily` card it writes as `x-pbcp-fold`
// (a producer field in the head's private x- namespace, RFC §3.1 "Unknown fields"). A card folded by an older fold,
// or with no stamp at all, does not open today's brief: the live fold does instead. Bump it whenever the shape of
// the nightly card's body or lead changes.
//
//   1  (unstamped) counts as the summary, entries as "producer · title — lead"
//   2  the daily paragraph of leads, each linked; no summary

export const FOLD_FIELD = 'x-pbcp-fold';
export const FOLD_VERSION = 2;

/** The card was folded by the current fold. */
export const currentFold = (card: object): boolean => (card as Record<string, unknown>)[FOLD_FIELD] === FOLD_VERSION;
