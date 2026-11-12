// Written once by Clay (ts-store, a touch file) and never overwritten: edit it freely.
//
// IndexedDB index choices the model does not state (model/model.json `store` states the ones every client needs). An
// index added here needs STORE_VERSION raised in the model, so the browser runs the upgrade that creates it.

import type { CARDS, META, OUTBOX } from './model.generated';

export const EXTRA_INDEXES: Partial<Record<typeof CARDS | typeof META | typeof OUTBOX, Array<{ name: string; keyPath: string }>>> = {};
