# Local first: the brief on the device

The brief opens at once from the device's own copy and reconciles when the head answers; a decision made on the train lands when the network returns; search runs over the device and the head holds no index of the person's content. Three benefits, one architecture: a store on the device, synced forward from a cursor, with an index and an outbox beside it. It is the client half of the trust story (docs/trust.md), and the architecture the native app mirrors: SQLite (WAL) for the store, FTS5 for the index and an outbox table, where the web app has IndexedDB, MiniSearch and an object store.

The protocol does not change. Nothing is queued for producers; the outbox is the owner's.

## The parts (app/(ui)/local/)

| Part | File | What it is |
| --- | --- | --- |
| The event feed | `feed.ts` | The head's change counter is the log. Each change is a full card snapshot stamped with `change_seq`, read with `GET /api/me/cards?after=<cursor>` (every state: open, decided, superseded), applied latest-wins by id. Snapshots, not deltas: a device can join at any cursor, and an evicted store rebuilds from the feed. No second log on the server. |
| The projection | `store.ts`, `db.ts` | IndexedDB, one database per owner (`pbcp-<head>`): the cards as /api/me returns them (`rendered_lead`, `rendered_html` included) with a day index; meta rows (the cursor, `settings_seq` and the floors, retention, the brief the head last composed, the orders list); the outbox. Reads lay the outbox over the head's snapshots. |
| The index | `search.ts` | MiniSearch over title, summary, lead and the body's plain text (from `rendered_html`), built from the store when search first opens, updated card by card, pruned on eviction. Never sent anywhere. |
| The command outbox | `outbox.ts` | Decide (done and a comment included), acknowledge, snooze, unsnooze: the card settles on the device at once, and a row is appended (card id, action, payload, the `change_seq` seen, a client id, the time). The only thing that writes to the head. |

## Sync

- **The cursor.** A sync asks `GET /api/me/seq` first and stops there when nothing moved. Otherwise it pages `GET /api/me/cards?after=<cursor>` and applies each card by id. Owner actions move the counter (acknowledge, seen, snooze), so a decision on another device arrives like a new card. (The feed's cursor parameter is `after`, the `change_seq` the route has always paged by; `since` on that route is a `received_at` filter.)
- **The first sync** pulls the days ahead (two weeks) and the retention window (90 days by default), a week at a time, newest first, then catches up from the counter it read before it began. Later syncs run on open, on focus, once a minute while the brief is on screen, and when a push arrives.
- **Retention.** 90 days by default, a setting (Preferences → On this device). Older days leave the store and the index unless the owner chose "Download the archive", which pulls everything back to the head's first card and asks the browser to keep the store (`navigator.storage.persist()`). The head keeps everything regardless.
- **Freshness on screen.** A cold open with a store shows the brief the head last composed, its cards from the store, the dateline marked "as of <time>" until the sync returns. The brief's composition (its paragraph, folds and lists) is the head's, kept on the device and refreshed when the counter or the date moves; every card in it is the device's.
- **Sensitivity.** The device syncs with its own session, never an assistant's scoped token (which the head redacts, lib/me.ts `redactForAssistant`). A floor the owner raises changes no card, so the feed cannot carry it: `GET /api/me/seq` carries `settings_seq`, which moves in the same transaction as any floor change; when it moves the device refetches the floors (`GET /api/me/settings` `sensitivity_floors`) and recomputes every stored card's `effective_sensitivity` with core's `effectiveSensitivity`. An open card that became `confirm` then asks for the passkey before its outbox row is sent.

## The outbox

A sender drains the rows in order whenever the device is online, under a web lock (`navigator.locks`) so two tabs never send the same row, through the existing owner routes. The routes are idempotent on the card, so a replay after a crash is safe.

| The head answers | On the device |
| --- | --- |
| 2xx | The row leaves; the head's card replaces the device's |
| 409 (decided or replaced elsewhere) | The head's state wins, the row is dropped, the card says "Decided on another device: …" (the 409 body is the stored card, so no second fetch) |
| 403 `reauthentication_required` (a `confirm` card) | The row waits, and every row behind it; the card says "Needs your passkey to confirm" with "Confirm with passkey", which runs the step-up and sends it again |
| Any other 4xx | The row is dropped, the card goes back to the head's state, and a line says what was refused |
| No network, or 5xx | The row stays; tried again after 1 s, 10 s, 1 min, then every 5 min while the app is open, and at once when the browser comes back online |

A row is never reordered: the person decided them in that order. The outbox is the device's and is never synced: a decision made offline on the phone is the phone's to send; the laptop learns of it through the head. The masthead says "N changes waiting to send" while the outbox holds any. A `confirm` card is never decided by the device alone: online the passkey is asked first; offline the row waits and the head asks at replay. Giving an order needs the network.

## Platform limits

- **Safari evicts.** Storage can be cleared after seven days without use, and a private window has none. Every IndexedDB access is wrapped (`db.ts withStore`): an empty, throwing or evicted store degrades to the network, as the app was before, and the first sync runs again. The installed app keeps its storage.
- **Quota.** Preferences shows the store's size; the archive asks for persistent storage.
- **The outbox survives a closed tab, not eviction.** The "waiting to send" count is how it is never silent.
- **Signing out** deletes the device's database; a refresh that fails for want of a network never signs out.
