# Design: the head on iOS, a secretary you talk to

Nov 10, 2026 · @Morten Nielsen · design, before the plan · revised Nov 10 (gate, sensitivity, push, the machine as a shared spec) · revised Nov 12 for main as it stands (local first, folds, moves, the step-up route, at-rest step two)

## Intent

The head is modelled on the brief a secretary gives an executive (RFC §1): what happened since you last looked, the decisions that need you, and a place to give orders back. On the iPhone the head should *be* that secretary, and you should be able to **talk to it as you would to one**: in the morning, and between meetings, ask "what's new?", hear it, answer each thing as it comes, and give it instructions to pass on. Voice first; the screen is the same brief the web app already has, there when you want to look.

iOS 27 may make this possible now. Siri AI shipped in beta with iOS 27 [A1]; third-party apps can integrate with it through App Intents in a developer preview on the iOS 27.3 betas, with App Store submission opening in the spring [A2]. A home-screen web app cannot take part: only a native app can expose intents and entities to Siri [A3]. Whether Siri AI can carry a briefing is not yet known; step 1 below is a gate that decides it.

The app adds nothing to the protocol (docs/mobile-prd.md): it is one more client of `/api/me/`, with the owner's session credential. Siri is a new way of speaking to that client, not a new party in the protocol.

## Goals

1. **Talk to it like a secretary.** "Brief me", "Anything new?", "What's waiting for me?" get a spoken answer in a secretary's register: short, what matters first, then "Shall we go through them?". You answer each decision by voice ("approve", "send the second one", "later"), tick tasks ("done"), and give orders ("tell the mail agent to chase the invoice").
2. **Between meetings is a first-class moment.** "What did I miss?" reports only what changed since the last time you spoke or looked (the brief's `last_visit` cursor, `new`, `order_updates`, `lapsed_orders`), and moves the cursor when you're done.
3. **The app looks like the web app.** The same three screens (Brief, Card, Orders) plus Settings, the same seven components under the same names, the same tokens (docs/mobile-prd.md, "The components"). The web brief is the reference.
4. **Push that the secretary would do:** the daily "your brief is ready" at the owner's time and urgent cards (`delivery: immediate`) as they arrive, over APNs, with the card's actions on the notification where its sensitivity allows.

## Non-goals

- No LLM in the app or the head for this. Siri AI does the language understanding; the app only exposes entities and intents. The brief arrives written (mobile-prd).
- No change to the RFC, and no head behaviour only Siri can reach: every intent is an existing `/api/me/` call.
- No offline mode of its own. The app is local first as the web app is (docs/local-first.md): the brief opens from the device's store, and a decision made without a network settles on the device and waits in the outbox until it returns. Giving an order needs the network (docs/local-first.md, "The outbox").
- Not Android (later, same API, same machine), not iPad- or Mac-specific layouts in v1.
- The app does not create tasks or cards of its own, and never appears to. Tasks belong to their producers (RFC §1.1: not a system of record for tasks); something the person wants done is an **order** (Appendix A), and a to-do tool is an executor (A.4).

## Anti-goals (failure even if it works)

- **A command line with a voice.** If using it means remembering phrases ("Decide card hermes-gmail-19a4 approve"), it has failed. References are natural: "the reply to Anna", "this one", "the second".
- **Reading the inbox aloud.** A secretary summarises and asks; it does not recite every card. Speech is the title and the lead at most; bodies stay on screen; private cards are counted, never read.
- **Deciding the wrong card.** Voice acts at once (owner's call: no confirmation step) *unless* the confidence rule says the match is weak; then it asks. A misheard decision is permanent (RFC §4.3).
- **A second product.** The app must not drift from the web brief; differences are only what iOS does better (Siri, haptics, notifications).

## Constraints

- **Built around Siri AI, behind a gate.** The owner has Siri AI on their iPhone. Siri AI needs an Apple Intelligence device (iPhone 15 Pro and later) set to a supported language, and is **not available in the EU** on iOS [A1][A2]. Fixed-phrase App Shortcuts and talk mode cover those cases.
- **Any head.** The app connects to any head URL, the owner's and self-hosted ones alike (owner's answer). See "Connecting to a head".
- **iOS 27.3 or later**, Swift, SwiftUI, App Intents.
- **Two credentials, never mixed** (CLAUDE.md). The app holds only a session: Sign in with Apple or a passkey (`/api/auth/apple`, `/api/auth/passkey/*`), then the refresh token in the Keychain (`/api/auth/refresh`). Intents run with the same session; there is no producer token on the phone.
- **Rendered by the head, server-side** (RFC §3.1; CLAUDE.md, "Render on receipt, server-side"). The app never renders markdown. It shows the head's `rendered_html`, `rendered_lead` and `rendered_actions` natively and derives speech from them as plain text. (docs/mobile-prd.md's Human API section still says "Markdown is rendered on the device; the head never sends HTML"; that sentence predates render-on-receipt and should be corrected in the PRD.)
- **The API is the contract.** The Swift client is generated from `packages/api-types/openapi.json` with swift-openapi-generator (mobile-prd; mind the nullable fields in `packages/api-types/README.md`).
- **One head per person, several devices.** A decision from Siri records the device as actor, as a tap does (mobile-prd, Auth 4).
- The owner said: voice can act on everything; it confirms only when the match is weak (see "Confidence").
- **Settings, per device** (owner's answer):
  - *While locked:* what Siri, quick commands and notification actions may do with the phone locked: read only (default; my call) or read and act. Read only means every changing intent requires the device unlock (`authenticationPolicy` [A5]; `.authenticationRequired` on notification actions [A6]). A `confirm` card needs the person whatever the setting (see "Sensitivity").
  - *What Siri may see* of `normal` cards: titles and leads (default; my call), titles only, or counts only. Bodies never. `private` and `confirm` cards are counted whatever the setting.

## The conversation

The secretary's turns. Siri AI understands what you say; the order of the briefing and where you are in it belong to the briefing machine. Wording is the builder's; the shape is the design.

**Morning: "Brief me."**
> "Morning. Two decisions and one private one, three tasks due, one overdue. The mail agent drafted a reply to Anna about invoice timing. Want to go through them?"
> "Yes." → "The reply to Anna: approve, edit, or dismiss?" → "Approve." → "Approved. Next, three the mail reader proposes archiving: Order receipt, Weekly newsletter and Parking notice. Go through them, or skip?" → "Skip." → "Next, a private one from the bank. Open it on screen, or skip?" → "Skip." → …
> "Call the plumber, due today." → "Tomorrow." → "Moved to tomorrow." → "The bins are overdue since yesterday." → "Done." → "Ticked. That's everything. Anything you want me to pass on?" → "Tell the coding agent to update the docs for tasks." → "Sent to the coding agent."

**Between meetings: "Anything new?" / "What did I miss?"**
> "Since 10:15: one new decision from the project tracker — milestone 88 is at risk, who should review it? And the coding agent finished the docs order." → …

**Quick ones, any time:** "Approve the reply to Anna." · "Snooze the milestone one till tomorrow." · "What's overdue?" · "Is the docs order done?" · "Cancel the docs order."

**On screen:** with the Brief open, "approve this one", "dismiss the second", "open the meeting one".

The events, what each calls at the head, and the states are specified in **[docs/briefing-machine.md](../../briefing-machine.md)**.

## Sensitivity

From RFC Draft 0.9 §4.1 `sensitivity` (with §4.5 "Identifying again", §7.3, §7.4, §9 "Sensitivity", §12 "Sensitivity is a floor"), as pinned at `8cbd0e6`; the head's side is docs/trust.md, "Sensitivity". The app applies a card's **effective** sensitivity: the producer's value raised by the owner's policy at the head (§9), never lowered. The RFC lets a head show a `private` card's title; the app is stricter wherever speech or the lock screen is involved, which §9 allows.

- **`private`** — spoken as a count, never by content, whenever speech leaves the owner's control:
  - in a briefing's opening and in each section: "and three private matters", "one private decision";
  - the machine's `decision(i)` for a private card says "A private one from mail. Open it on screen, or skip?" — never the title or lead aloud;
  - its entity exposes no title, lead or producer to the index; it resolves only by position ("the private one", "the second");
  - notifications: producer and kind only ("A private decision from mail");
  - on screen, inside the signed-in app, it is shown in full as any card.
- **`confirm`** — everything `private` is, and the machine never records a decision on it by voice or from a notification action:
  - `answer` (and `edit`, `dismiss`, `done`) on a confirm card goes to the machine's `needsPerson` step: "That one needs you to confirm on the phone", and opens the card;
  - the app's done or decide control on it runs the head's passkey step-up first (`POST /api/auth/passkey/step-up/options`, then `POST /api/auth/passkey/step-up` with the assertion), which marks the session re-identified for `REAUTH_WINDOW_SECONDS` (300 s, lib/auth/reauth-window.ts) without rotating any token; a passkey sign-in or a Sign in with Apple sign-in starts a session already re-identified, and a refresh does not count (docs/trust.md). A `403 reauthentication_required` from the head is handled the same way: the outbox row waits, with every row behind it, until the step-up runs (docs/local-first.md, "The outbox");
  - its notification carries no actions;
  - snooze and acknowledge are unaffected.
- **No "read private cards aloud" setting.** Not offered: private is the producer's floor and the owner may only raise it (RFC §9). The owner's "what Siri may see" setting applies on top, for `normal` cards.

## The briefing machine

A spoken briefing is a finite state machine, specified once for every client in **[docs/briefing-machine.md](../../briefing-machine.md)**: the agenda read from the device's store and frozen at the start, the states (`opening`, `decision(i)`, `fold(i)`, `task(i)`, `routine`, `updates`, `orderNews`, `passOn`, `close`) and their inner steps (`confirming`, `needsPerson`, `blockedLocked`, `acting`), the events, the sensitivity and confidence rules, folds (a fold is one item; it is gone through card by card or skipped, and never approved as a whole, RFC §8), moves (a task decided `tomorrow` has moved, §4.3), what each event calls at the head and how the outbox answers, how a briefing is kept between turns, and the event lists every implementation is tested against.

On iOS it is a Swift package with no UI and no Siri: a pure transition function, tested against the specification's event lists. **The package implements the specification; it does not define it.** A change to the machine is a change to docs/briefing-machine.md first. Siri, App Shortcut prompts and talk mode are three front ends to it.

## Siri integration (App Intents)

App Intents, entities, `IndexedEntity` and on-screen view annotations are as in Apple's WWDC26 session on App Schemas [A3].

**Entities** (`AppEntity`, generated client types behind them):
- `DecisionEntity` — an open decision card: title, lead (plain), producer name, options (id + spoken label), day. `IndexedEntity` with title, lead and producer as indexing keys, so "the reply to Anna" resolves semantically. For a `private` or `confirm` card: no title, lead or producer; it is not indexed and resolves only by position. (The preview's per-property `authenticationPolicy` [A2b] is not a substitute: a private card's content is absent from the entity, not behind a policy.)
- `TaskEntity` — a **custom** entity for a task card: title, lead, due, overdue (the same sensitivity rule). It does not adopt the reminders schema: the head is not a system of record for tasks (RFC §1.1) and must not appear to create them.
- `UpdateEntity` (an artifact or signal thread), `OrderEntity` (an order with `exec_state`), `ProducerEntity` (for "tell *the mail agent*").
- `BriefEntity` — a day's brief, for "read me Monday's brief".

**Intents.** The briefing: `BriefMeIntent` and `WhatsNewIntent` start (or resume) it; `BriefingReplyIntent(event)` carries every answer while one is active ("approve", "next", "later", "stop", "tell the mail agent…") into the machine and returns the machine's next line as its dialog. Quick commands, which work with or without a briefing and act on a named card: `DecideIntent(card, option)`, `CompleteTaskIntent`, `DismissIntent`, `SnoozeIntent(card, until)`, `AcknowledgeIntent`, `GiveOrderIntent(text, producer?)`, `OrderStatusIntent`, `CancelOrderIntent`, `OpenCardIntent`. Decisions, tasks and orders have no fitting App Schema domain and are custom intents; the in-app search schema may serve "find the card about…" [A3].

**Follow-ups reach the machine.** The one thing Siri must do for the briefing is route a bare follow-up ("approve", "next", "stop") to `BriefingReplyIntent` while a briefing is active, rather than treat it as a new request. Apple's preview documentation says requests need not mention the app "while your app is in the foreground, while a Live Activity is active, or when a person continues a conversation in the Siri app that includes a mention of your app"; in the background they must mention it [A2b]. So the design's route is: **an active briefing runs a Live Activity** (it also shows where you are: "Decision 2 of 4"), and "Brief me in Brief" starts the conversation in the Siri app with the app mentioned. *Unverified:* that a one-word reply ("approve", "next") is routed to the reply intent under those conditions, rather than only fuller requests; Apple's examples are full sentences. Other candidates the spike tries: app skills, which guide Siri through complex actions [A2b]; `requestValue` on the event parameter. This is the gate (step 1); the spike measures it with Apple's `SiriEvaluations` framework, which scripts requests to Siri and measures how it handles them [A2b].

**Confidence.** As specified in docs/briefing-machine.md, "Confidence"; in short:
- A semantic match from the index acts at once **only when the utterance contains a word from the card's title**; a match on the lead or the producer alone confirms first.
- Several matches, or an option that is near two or none of the card's options, confirm first.
- "This one" / "the second": the briefing's current item or agenda position while one is active, otherwise what's on screen.
- Private and confirm cards are never matched by content.
- **Quick commands inherit the while-locked setting exactly as the briefing does**: with "read only", a quick command that would change something requires the device unlock first.

**The last-visit cursor** moves one cursor for the whole head, shared with the web app and every device; only a briefing that reaches `close` moves it (docs/briefing-machine.md).

**Producers by name.** "Tell the mail agent…" resolves against each producer's `name` (Settings → Producers), then its root. None named: the order goes to `*`; a name that matches no producer or several: Siri asks.

**Index.** The app indexes open `normal` cards (title, lead, producer, labels, within the "what Siri may see" setting) into the on-device semantic index from the store after each sync, and removes them when decided, superseded or past. Bodies are never indexed there; `private` and `confirm` cards are never indexed there. This is Siri's index, apart from the app's own search index (FTS5 over the store, as the web app's MiniSearch, docs/local-first.md), which never leaves the app.

**On screen.** Rows carry `.appEntityIdentifier(...)` so "this one" and "the second" resolve against what's visible; the Card screen sets an `NSUserActivity` for its card [A3].

**App Shortcuts** (work with classic Siri, so in the EU and on older phones): "Brief me in Brief", "What's new in Brief", "Give Brief an order". They drive the same machine; without Siri AI, follow-ups are fixed prompts listing the events that apply ("Approve, dismiss, or next?").

**Talk mode in the app.** A microphone on the masthead runs the same machine inside the app, with on-device speech recognition and synthesis and a small fixed grammar mapped to the machine's events. No LLM. It is the fallback where Siri AI is missing, and the way to talk to it with the app open.

## The app

- **Screens and components:** as docs/mobile-prd.md (Brief, Card, Orders, Settings; `DecisionCard`, `TaskRow`, `UpdateRow`, `DailyBrief`, `TimeRail`, `WeekStrip`, `LabelFilter`), matched to the web app as it is now: on a phone the day reads brief, decisions, schedule, tasks under it, updates, signals.
- **Gestures:** as docs/mobile-prd.md's gesture table and the web app: taps commit at once; a sideways swipe anywhere on the brief changes the day, as the week strip does, and never decides a card ("Taps commit; swipes move days"); on a task row a swipe right is done and a swipe left dismisses, each after a 4 s undo (the PRD's `TaskRow` row); long-press snoozes. *(Open: the revision brief asked for "horizontal swipes are card actions, the week strip changes days", citing the PRD; the PRD says the opposite for the brief as a whole. Left as the PRD has it until the owner decides.)*
- **Rendering:** the head's sanitised HTML converted to native text (AttributedString) for the restricted profile; images and diagrams through `/api/me/img` and `/api/me/svg/{hash}` in the shared viewer.
- **Local first** (docs/local-first.md; the web app's `app/(ui)/local/` is the reference): a SQLite store (WAL) holding the cards as `/api/me` returns them, with a day index, and meta rows (the cursor, `settings_seq` and the floors, retention, the brief the head last composed, the orders list); an FTS5 index over title, summary, lead and the body's plain text; an outbox table. Every screen, the briefing machine and the intents read the store; the outbox is the only thing that writes to the head, and it drains in order, under one lock across the app and its extensions, through the existing owner routes, answering 2xx, 409, 403, other 4xx and network or 5xx as docs/local-first.md's table says.
- **Freshness:** a sync asks `GET /api/me/seq` and stops when nothing moved, else pages `GET /api/me/cards?after=<cursor>` and applies each card by id. It runs on open, on focus, once a minute while the brief is on screen, and when a push arrives. When `settings_seq` in `/api/me/seq` moves, the app refetches the floors (`GET /api/me/settings`, `sensitivity_floors` and `fold_policies`) and recomputes every stored card's `effective_sensitivity` exactly as the web app does (`app/(ui)/local/feed.ts`, lib/me.ts `briefStamp`). A cold open shows the brief the head last composed, its cards from the store, marked "as of <time>" until the sync returns. Pull to refresh runs a sync.
- **Settings:** devices, producers, notifications (per device: daily brief time, urgent cards), while locked, what Siri may see, on this device (retention, the store's size), theme. Pairing and producer tokens stay on the web (keyboard work, mobile-prd).

## Push

APNs alongside Web Push; the same two notifications the web app has (the daily brief at the device's time; urgent cards as they arrive).

- **APNs carries the card id and title only.** An APNs payload is delivered by Apple and is not end-to-end encrypted to the device [A7], whereas a Web Push payload is (RFC 8291), which is why the web notification carries the lead. For a `private` or `confirm` card the payload carries the id, the producer name and the kind only ("A private decision from mail").
- **A notification service extension** [A6] fetches the lead from the head (`GET /api/me/cards/{id}`, with the device's session) and adds it for display, for a `normal` card; it fetches nothing for a `private` or `confirm` card.
- An urgent `normal` decision's notification carries its options as notification actions (subject to the while-locked setting), which go through the outbox like any decision; a `confirm` card's carries none; tapping opens the Card screen.
- Every push also starts a sync (docs/local-first.md, "Sync").

## Connecting to a head

Onboarding asks for the head's address (`pbcp.vercel.app`, or a self-hosted one), checks it is a head (its public `/api/openapi.json`), then signs in. Some of iOS is fixed at build time, which shapes this:
- **Sign in with Apple** works with any head that lists the app's bundle id in its `APPLE_CLIENT_ID` (the identity token's audience is the bundle id). Self-hosters add it to their env.
- **Passkeys** in a native app need the head's domain in the app's Associated Domains, so they work only for domains the app was built with. For other heads, sign in through the head's own web sign-in in an `ASWebAuthenticationSession` and hand the session back to the app, or enrol the phone from an already signed-in device with an enrolment link (`POST /api/me/settings/enrolment`). The builder picks; the head may need a small route to hand a session to the app after web sign-in. Re-identification for `confirm` cards (the passkey step-up, `POST /api/auth/passkey/step-up`) follows the same path as sign-in on that head.
- **Push.** An APNs key belongs to the team that publishes the app. In v1 the head sends APNs directly when it holds that key (the owner's head); any other head has no push in the app. A relay the publisher runs is the follow-up; out of v1. (My call.)

## Auth across surfaces

Intents, notification actions, the notification service extension and the app are one device with one session and one refresh token (Keychain, shared through an app group). Refresh rotates with reuse detection (`rotateRefresh` in lib/auth/session.ts revokes the device when an old token comes back), so only one refresh may run at a time: the builder serialises it on the device (a lock in the shared container). If that proves unreliable across processes, the head may add a short grace window for a just-rotated token; a head change in lib/auth, not the protocol.

**Keys.** Today the head reads cards under its own key: each head's data key is wrapped by the deployment's `HEAD_MASTER_KEY` and unwrapped for the request that needs it (at rest, step one; docs/trust.md "At rest", lib/keys.ts). The planned step two (`passkey-keys`) wraps the data key under each passkey's PRF output instead and carries it in the session, so the operator holds no key at all. Then the app's sign-in will obtain the PRF secret from the passkey during the assertion and hold key material for its session (in the Keychain, beside the refresh token, shared with its extensions), and Sign in with Apple will yield a session that reads no content until a passkey unlocks it. The app's auth design must leave room for that now: passkey sign-in is the primary path, Sign in with Apple a convenience, and nothing in the app assumes a session can always read content.

## What the head needs

Sensitivity on every surface of the head, and the brief's parts carrying each entry's `sensitivity` and `effective_sensitivity`, are merged (PR #57). Still missing:

- APNs sender and per-device APNs token registration beside the Web Push subscription (`/api/me/settings/push`, `lib/push/*`), behind config (`APNS_*` env), self-hosters optional; the id-and-title payload above.
- An endpoint for a spoken brief on demand, if the agenda is not built on the device. The design builds it on the device, from the store and the stored brief's `daily_paragraph.parts` (docs/briefing-machine.md, "The agenda"); `GET /api/me/brief?spoken=1` gives only the paragraph in spoken form, not the agenda.
- Sign in with Apple from the app already works: `POST /api/auth/apple` takes `{ id_token }`; add the app's bundle id to `APPLE_CLIENT_ID` (configuration, not code).
- Nothing in the protocol. If an intent needs data the brief does not give, add it to `/api/me/`, never to the RFC.
- Correct docs/mobile-prd.md's rendering sentence and the app's status when the app starts.

## Order of work (for the plan)

1. **Spike (throwaway), and a gate.** On the iOS 27.3 beta, a stub briefing (three hard-coded items, no real head calls) with a Live Activity while it runs: does Siri AI route bare follow-ups ("approve", "next", "stop") to `BriefingReplyIntent` while a briefing is active — with the app in the foreground, in the background with the Live Activity, and continuing in the Siri app — and how does a turn end and resume? Measured with `SiriEvaluations` scripts as well as by hand [A2b].
2. **The briefing machine's fixtures and implementation**: the event lists in docs/briefing-machine.md as language-neutral fixtures, and an implementation tested against them.

   **The gate.** If Siri AI on iOS 27.3 does not route bare follow-ups to `BriefingReplyIntent` while a briefing is active, **the plan stops after step 2**: the briefing machine ships as the **web app's talk mode** (implemented in the web app against the same fixtures), and the native app waits for a Siri that can carry it. If it does, step 2's implementation is the Swift package and the plan continues.
3. Sign-in (passkey first, Sign in with Apple beside it), the generated client, the local store (SQLite, FTS5, the outbox table) and its sync from the change cursor with the `settings_seq` floor refetch; the Brief screen read-only from the store.
4. Decide/done/snooze/ack through the outbox, with the passkey step-up for `confirm`; Card and Orders screens; search over the FTS5 index.
5. Entities, indexing, intents (the briefing on the machine, then the quick commands), App Shortcuts; on-screen annotations.
6. APNs, the notification service extension, notification actions.
7. Talk mode.
8. TestFlight to the owner as an **internal** tester (the preview's Siri integration is not available to external TestFlight testers or App Store builds [A2b]); App Store when submissions open in the spring [A2].

## Later

The app could become an executor of orders addressed to `phone` (Appendix A): claiming an order when it is in the foreground or woken by a push, and carrying out what iOS lets an app do (an event or reminder through EventKit, a named Shortcut, a message prepared for the person to send). While an order waits on the person (a message not yet sent, a permission not yet granted) the app lets the lease lapse rather than hold it; the order returns to `open`, and the app claims it again when it can go on, taking a new `claim_seq` (A.2), checking for cancellation on every renewal (A.5). It posts the outcome as the executor's card (A.3). An executor writes as a producer, so it would hold a producer token for the `phone` root in its own Keychain item, apart from the owner's session and never used for `/api/me/` (CLAUDE.md, two credentials never mixed). It changes nothing in the first app.

## Left to the builder

- Exact phrasing of the secretary's speech, within docs/briefing-machine.md: short, counts first, title — lead, never bodies, private counted.
- How the machine's state is encoded and stored, within: one briefing at a time per device, saved after every event, expiring with its day.
- Project layout, the SQLite schema within docs/local-first.md's parts, test approach (AppIntentsTesting for intents [A3]).
- How option names are made speakable when an option's id is terse.

## Sources

The head and the protocol, on main as it stands (Nov 12, 2026):

- RFC Draft 0.9, `vendor/pbcp/rfc/pbcp-draft-0.9.md`, pinned at `8cbd0e6`: §1, §1.1, §3.1, §4.1 (`sensitivity`), §4.3 ("Deciding a task": ending and moving), §4.5 ("Identifying again", "Presenting a task"), §7.3, §7.4, §8 ("What a brief contains": folds, a task superseded by a task has moved), §9 ("Sensitivity", "Folding"), §12, Appendix A (A.1–A.5).
- docs/local-first.md and `app/(ui)/local/` (`feed.ts`, `store.ts`, `db.ts`, `search.ts`, `outbox.ts`): the store, the feed, the index and the outbox the app mirrors. It replaces docs/mobile-prd.md's former "nothing is queued offline".
- docs/trust.md ("At rest", "Sensitivity"); lib/keys.ts (step one; step two, `passkey-keys`, is listed under "Not here yet" in CLAUDE.md).
- `app/api/auth/passkey/step-up/` (and `/options`), lib/auth/reauth-window.ts (`REAUTH_WINDOW_SECONDS`), lib/auth/session.ts (a sign-in starts re-identified).
- lib/brief/paragraph.ts (`ParagraphParts.folds`, the spoken composition), lib/brief/fold.ts (routine tasks under a `count` label), lib/me.ts `briefStamp` (`seq`, `date`, `settings_seq`).

Apple claims and where they rest. Anything about iOS 27 not listed here is unverified.

- **[A1]** Siri AI in iOS 27 (beta, English first, Apple Intelligence devices, not in the EU on iOS at first, server-side usage limits): Apple Newsroom, "Siri AI, a profoundly more capable and personal assistant, is here", Sep 2026 — https://www.apple.com/newsroom/2026/09/siri-ai-a-profoundly-more-capable-and-personal-assistant-is-here/
- **[A2]** App Intents adoption in 27.3 (developer preview on the iOS/iPadOS/macOS/visionOS 27.3 betas, open to any developer; App Store submission "opening up in the spring"; shipping to customers "in a few months"; "skills" to combine several actions; Apple Intelligence device in a supported language; unavailable in the EU on iOS, iPadOS and watchOS): Apple Developer News, "Siri AI is now open to all developers", Nov 3, 2026 — https://developer.apple.com/news/?id=gdk2umrf; documentation: see [A2b].
- **[A2b]** Siri AI Developer Preview documentation (requests without the app's name in the foreground, during a Live Activity, or continuing a conversation in the Siri app; background requests must name the app; regions where Siri AI is available; not available to external TestFlight testers or App Store builds; app skills; the Siri Integration Advisor and the `SiriEvaluations` framework; tool intents (`ToolIntent`, `AppIntent(_:)` traits); per-property `authenticationPolicy` on `ComputedProperty`/`DeferredProperty`) — https://developer.apple.com/documentation/appintents/siri-ai-developer-preview
- **[A3]** App Schemas, `AppEntity`, `IndexedEntity` and the semantic index, `EntityStringQuery`, view annotations (`.appEntityIdentifier`), `NSUserActivity`, AppIntentsTesting: WWDC26 session 240, "Build intelligent Siri experiences with App Schemas" — https://developer.apple.com/videos/play/wwdc2026/240/. The in-app search schema (`.system.searchInApp`) per WWDC26 session 343 notes — https://wwdc.ai/2026/343 (third-party notes; unverified against Apple's text).
- **[A4]** Device list (iPhone 15 Pro and later, iPhone 16 and later): as [A1].
- **[A5]** `authenticationPolicy` on an App Intent — https://developer.apple.com/documentation/appintents/appintent/authenticationpolicy (an App Intents API since iOS 16; not checked against the 27.3 SDK).
- **[A6]** Notification service extension and `UNNotificationActionOptions.authenticationRequired` — https://developer.apple.com/documentation/usernotifications/unnotificationserviceextension, https://developer.apple.com/documentation/usernotifications/unnotificationactionoptions/authenticationrequired.
- **[A7]** APNs payloads are JSON sent to Apple's servers for delivery — https://developer.apple.com/documentation/usernotifications/generating-a-remote-notification. That Apple does not encrypt them end to end to the device is the absence of any such claim in Apple's documentation, not a statement by Apple: *unverified as a positive statement*. Web Push encryption: RFC 8291.
- **Unverified (no Apple source found):** how Siri AI routes follow-up utterances to an app's intent during a multi-turn exchange; whether a one-word follow-up is routed under the conditions in [A2b]; SiriKit's deprecation timeline.
