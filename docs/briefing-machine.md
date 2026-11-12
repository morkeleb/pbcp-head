# The briefing machine

The spoken briefing, as a finite state machine. This document is the specification; every client implements it and none defines it: Siri on the iOS app (docs/superpowers/specs/2026-11-10-ios-secretary-design.md), a talk mode in the web app, a future Android app. An implementation is tested against the event lists at the end of this document (and the fixtures made from them), not against another implementation.

**Siri understands the words; the machine decides what comes next.** A client's speech layer (Siri AI, a recogniser with a fixed grammar, a button) turns an utterance into one of the events below and resolves which card it means. The machine holds the agenda, the position, what has been answered and what is said next. Rigid about the sequence, loose about language: any phrasing that maps to an event is fine, and the spoken lines may vary within the rules here.

The machine adds nothing to the protocol. Every event that changes anything is an existing `/api/me/` call with the owner's session (docs/mobile-prd.md, "Human API"), made through the device's outbox, and the RFC (vendor/pbcp/rfc/) governs what those calls mean.

**Local first.** A client that runs the machine is local first (docs/local-first.md): it has a store of the head's cards synced from the change cursor, a search index and an outbox, as the web app has in `app/(ui)/local/` and the native app in SQLite (WAL), FTS5 and an outbox table. The machine reads its agenda from the store, never from a live request, and every changing call goes to the outbox, which sends it when the device is online and reports what the head answered.

## Shape

A pure transition function:

```
step(state, event, context) → (state', speech, call?)
```

- `state` — the agenda, the position, the outcome of each item so far, the frozen cursor, and an inner step (below).
- `event` — one of the events below, with its resolved card and option where it has one.
- `context` — what the client knows outside the briefing: whether the device is locked, the owner's "what the assistant may see" setting, whether the session is within the head's re-identification window (below, "Sensitivity").
- `speech` — what to say, as structured parts (a client words it); never a card's body.
- `call` — at most one command for the outbox (or `show`, `visit`). The client hands it to the outbox and feeds back what became of it as an event (`succeeded`, `queued`, `failed(status, card?)`).

The state is saved by the client after every event, so a turn can end (a Siri session times out) and the next turn continues. One briefing at a time per device.

## The agenda

`start` runs a sync (docs/local-first.md, "Sync") and then reads, from the store, the brief the head last composed and the cards it names; it freezes the store's cursor (the `change_seq` the store has applied, the head's `seq` as of that sync) and these items, in this order:

1. **decisions** — the brief's `decisions` that are in no fold, in the brief's order; then each fold of `daily_paragraph.parts.folds`, as one item (`fold(i)`), in the parts' order; then the private decisions taken out of folds (below, "Folds"), each its own item;
2. **tasks** — the brief's `tasks` that are not routine, in the brief's order (by when due, overdue first among equals as the head sends them); then the routine tasks, as one item (`routine`);
3. **updates** — `threads`, as one item;
4. **order news** — `order_updates`, `lapsed_orders`, `late_outcomes`, as one item.

When the sync cannot reach the head, the agenda is read from the store as it is, and the opening says so ("As of 08:10."). `start(.sinceLast)` ("What did I miss?") keeps only cards whose id is in the brief's `new`, and order news since the last visit. Cards that arrive during the briefing are not inserted: when a later sync moves the store's cursor, the client may append them at the end ("One more just came in"), so nothing reorders under the person.

**Floors.** When a sync finds that `settings_seq` in `GET /api/me/seq` moved (lib/me.ts `briefStamp`), the client refetches the floors and recomputes every stored card's `effective_sensitivity`, exactly as the web app does (`app/(ui)/local/feed.ts`); an item of the frozen agenda whose card became `private` or `confirm` is from then on spoken and handled as one, even mid-briefing.

## Folds

From RFC Draft 0.9 §8 ("What a brief contains") and the paragraph's parts (lib/brief/paragraph.ts): a decision with a `default` action and not `urgency: immediate` may be folded with the other cards from its producer that share that default, and the parts carry each fold (`producer`, `name`, `action`, `action_label`, `ids`) beside the entries. A fold names and links each card; it **decides nothing and offers no control of its own**: each card is decided on its own card (§4.5).

- `fold(i)` reads the fold's line: the count, the producer's name and what it proposes, and each card's title: "Three the mail reader proposes archiving: Order receipt, Weekly newsletter and Parking notice. Go through them, or skip?"
- `goThrough` expands the fold into `decision(j)` for each of its cards, in the fold's order, each with its own options; after the last, the agenda goes on after the fold.
- `skip` or `next` moves past the whole fold; nothing is posted, and its cards stay open.
- There is no approve on a fold. `answer(option)` at `fold(i)`, whatever the option (the fold's own action included), is answered with what applies: "That's a group: go through them, or skip?"
- **Private cards in a fold** are counted as the spoken paragraph counts them (lib/brief/paragraph.ts `decisionItems`): they are taken out of the fold, which names and counts only its `normal` cards, and become private decision items after the folds, counted with the other private decisions ("and two private decisions"). A fold left with no `normal` card is not an item.

**Routine tasks.** Tasks under a label the owner set to fold as a count (RFC §9 "Folding", the `count` policy; `routine: true` in the parts' `tasks`) are read as a count and never itemised unless asked: `routine` says "And five routine tasks." and accepts `goThrough` (expands into `task(j)` for each, in the brief's order), `skip` or `next`.

## Moves

From RFC §4.3 ("Deciding a task": moving) and §8 ("A task superseded by a task has moved"). A task decided with a reschedule action, such as `tomorrow`, keeps its obligation: the producer that sent it supersedes it with a new `kind: task` card that carries the new time.

- On `succeeded` for a reschedule action, the machine says "Moved to tomorrow" (the action's label), not "Done", and expects no closing record: the successor task arrives later through the sync and is shown on its own day.
- A task that leaves the agenda because a sync brought a successor task that supersedes it has **moved**, not been decided elsewhere: at its turn the machine says "That one has moved to Thursday" (the successor's day, from the store) and goes on. The same holds when the outbox answers `409` with the task `superseded` by a task.
- A moved task is never counted as done in what the machine says.

## Sensitivity

From RFC Draft 0.9 §4.1 `sensitivity` (`normal`, `private`, `confirm`; see "Sources"). The machine applies the card's **effective** sensitivity: the producer's value, raised by the owner's policy at the head (§9), never lowered. Speech leaves the owner's control (a speaker, a car, a room), so the machine treats every spoken line as outside the signed-in session.

- **`private`** is spoken as a count, never by content:
  - in `opening` and in each section's introduction, private items are counted, not named: "Two decisions and one private decision", "and three private matters";
  - `decision(i)` / `task(i)` on a private card says only its producer and that it is private: "A private one from mail. Open it on screen, or skip?" — never the title or the lead;
  - in a fold, in a list of updates or in order news, a private card is counted ("and one private update"), not named (above, "Folds");
  - it is never resolved by content: "the private one", "the second" (position) resolve it; a title or lead does not, because the assistant never had them.
- **`confirm`** is everything `private` is, and the machine never records a decision on it: `answer`, `edit`, `dismiss` or `done` on a confirm card goes to the inner step `needsPerson`, which says "That one needs you to confirm on the phone" and asks the client to show the card (`call: show(card)`). The client's own decide control then runs the head's passkey step-up (`POST /api/auth/passkey/step-up/options`, then `POST /api/auth/passkey/step-up`) before the command is sent (RFC §4.5, §7.4). The step-up marks the session re-identified for `REAUTH_WINDOW_SECONDS`, 300 seconds (lib/auth/reauth-window.ts); a passkey sign-in or a Sign in with Apple sign-in starts a session already re-identified; a refresh does not (docs/trust.md). A `403 reauthentication_required` from the head on any decide is handled the same way: `needsPerson`, and the outbox row waits for the step-up, with every row behind it. `snooze` and `ack` are not decisions and work as on any card.
- **No override.** There is no setting to read private cards aloud. Sensitivity is the producer's floor; the owner may only raise it (§9). The owner's "what the assistant may see" setting (titles and leads / titles only / counts only) applies on top, to `normal` cards.

## States

| State | Says | Accepts | Then |
| --- | --- | --- | --- |
| `opening` | The counts by section, private ones counted apart, routine tasks apart ("Two decisions and one private one, three tasks, one overdue, and five routine."), or "Nothing new since 10:15." | `next`, `yes`; any global event | the first agenda item, or `passOn` when the agenda is empty |
| `decision(i)` | `normal`: producer, title — lead (as the visibility setting allows), the options in order with the default first when there is one ("approve, edit, or dismiss?"). `private`/`confirm`: "A private one from *producer*. Open it on screen, or skip?" | `answer(option)`, `edit(text)` when the card offers `edit`, `dismiss`, `snooze(until)`, `skip`, `show` | `acting` → said ("Approved.") → `decision(i+1)` or the next section |
| `fold(i)` | The fold's line: count, producer's name, what it proposes, each `normal` card's title ("Three the mail reader proposes archiving: …. Go through them, or skip?") | `goThrough`, `skip`, `next`, `show` | `goThrough`: `decision(j)` for each card of the fold, then the item after the fold; otherwise the item after the fold |
| `task(i)` | `normal`: title, when it is due ("overdue since yesterday"). `private`/`confirm`: as above | `done`, `answer(option)` for a listed action (a reschedule such as `tomorrow` included), `dismiss`, `snooze(until)`, `skip`, `show` | as above; a reschedule is said as a move ("Moved to tomorrow.") |
| `routine` | The routine tasks as a count ("And five routine tasks.") | `goThrough`, `skip`, `next` | `goThrough`: `task(j)` for each, then `updates`; otherwise `updates` |
| `updates` | One sentence of titles, private ones counted ("Four updates: the deploy went out, …, and one private update.") | `ack` (yes, okay, noted), `skip` | `orderNews` |
| `orderNews` | What came back from orders, and any order whose executor went quiet (lapsed lease) | `next`, `cancelOrder(order)` | `passOn` |
| `passOn` | "Anything to pass on?" | `order(text, producer?)` → "Sent to the coding agent. Anything else?" (stays), `no` | `close` |
| `close` | "That's everything." | — | `call: visit(frozen cursor)`; the briefing ends |

**Inner steps of an item state.**
- `confirming` — entered when the event is ambiguous under the confidence rule; says the alternatives ("The reply to Anna or to Anders?", "Approve, or approve with changes?"); accepts the clarified event or `skip`.
- `needsPerson` — a `confirm` card, or a 403 `reauthentication_required`; says "That one needs you to confirm on the phone"; `call: show(card)`; then the next item. The card stays open; the briefing does not wait for it.
- `blockedLocked` — the event would change something, the device is locked, and the device's while-locked setting is read only; says "Unlock to do that"; the client asks for the device unlock and, on success, replays the event.
- `acting` — the command is with the outbox, which settles the card on the device at once and sends it in order (docs/local-first.md, "The outbox"). What came of it:
  - `succeeded` (2xx): say the outcome ("Approved.", "Moved to tomorrow.") and move on;
  - `failed(409)` with the stored card: decided on another device → "That one was already decided on another device: approved."; superseded by a task → "That one has moved to Thursday." (above, "Moves"); either way move on;
  - `failed(403 reauthentication_required)` → `needsPerson`;
  - `failed(4xx)`, any other → "The head refused that: *its message*." and move on; the card is as the head has it;
  - `queued` (no network, or 5xx; or behind a row that waits for the passkey) → "I've kept that; it goes when you're back online." (behind a waiting row: "…; it goes once you confirm the one waiting on your passkey."), and move on. The outbox sends it later with nothing more from the person.
  - An `order` is not queued: giving an order needs the network (docs/local-first.md). On no network or 5xx, `passOn` says "I couldn't reach the head; say it again when you're back online." and stays.

## Events

**Item events** (act on the current item, or on a named card in a quick command): `answer(option)`, `edit(text)`, `dismiss`, `done`, `snooze(until)`, `ack`, `goThrough`, `cancelOrder(order)`, `order(text, producer?)`.

**Global events** (any state): `stop` (saves the position and ends the turn; nothing is posted), `skip`, `repeat`, `back` (the previous item, to hear it again; a decided card stays decided, RFC §4.3), `jump(card)` ("first the milestone one"; a card inside a fold jumps to its `decision(j)`), `show` (asks the client to show the current card, or the fold's cards; the body is never read), `help` (says what this state accepts), `next`, `yes`, `no`.

An event that does not apply in the current state is answered with what does ("This one's a task: done, later, or skip?"; at a fold: "go through them, or skip?").

**Quick commands** are the item events outside a briefing, on a card the person names ("approve the reply to Anna"). They follow the same rules: confidence, sensitivity, while locked, the outbox. They never move the last-visit cursor. A quick command on a fold ("archive all the mail ones") is refused as at `fold(i)`: each card is decided on its own.

## What each event calls at the head

Every changing call is a row in the outbox (docs/local-first.md); the head's route is the one the row is sent to.

| Event | Call | Notes |
| --- | --- | --- |
| `start(.brief)`, `start(.sinceLast)` | a sync: `GET /api/me/seq`, then `GET /api/me/cards?after=<cursor>` when it moved; `GET /api/me/settings` when `settings_seq` moved; `GET /api/me/brief` when the counter or the date moved | The agenda is read from the store afterwards. The script comes from `daily_paragraph.parts` (entries, `folds`, `tasks` with `routine`) and the card lists, never from the HTML; each entry carries its `sensitivity` and `effective_sensitivity` |
| `answer(option)` | `POST /api/me/cards/{id}/decision` `{ decision: option }` | The option resolved from the card's `actions` and `rendered_actions` by id, label or position, or the default |
| `edit(text)` | same, `{ decision: "edited", edited_proposal: text }` | Only when `actions` lists `edit` |
| `dismiss` | same, `{ decision: "dismissed" }` | |
| `done` | same, `{ decision: "done" }` | A task; always offered (RFC 0.9 §4.3, §4.5) |
| `snooze(until)` | `POST /api/me/cards/{id}/snooze` | Tonight, tomorrow's brief, next week, or a time |
| `ack` | `POST /api/me/cards/{id}/ack`, for each card of the item | |
| `goThrough` | none | Expands a fold or the routine tasks into items |
| `order(text, producer?)` | `POST /api/me/orders`, directly (needs the network) | `to_producer`: the producer named, resolved against each producer's `name` (Settings), then its root; `*` when none is named; ask when the name matches none or several. The text is sent as dictated; the executor interprets it (RFC A.1, docs/mobile-prd.md) |
| `cancelOrder(order)` | `POST /api/me/cards/{id}/decision` `{ decision: "dismissed" }` on the order | RFC A.1 |
| `show` | none (the client shows the card) | Sets `seen_at` as opening a card does on screen |
| reaching `close` | `POST /api/me/visit` `{ seq: frozen cursor }` | Only here. A paused or expired briefing posts nothing |

## Confidence

The speech layer gives the machine a resolved card and option, not a confidence score, so "unsure" is this rule. It applies to the briefing and to quick commands alike.

- **A card named by content** (from the assistant's index or a string query) acts at once only when the utterance contains a word from the card's title. A match on the lead or the producer alone goes to `confirming` first ("The milestone review from the project tracker?").
- **Several cards match** → `confirming` with the candidates.
- **The option** must match one of the card's options by id, rendered label or position; near two of them, or none → `confirming`.
- **"This one", "the second"**: while a briefing is active, the current item / the agenda's second (inside an expanded fold, the fold's second); otherwise what is on screen; neither → `confirming`.
- **A recogniser with a confidence** (a client's own speech recognition): below its threshold, the event is repeated back as a question.
- **Private and confirm cards** are never matched by content; only by position or "the private one".

One clear match acts at once. Nothing else asks.

## While locked

The device's while-locked setting (read only, the default; or read and act) applies to every event that calls the head except `start`: in a briefing and in a quick command alike. Read only: a changing event goes to `blockedLocked`. A `confirm` card needs the person whatever the setting.

## Keeping a briefing

- Saved after every event, on the device. One per device.
- A paused briefing (after `stop`, or a turn that ended) resumes on the next `start`: "Shall we pick up at decision 2 of 4?" — `no` starts afresh.
- It expires at the end of its local day, or when the store, after a sync, shows every item on its agenda decided, superseded or moved elsewhere (each card's state read from the store as of its cursor). An expired briefing never resumes and posts nothing.

## Event lists

Each list is a test: a store (a recorded set of cards and the brief the head last composed, with its cursor), a context, the events, and the expected states, speech parts and calls. Fixtures are made from these and shipped beside this document when the first implementation lands.

1. **A morning, straight through.** Two decisions (one with default `approve`), one task overdue, two updates. `start(.brief)` → `opening` (2 decisions, 1 task overdue, 2 updates) · `yes` → `decision(0)` · `answer(approve)` → `acting`, call decision `approve` · `succeeded` → `decision(1)` · `skip` → `task(0)` · `done` → call decision `done` · `succeeded` → `updates` · `ack` → call ack ×2 · → `orderNews` (empty, skipped) → `passOn` · `order("update the docs", "coding agent")` → call orders · `succeeded` → `passOn` · `no` → `close`, call visit(frozen cursor).
2. **Paused and resumed.** As 1 to `task(0)` · `stop` → saved, no call · `start(.brief)` → "pick up at task 1 of 1?" · `yes` → `task(0)`.
3. **A private decision.** Decisions: one normal, one `private`. `opening` speaks "one decision and one private decision" · at the private one, the speech has the producer and no title or lead · `answer(approve)` → acts (private is not confirm) · a quick command naming the private card's title resolves nothing.
4. **A confirm decision.** `decision(0)` is `confirm` · `answer(approve)` → `needsPerson`, call show(card), no decision call · → next item. `snooze(tomorrow)` on the same card → call snooze.
5. **Re-identification refused.** `answer(approve)` on a `normal` card whose effective sensitivity the head raised to `confirm` · call decision → `failed(403 reauthentication_required)` → `needsPerson`; the outbox row waits.
6. **Decided elsewhere.** `answer(approve)` → `failed(409, card decided reject)` → speech "already decided on another device: rejected" → next item.
7. **Locked, read only.** Context locked, setting read only · `answer(approve)` → `blockedLocked`, no call · unlock succeeds → replayed → call decision.
8. **Lead-only match.** Quick command "approve the invoice one" where "invoice" is only in the lead → `confirming` (not acted) · `yes` → call decision.
9. **What did I miss?** `new` holds one decision and one update · `start(.sinceLast)` → agenda of two items only · to `close` → call visit(frozen cursor).
10. **Expired.** A briefing saved yesterday · `start(.brief)` today → a fresh briefing, no resume offered.
11. **A fold, skipped.** Decisions: one with no default; three from the mail reader folded under `archive`. `start(.brief)` → `opening` · `yes` → `decision(0)` · `skip` → `fold(0)`, speech: the count 3, the producer's name, "archiving", the three titles · `answer(archive)` → speech "go through them, or skip?", no call · `skip` → the next section, no call; the three cards stay open.
12. **A fold, gone through, with a private card in it.** The fold's `ids` are four cards, one `private`. `opening` counts "and one private decision" · `fold(0)` names and counts three · `goThrough` → `decision(j)` for the three in the fold's order · `answer(archive)` on each → call decision `archive` ×3 · → the private decision as its own item ("A private one from mail. Open it on screen, or skip?").
13. **Routine tasks.** Two tasks due, five under a label set to `count`. `opening` says "two tasks due and five routine" · `task(0)`, `task(1)` · → `routine`, speech "five routine tasks", no titles · `skip` → `updates`. Again with `goThrough` → `task(j)` ×5.
14. **Moved to tomorrow.** `task(0)` lists the action `tomorrow` · `answer(tomorrow)` → call decision `tomorrow` · `succeeded` → speech "Moved to tomorrow", not "done" · → next item. A later sync brings the producer's successor task superseding it, on tomorrow's day: nothing is said and the briefing is not expired by it.
15. **Moved before its turn.** `task(1)` is superseded by a successor task in a sync during the briefing · at its turn → speech "That one has moved to *the successor's day*", no call → next item; not "decided elsewhere".
16. **Offline.** The sync at `start` fails · `opening` says "As of *the store's time*" · `answer(approve)` → `queued` → speech "I've kept that; it goes when you're back online" → next item · `order("…")` → speech "I couldn't reach the head; say it again when you're back online", no outbox row.
17. **A floor raised mid-briefing.** A sync during the briefing finds `settings_seq` moved and the floors raise the mail producer to `private` · the next mail decision is spoken as "A private one from mail", and a mail card inside an unopened fold is taken out of the fold and counted.

## Sources

- RFC Draft 0.9, `vendor/pbcp/rfc/pbcp-draft-0.9.md`, as pinned at `8cbd0e6`: §4.1 (`task`; the `sensitivity` row: `private` keeps the lead and body off notifications, assistant indexes and surfaces outside the signed-in session, and a locked device shows producer and kind only; `confirm` records no decision without the person identifying again), §4.1a ("`sensitivity` is how carefully"), §4.3 ("Deciding a task": ending, and moving by a successor task), §4.5 ("Identifying again", "Presenting a task"), §7.3 and §7.4 (`403 reauthentication_required`, `409` with the stored card), §8 ("What a brief contains": a fold names each card and offers no control of its own; tasks under a `count` label may be counted; a task superseded by a task has moved), §9 ("Sensitivity": the owner raises, never lowers; "Folding": `list` or `count` per label), §11.3, §12 ("Sensitivity is a floor"), Appendix A.
- The head's side, on main: docs/local-first.md and `app/(ui)/local/` (`feed.ts`: the sync and the `settings_seq` floor refetch; `store.ts`, `db.ts`: the store; `search.ts`: the index; `outbox.ts`: the outbox and how it answers). docs/local-first.md replaces docs/mobile-prd.md's former "nothing is queued offline".
- lib/brief/paragraph.ts (`ParagraphParts`: `folds`, `tasks` with `routine`; `decisionItems`: private cards counted outside a fold when spoken), lib/brief/fold.ts (the fold, and routine tasks under a `count` label), lib/me.ts `briefStamp` (`seq`, `date`, `settings_seq` in `GET /api/me/seq`).
- docs/trust.md ("Sensitivity"); in /api/me each card's and each paragraph entry's `sensitivity` and `effective_sensitivity`; `GET /api/me/brief?spoken=1`; the passkey step-up at `POST /api/auth/passkey/step-up` and `/options`, with `REAUTH_WINDOW_SECONDS` in lib/auth/reauth-window.ts.
- docs/mobile-prd.md: the Human API, gestures, orders dictated and interpreted by the executor.
