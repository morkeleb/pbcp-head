// How a pairing code looks, in one sentence for every place that describes it: /connect, /llms.txt, Settings and the
// API document (pbcp issue #25). POST /api/pair ignores case and separators (lib/settings/pairing.ts `normaliseCode`).

export const PAIRING_CODE_SHAPE = 'six characters shown as two groups of three (XXX-XXX); the dash is optional when entering';
