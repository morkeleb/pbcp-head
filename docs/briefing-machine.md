# The briefing machine

The spoken briefing, as a finite state machine. This document is the specification; every client implements it and none defines it: Siri on the iOS app (docs/superpowers/specs/2026-11-10-ios-secretary-design.md), a talk mode in the web app, a future Android app. An implementation is tested against the event lists at the end of this document (and the fixtures made from them), not against another implementation.

**Siri understands the words; the machine decides what comes next.** A client's speech layer (Siri AI, a recogniser with a fixed grammar, a button) turns an utterance into one of the events below and resolves which card it means. The machine holds the agenda, the position, what has been answered and what is said next. Rigid about the sequence, loose about language: any phrasing that maps to an event is fine, and the spoken lines may vary within the rules here.

The machine adds nothing to the protocol. Every event that changes anything is an existing `/api/me/` call with the owner's session (docs/mobile-prd.md, "Human API"), and the RFC (vendor/pbcp/rfc/) governs what those calls mean.

## Shape

A pure transition function:

```
step(state, event, context) → (state', speech, call?)
```

- `state` — the agenda, the position, the outcome of each item so far, the frozen `seq`, and an inner step (below).
- `event` — one of the events below, with its resolved card and option where it has one.
- `context` — what the client knows outside the briefing: whether the device is locked, the owner's "what the assistant may see" setting, whether the person has just identified themselves to the head.
- `speech` — what to say, as structured parts (a client words it); never a card's body.
- `call` — at most one head call to make. The client makes it and feeds the result back as an event (`succeeded`, `failed(status, card?)`).

The state is saved by the client after every event, so a turn can end (a Siri session times out) and the next turn continues. One briefing at a time per device.

## The agenda

`start` fetches `GET /api/me/brief` and freezes its `seq` and its items, in this order:

1. **decisions** — `decisions`, in the brief's order;
2. **tasks** — `tasks`, in the brief's order (by when due, overdue first among equals as the head sends them);
3. **updates** — `threads`, as one item;
4. **order news** — `order_updates`, `lapsed_orders`, `late_outcomes`, as one item.

`start(.sinceLast)` ("What did I miss?") keeps only cards whose id is in the brief's `new`, and order news since the last visit. Cards that arrive during the briefing are not inserted: when the client sees a new `seq`, it may append them at the end ("One more just came in"), so nothing reorders under the person.

## Sensitivity

From RFC Draft 0.9 §4.1 `sensitivity` (`normal`, `private`, `confirm`; see "Sources"). The machine applies the card's **effective** sensitivity: the producer's value, raised by the owner's policy at the head (§9), never lowered. Speech leaves the owner's control (a speaker, a car, a room), so the machine treats every spoken line as outside the signed-in session.

- **`private`** is spoken as a count, never by content:
  - in `opening` and in each section's introduction, private items are counted, not named: "Two decisions and one private decision", "and three private matters";
  - `decision(i)` / `task(i)` on a private card says only its producer and that it is private: "A private one from mail. Open it on screen, or skip?" — never the title or the lead;
  - in a list of updates or order news, a private card is counted ("and one private update"), not named;
  - it is never resolved by content: "the private one", "the second" (position) resolve it; a title or lead does not, because the assistant never had them.
- **`confirm`** is everything `private` is, and the machine never records a decision on it: `answer`, `edit`, `dismiss` or `done` on a confirm card goes to the inner step `needsPerson`, which says "That one needs you to confirm on the phone" and asks the client to show the card (`call: show(card)`). The client's own decide control then has the head re-identify the person before the call (RFC §4.5, §7.4). A `403 reauthentication_required` from the head on any decide is handled the same way: `needsPerson`. `snooze` and `ack` are not decisions and work as on any card.
- **No override.** There is no setting to read private cards aloud. Sensitivity is the producer's floor; the owner may only raise it (§9). The owner's "what the assistant may see" setting (titles and leads / titles only / counts only) applies on top, to `normal` cards.

## States

| State | Says | Accepts | Then |
| --- | --- | --- | --- |
| `opening` | The counts by section, private ones counted apart ("Two decisions and one private one, three tasks, one overdue."), or "Nothing new since 10:15." | `next`, `yes`; any global event | the first agenda item, or `passOn` when the agenda is empty |
| `decision(i)` | `normal`: producer, title — lead (as the visibility setting allows), the options in order with the default first when there is one ("approve, edit, or dismiss?"). `private`/`confirm`: "A private one from *producer*. Open it on screen, or skip?" | `answer(option)`, `edit(text)` when the card offers `edit`, `dismiss`, `snooze(until)`, `skip`, `show` | `acting` → said ("Approved.") → `decision(i+1)` or the next section |
| `task(i)` | `normal`: title, when it is due ("overdue since yesterday"). `private`/`confirm`: as above | `done`, `answer(option)` for a listed action, `dismiss`, `snooze(until)`, `skip`, `show` | as above |
| `updates` | One sentence of titles, private ones counted ("Four updates: the deploy went out, …, and one private update.") | `ack` (yes, okay, noted), `skip` | `orderNews` |
| `orderNews` | What came back from orders, and any order whose executor went quiet (lapsed lease) | `next`, `cancelOrder(order)` | `passOn` |
| `passOn` | "Anything to pass on?" | `order(text, producer?)` → "Sent to the coding agent. Anything else?" (stays), `no` | `close` |
| `close` | "That's everything." | — | `call: visit(frozen seq)`; the briefing ends |

**Inner steps of an item state.**
- `confirming` — entered when the event is ambiguous under the confidence rule; says the alternatives ("The reply to Anna or to Anders?", "Approve, or approve with changes?"); accepts the clarified event or `skip`.
- `needsPerson` — a `confirm` card, or a 403 `reauthentication_required`; says "That one needs you to confirm on the phone"; `call: show(card)`; then the next item. The card stays open; the briefing does not wait for it.
- `blockedLocked` — the event would change something, the device is locked, and the device's while-locked setting is read only; says "Unlock to do that"; the client asks for the device unlock and, on success, replays the event.
- `acting` — the head call is out; on `succeeded`, say the outcome and move on; on `failed`: `409` with the stored card → "That one was already decided on another device: approved." and move on; `403 reauthentication_required` → `needsPerson`; network or 5xx → "I couldn't reach the head; it's still open." and move on. Nothing is queued (docs/mobile-prd.md: nothing is queued offline).

## Events

**Item events** (act on the current item, or on a named card in a quick command): `answer(option)`, `edit(text)`, `dismiss`, `done`, `snooze(until)`, `ack`, `cancelOrder(order)`, `order(text, producer?)`.

**Global events** (any state): `stop` (saves the position and ends the turn; nothing is posted), `skip`, `repeat`, `back` (the previous item, to hear it again; a decided card stays decided, RFC §4.3), `jump(card)` ("first the milestone one"), `show` (asks the client to show the current card; the body is never read), `help` (says what this state accepts), `next`, `yes`, `no`.

An event that does not apply in the current state is answered with what does ("This one's a task: done, later, or skip?").

**Quick commands** are the item events outside a briefing, on a card the person names ("approve the reply to Anna"). They follow the same rules: confidence, sensitivity, while locked. They never move the last-visit cursor.

## What each event calls at the head

| Event | Call | Notes |
| --- | --- | --- |
| `start(.brief)`, `start(.sinceLast)` | `GET /api/me/brief` | The script comes from `daily_paragraph.parts` and the card lists, never from the HTML; each entry carries its sensitivity (a head change, see the design) |
| `answer(option)` | `POST /api/me/cards/{id}/decision` `{ decision: option }` | The option resolved from the card's `actions` and `rendered_actions` by id, label or position, or the default |
| `edit(text)` | same, `{ decision: "edited", edited_proposal: text }` | Only when `actions` lists `edit` |
| `dismiss` | same, `{ decision: "dismissed" }` | |
| `done` | same, `{ decision: "done" }` | A task; always offered (RFC 0.9 §4.1, §4.5) |
| `snooze(until)` | `POST /api/me/cards/{id}/snooze` | Tonight, tomorrow's brief, next week, or a time |
| `ack` | `POST /api/me/cards/{id}/ack`, for each card of the item | |
| `order(text, producer?)` | `POST /api/me/orders` | `to_producer`: the producer named, resolved against each producer's `name` (Settings), then its root; `*` when none is named; ask when the name matches none or several. The text is sent as dictated; the executor interprets it (RFC A.1, docs/mobile-prd.md) |
| `cancelOrder(order)` | `POST /api/me/cards/{id}/decision` `{ decision: "dismissed" }` on the order | RFC A.1 |
| `show` | none (the client shows the card) | Sets `seen_at` as opening a card does on screen |
| reaching `close` | `POST /api/me/visit` `{ seq: frozen seq }` | Only here. A paused or expired briefing posts nothing |

## Confidence

The speech layer gives the machine a resolved card and option, not a confidence score, so "unsure" is this rule. It applies to the briefing and to quick commands alike.

- **A card named by content** (from the assistant's index or a string query) acts at once only when the utterance contains a word from the card's title. A match on the lead or the producer alone goes to `confirming` first ("The milestone review from the project tracker?").
- **Several cards match** → `confirming` with the candidates.
- **The option** must match one of the card's options by id, rendered label or position; near two of them, or none → `confirming`.
- **"This one", "the second"**: while a briefing is active, the current item / the agenda's second; otherwise what is on screen; neither → `confirming`.
- **A recogniser with a confidence** (a client's own speech recognition): below its threshold, the event is repeated back as a question.
- **Private and confirm cards** are never matched by content; only by position or "the private one".

One clear match acts at once. Nothing else asks.

## While locked

The device's while-locked setting (read only, the default; or read and act) applies to every event that calls the head except `start`: in a briefing and in a quick command alike. Read only: a changing event goes to `blockedLocked`. A `confirm` card needs the person whatever the setting.

## Keeping a briefing

- Saved after every event, on the device. One per device.
- A paused briefing (after `stop`, or a turn that ended) resumes on the next `start`: "Shall we pick up at decision 2 of 4?" — `no` starts afresh.
- It expires at the end of its local day, or when the head's `seq` shows every item on its agenda decided or superseded elsewhere. An expired briefing never resumes and posts nothing.

## Event lists

Each list is a test: a brief (a recorded `/api/me/brief` response), a context, the events, and the expected states, speech parts and calls. Fixtures are made from these and shipped beside this document when the first implementation lands.

1. **A morning, straight through.** Two decisions (one with default `approve`), one task overdue, two updates. `start(.brief)` → `opening` (2 decisions, 1 task overdue, 2 updates) · `yes` → `decision(0)` · `answer(approve)` → `acting`, call decision `approve` · `succeeded` → `decision(1)` · `skip` → `task(0)` · `done` → call decision `done` · `succeeded` → `updates` · `ack` → call ack ×2 · → `orderNews` (empty, skipped) → `passOn` · `order("update the docs", "coding agent")` → call orders · `succeeded` → `passOn` · `no` → `close`, call visit(frozen seq).
2. **Paused and resumed.** As 1 to `task(0)` · `stop` → saved, no call · `start(.brief)` → "pick up at task 1 of 1?" · `yes` → `task(0)`.
3. **A private decision.** Decisions: one normal, one `private`. `opening` speaks "one decision and one private decision" · at the private one, the speech has the producer and no title or lead · `answer(approve)` → acts (private is not confirm) · a quick command naming the private card's title resolves nothing.
4. **A confirm decision.** `decision(0)` is `confirm` · `answer(approve)` → `needsPerson`, call show(card), no decision call · → next item. `snooze(tomorrow)` on the same card → call snooze.
5. **Re-identification refused.** `answer(approve)` on a `normal` card whose effective sensitivity the head raised to `confirm` · call decision → `failed(403 reauthentication_required)` → `needsPerson`.
6. **Decided elsewhere.** `answer(approve)` → `failed(409, card decided reject)` → speech "already decided on another device: rejected" → next item.
7. **Locked, read only.** Context locked, setting read only · `answer(approve)` → `blockedLocked`, no call · unlock succeeds → replayed → call decision.
8. **Lead-only match.** Quick command "approve the invoice one" where "invoice" is only in the lead → `confirming` (not acted) · `yes` → call decision.
9. **What did I miss?** `new` holds one decision and one update · `start(.sinceLast)` → agenda of two items only · to `close` → call visit(frozen seq).
10. **Expired.** A briefing saved yesterday · `start(.brief)` today → a fresh briefing, no resume offered.

## Sources

- RFC Draft 0.9, `vendor/pbcp/rfc/pbcp-draft-0.9.md`: §4.1 (`task`; `sensitivity`), §4.1a, §4.3, §4.5, §7.3–§7.4, §8, §9, §12, Appendix A. **The `sensitivity` text is not yet in a published draft:** it is in uncommitted work on the `rfc-0.9-sensitivity` branch of `morkeleb/pbcp` (Nov 10, 2026), with no PR yet. This document follows that text; when it lands (and the head's pin moves), cite the section numbers from the published draft.
- docs/mobile-prd.md: the Human API, gestures, nothing queued offline, orders dictated and interpreted by the executor.
