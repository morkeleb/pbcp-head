# Design: the head on iOS, a secretary you talk to

Nov 10, 2026 · @Morten Nielsen · design, before the plan

## Intent

The head is modelled on the brief a secretary gives an executive (RFC §1): what happened since you last looked, the decisions that need you, and a place to give orders back. On the iPhone the head should *be* that secretary, and you should be able to **talk to it as you would to one**: in the morning, and between meetings, ask "what's new?", hear it, answer each thing as it comes, and give it instructions to pass on. Voice first; the screen is the same brief the web app already has, there when you want to look.

iOS 27 makes this possible now. Siri AI (iOS 27, beta, Sep 2026) understands conversational requests and acts in apps through **App Intents**; third-party apps can adopt it in the iOS 27.3 developer preview (Nov 3, 2026), with App Store submission opening in spring 2027. A home-screen web app cannot take part: only a native app can expose intents and entities to Siri. That is why the app exists now, and the reason it is native.

The app adds nothing to the protocol (docs/mobile-prd.md): it is one more client of `/api/me/`, with the owner's session credential. Siri is a new way of speaking to that client, not a new party in the protocol.

## Goals

1. **Talk to it like a secretary.** "Brief me", "Anything new?", "What's waiting for me?" get a spoken answer in a secretary's register: short, what matters first, then "Shall we go through them?". You answer each decision by voice ("approve", "send the second one", "later"), tick tasks ("done"), and give orders ("tell the mail agent to chase the invoice").
2. **Between meetings is a first-class moment.** "What did I miss?" reports only what changed since the last time you spoke or looked (the brief's `last_visit` cursor, `new`, `order_updates`, `lapsed_orders`), and moves the cursor when you're done.
3. **The app looks like the web app.** The same three screens (Brief, Card, Orders) plus Settings, the same seven components under the same names, the same tokens (docs/mobile-prd.md, "The components"). The web brief is the reference.
4. **Push that the secretary would do:** the daily "your brief is ready" at the owner's time and urgent cards (`delivery: immediate`) as they arrive, over APNs, with the card's actions on the notification.

## Non-goals

- No LLM in the app or the head for this. Siri AI does the language understanding; the app only exposes entities and intents. The brief arrives written (mobile-prd).
- No change to the RFC, and no head behaviour only Siri can reach: every intent is an existing `/api/me/` call.
- No offline decisions (mobile-prd: nothing is queued offline). The app may show a cached brief, read-only, when there is no network.
- Not Android (later, same API), not iPad- or Mac-specific layouts in v1.
- The app does not create tasks or cards of its own. Tasks belong to their producers (RFC §1.1: not a system of record for tasks); something the person wants done is an **order** (Appendix A), and a to-do tool is an executor (A.4).

## Anti-goals (failure even if it works)

- **A command line with a voice.** If using it means remembering phrases ("Decide card hermes-gmail-19a4 approve"), it has failed. References are natural: "the reply to Anna", "this one", "the second".
- **Reading the inbox aloud.** A secretary summarises and asks; it does not recite every card. Speech is the title and the lead at most; bodies stay on screen.
- **Deciding the wrong card.** Voice acts at once (owner's call: no confirmation step) *unless* Siri is not sure which card or which option was meant; then it asks. A misheard decision is permanent (RFC §4.3), so ambiguity always asks.
- **A second product.** The app must not drift from the web brief; differences are only what iOS does better (Siri, haptics, notifications).

## Constraints

- **Built around Siri AI.** The owner has Siri AI on their iPhone; the in-app talk mode is the fallback for people who don't, and comes late.
- **Any head.** The app connects to any head URL, the owner's and self-hosted ones alike (owner's answer). See "Connecting to a head".

- **iOS 27.3 or later**, Swift, SwiftUI, App Intents. Siri AI needs Apple Intelligence hardware (iPhone 15 Pro and later), and English first. **Siri AI is not available on iOS in the EU at first**, so everything must also work through classic Siri with App Shortcuts (fixed phrases, see below), and in the app.
- **Two credentials, never mixed** (CLAUDE.md). The app holds only a session: Sign in with Apple or a passkey (`/api/auth/apple`, `/api/auth/passkey/*`), then the refresh token in the Keychain (`/api/auth/refresh`). Intents run with the same session; there is no producer token on the phone.
- **Render on receipt** (RFC §3.1). The app never renders markdown. It shows the head's `rendered_html`, `rendered_lead` and `rendered_actions` (sanitised, a restricted profile) natively, and derives speech from them as plain text. Note: docs/mobile-prd.md still says "markdown is rendered on the device; the head never sends HTML" — that is out of date and should be corrected with this work.
- **The API is the contract.** The Swift client is generated from `packages/api-types/openapi.json` with swift-openapi-generator (mobile-prd; mind the nullable fields in `packages/api-types/README.md`).
- **One head per person, several devices.** A decision from Siri records the device as actor, as a tap does (mobile-prd, Auth 4).
- The owner said: voice can act on everything; Siri confirms only when its confidence is low.
- **Settings, not fixed rules,** for two privacy questions (owner's answer), per device:
  - *While locked:* what Siri and notification actions may do with the phone locked — read only (the brief, "what's new") or also decide, tick and order. Default: read only; deciding asks for Face ID (`authenticationPolicy` on the write intents, `.authenticationRequired` on notification actions), since a decision is permanent (RFC §4.3). My call on the default. Later, cards may carry a sensitivity that tightens this per card; that would be an RFC question (an issue on the `pbcp` repo's `rfc/OPEN.md`), not something the app invents.
  - *What Siri may see:* titles and leads (default), titles only, or nothing but counts. With Siri AI, entity text may be processed on Apple's Private Cloud Compute; bodies are never given to Siri either way. The setting drives what the entities expose and what the index holds. My call on the default.

## The conversation

The secretary's turns. Siri AI understands what you say; the order of the briefing and where you are in it belong to the briefing machine (next section). Wording is the builder's; the shape is the design.

**Morning: "Brief me."**
> "Morning. Two decisions, three tasks due, one overdue. The mail agent drafted a reply to Anna about invoice timing. The calendar has your customer meeting overlapping the roadmap review. Want to go through them?"
> "Yes." → "The reply to Anna: approve, edit, or dismiss?" → "Approve." → "Done. Next: the meeting overlap. Move the review to 14:00, or keep both?" → …
> "And the bins are overdue since yesterday." → "Done." → "Ticked. That's everything. Anything you want me to pass on?" → "Tell the coding agent to update the docs for tasks." → "Sent to the coding agent."

**Between meetings: "Anything new?" / "What did I miss?"**
> "Since 10:15: one new decision from the project tracker — milestone 88 is at risk, who should review it? And the coding agent finished the docs order." → …

**Quick ones, any time:** "Approve the reply to Anna." · "Snooze the milestone one till tomorrow." · "What's overdue?" · "Is the docs order done?" · "Cancel the docs order." · "Read me the brief from Monday."

**On screen:** with the Brief open, "approve this one", "dismiss the second", "open the meeting one".

What each event does at the head (the events are the machine's, below; a quick command outside a briefing is the same event on a named card):

| You say (event) | Head call | Notes |
| --- | --- | --- |
| Brief me / What's waiting? (`start(.brief)`) | `GET /api/me/brief` | The daily paragraph's parts (`parts`), not the HTML, are the script: counts first, then each decision and task as title — lead |
| Anything new? / What did I miss? (`start(.sinceLast)`) | `GET /api/me/brief` → `new`, `order_updates`, `lapsed_orders`; `POST /api/me/visit` at the end | See "The last-visit cursor" |
| Approve / the second / send it / edit… (`answer(option)`, `edit(text)`) | `POST /api/me/cards/{id}/decision` | The option is resolved from the card's `actions` and `rendered_actions` by name, position or default. `edit` (dictated replacement) only when the card offers it |
| Dismiss (`dismiss`) | same, `dismissed` | |
| Done, a task (`done`) | same, `done` | RFC 0.9: `done` is always offered for a task |
| Later / snooze till… (`snooze(until)`) | `POST /api/me/cards/{id}/snooze` | tonight, tomorrow's brief, next week, or a spoken time |
| Okay / noted, updates (`ack`) | `POST /api/me/cards/{id}/ack` | |
| Tell X to … / Have someone … (`order(text, producer?)`) | `POST /api/me/orders` | `to_producer` resolved from the producers' names (`GET /api/me/producers`), or `*` if none named; the body is the dictated text, unparsed (mobile-prd: the executor interprets it) |
| Is the … order done? / Cancel it (`cancelOrder`) | `GET /api/me/orders`; cancel = `dismissed` on the order (A.1) | |

## The briefing machine

A spoken briefing is a finite state machine owned by the app, not a conversation left to Siri. **Siri understands the words; the machine decides what comes next.** Siri AI (or talk mode, or a fixed App Shortcut prompt) turns an utterance into a typed event and resolves which card is meant; the machine holds the order of the briefing, the position, what has been answered and what is said next. Siri never has to remember where you are, so the briefing cannot drift, skip items or lose its place when a Siri session ends. Rigid about the sequence, loose about language: any phrasing that maps to an event is fine, and the spoken lines can vary.

**The agenda is fixed at the start.** `start` fetches the brief and freezes its `seq` and the items into an ordered agenda: decisions (as the brief orders them), tasks (overdue first, as `byDue`), the updates as one summary, order news (`order_updates`, `lapsed_orders`, `late_outcomes`). For `start(.sinceLast)` only items in `new` (and order news since the last visit) are on it. Cards that arrive during the briefing are not inserted: they are appended at the end ("One more just came in: …"), so nothing reorders under you, as on screen.

**States.**

| State | Says | Waits for | Then |
| --- | --- | --- | --- |
| `opening` | The counts ("Two decisions, three tasks, one overdue."), or "Nothing new since 10:15." | `next` / yes | the first agenda item, or `passOn` if there is none |
| `decision(i)` | Producer, title — lead, the options in order ("approve, edit, or dismiss?"); the default named first when there is one | `answer`, `edit`, `dismiss`, `snooze`, `skip` | acting → "Approved." → `decision(i+1)` or the next section |
| `task(i)` | Title, when it is due, "overdue since yesterday" | `done`, a listed action, `dismiss`, `snooze`, `skip` | as above |
| `updates` | One sentence: "Four updates: the deploy went out, …" (titles only) | `ack` (yes, okay) or `skip` | `orderNews` |
| `orderNews` | What came back from orders, and any order whose executor went quiet | `next`, `cancelOrder` on the lapsed one | `passOn` |
| `passOn` | "Anything to pass on?" | `order(text, producer?)` (loops back here: "Sent to the coding agent. Anything else?"), no | `close` |
| `close` | "That's everything." | — | posts `POST /api/me/visit` with the frozen `seq`, ends |

Each item state has two inner steps: **confirming**, entered only when the event is ambiguous under the confidence rule ("Approve or approve with changes?"), and **acting**, the head call. A failed call (network, 409 because the card was decided elsewhere meanwhile) is said plainly ("That one was already decided on another device: approved.") and the machine moves on; nothing is queued offline.

**Events allowed in any state:** `stop` (pause: saves the position and ends the turn), `skip`, `repeat`, `back` (to the previous item, to hear it again; a decided card stays decided, RFC §4.3), `jump(card)` ("first the milestone one"), `show` (opens that card on screen instead of reading its body), `help` (says what you can answer here). An event that does not apply in the current state is answered with what does ("This one's a task: done, later, or skip?").

**Kept between turns.** The machine's state (agenda, position, frozen `seq`, outcomes so far) is saved in the app group container after every event, so each Siri turn is self-contained and the app, Siri and talk mode share one briefing. A paused briefing resumes on the next "Brief me": "Shall we pick up at decision 2 of 4?" — "No" starts afresh. A saved briefing expires at the end of its day, or when the head's `seq` shows its agenda has been decided elsewhere; yesterday's half-finished briefing never resumes.

**The last-visit cursor** follows from the machine: reaching `close` posts the `seq` frozen at `start`, as closing the app does, so anything that arrived while you were talking stays new. A briefing that is paused or expires posts nothing. Quick commands outside a briefing never move it.

**Testable without Siri.** The machine is plain Swift with no UI and no Siri: a pure transition function `(state, event, brief) → (state, speech, headCall?)`, unit-tested over event lists ("start, next, answer(approve), skip, done, stop, start → resumes at task 1"). Siri, talk mode and App Shortcut prompts are three front ends to it.

## Siri integration (App Intents)

**Entities** (`AppEntity`, generated client types behind them):
- `DecisionEntity` — an open decision card: title, lead (plain), producer name, options (id + spoken label), day. `IndexedEntity` with title, lead and producer as indexing keys, so "the reply to Anna" resolves semantically.
- `TaskEntity` — a task card: title, lead, due, overdue. Conform to the **reminders** schema (`.reminders.reminder`) so Siri treats it as a to-do, if the schema's rules allow an entity the app cannot create (the reminders schema reportedly has create/update/delete and no read; the builder confirms what conformance requires and drops it if it forces a create path).
- `UpdateEntity` (an artifact or signal thread), `OrderEntity` (an order with `exec_state`), `ProducerEntity` (for "tell *the mail agent*").
- `BriefEntity` — a day's brief, for "read me Monday's brief".

**Intents.** The briefing: `BriefMeIntent` and `WhatsNewIntent` start (or resume) it; `BriefingReplyIntent(event)` carries every answer while one is active ("approve", "next", "later", "stop", "tell the mail agent…") into the machine and returns the machine's next line as its dialog. Quick commands, which work with or without a briefing and act on a named card: `DecideIntent(card, option)`, `CompleteTaskIntent`, `DismissIntent`, `SnoozeIntent(card, until)`, `AcknowledgeIntent`, `GiveOrderIntent(text, producer?)`, `OrderStatusIntent`, `CancelOrderIntent`, `OpenCardIntent`. Where an App Schema fits (reminders for tasks; in-app search for "find the card about…"), adopt it; decisions and orders have no schema domain and are custom intents.

**Follow-ups reach the machine.** The one thing Siri must do for the briefing is route a bare follow-up ("approve", "next") to `BriefingReplyIntent` while a briefing is active, rather than treat it as a new request. How to get that (intent results that open the reply intent, `requestValue` on the event parameter, the dialog's suggested replies, the active briefing as on-screen context) is what the spike finds out. If Siri cannot do it reliably, each turn still works with the app's name in it ("approve in Brief"), and talk mode carries the briefing without Siri.

**Confidence.** App Intents hands the app a resolved value, not Siri's confidence, so "unsure" is a rule the app applies (my call; the owner can tune it):
- the spoken reference matches more than one open card (in the index or by string query) → ask which ("The reply to Anna or to Anders?");
- the spoken option is not one of the card's options by id, rendered label or position, or is near two of them → ask;
- "this one" / "the second" while a briefing is active means the briefing's current item / the agenda's second; otherwise what's on screen; if neither, ask;
- talk mode: a recognition below the recogniser's confidence threshold is repeated back as a question.
One clear match acts at once. Nothing else asks.

**The last-visit cursor** moves one cursor for the whole head, shared with the web app and every device; it moves only when a briefing reaches `close` (see "The briefing machine"; my call).

**Producers by name.** "Tell the mail agent…" resolves against each producer's `name` (Settings → Producers, renamed by the owner, or the name a paired producer gave), falling back to its root. One clear match or none: with none named, the order goes to `*`; with a name that matches no producer or several, Siri asks.

**Index.** The app indexes open cards (title, lead, producer, labels) into the on-device semantic index after each fetch, and removes them when decided, superseded or past. Bodies are not indexed. This puts card text in Apple's on-device index (not off the device); if card content is later encrypted at rest with keys only the device holds, indexing stays on the device and is unaffected.

**On screen.** Rows carry `.appEntityIdentifier(...)` so "this one" and "the second" resolve against what's visible; the Card screen sets an `NSUserActivity` for its card.

**App Shortcuts** (work with classic Siri, so in the EU and on older phones): "Brief me in Brief", "What's new in Brief", "Give Brief an order". They drive the same machine; without Siri AI, follow-ups are fixed prompts listing the events that apply ("Approve, dismiss, or next?").

**Talk mode in the app.** A microphone on the masthead runs the same briefing machine inside the app, with on-device speech recognition and synthesis and a small fixed grammar mapped to the machine's events (yes, no, next, approve/an option's name, dismiss, done, later, stop, repeat, "tell X to …"). No LLM. It is the fallback where Siri AI is missing, and the way to talk to it with the app open.

## The app

- **Screens and components:** as docs/mobile-prd.md (Brief, Card, Orders, Settings; `DecisionCard`, `TaskRow`, `UpdateRow`, `DailyBrief`, `TimeRail`, `WeekStrip`, `LabelFilter`), matched to the web app as it is now, including the latest layout: on a phone the day reads brief, decisions, schedule, tasks under it, updates, signals.
- **Gestures:** as the web app and mobile-prd: taps commit at once, sideways swipes change days, swipes on a task row are done/dismiss with undo, long-press snoozes.
- **Rendering:** the head's sanitised HTML converted to native text (AttributedString) for the restricted profile; images and diagrams through `/api/me/img` and `/api/me/svg/{hash}` in the shared viewer.
- **Freshness:** `GET /api/me/seq` to know when to refetch; pull to refresh.
- **Settings:** devices, producers, notifications (per device: daily brief time, urgent cards), theme. Pairing and producer tokens stay on the web (keyboard work, mobile-prd).

## Push

APNs alongside Web Push. Same two notifications the web app has (daily brief at the device's time; urgent cards as they arrive). Payload: the card id, title and lead as the Web Push one does today; the builder decides whether to keep the lead given it passes through Apple's servers in clear (mobile-prd originally said id and title only). An urgent decision's notification carries its options as notification actions, so it can be answered from the lock screen; tapping opens the Card screen.

## Connecting to a head

Onboarding asks for the head's address (`pbcp.vercel.app`, or a self-hosted one), checks it is a head (its public `/api/openapi.json`), then signs in. Some of iOS is fixed at build time, which shapes this:
- **Sign in with Apple** works with any head that lists the app's bundle id in its `APPLE_CLIENT_ID` (the identity token's audience is the bundle id). Self-hosters add it to their env.
- **Passkeys** in a native app need the head's domain in the app's Associated Domains, so they work only for domains the app was built with. For other heads, sign in through the head's own web sign-in in an `ASWebAuthenticationSession` and hand the session back to the app, or enrol the phone from an already signed-in device with an enrolment link (`POST /api/me/settings/enrolment`). The builder picks; the head may need a small route to hand a session to the app after web sign-in.
- **Push.** An APNs key belongs to the team that publishes the app. In v1 the head sends APNs directly when it holds that key (the owner's head); any other head has no push in the app. A relay the publisher runs, which heads call with a device token, is the follow-up that gives every head push; it is out of v1. (My call.)

## Auth across surfaces

Intents, notification actions and the app are one device with one session and one refresh token (Keychain, shared through an app group). Refresh rotates with reuse detection (`rotateRefresh` in lib/auth/session.ts revokes the device when an old token comes back), so only one refresh may run at a time: the builder serialises it on the device (a lock in the shared container). If that proves unreliable across processes, the head may add a short grace window for a just-rotated token; that is a head change in lib/auth, not the protocol.

## What the head needs

- APNs sender and per-device APNs token registration beside the Web Push subscription (`/api/me/settings/push`, `lib/push/*`), behind config (`APNS_*` env), self-hosters optional.
- Sign in with Apple from the app already works: `POST /api/auth/apple` takes `{ id_token }`; add the app's bundle id to `APPLE_CLIENT_ID`.
- Nothing in the protocol. If an intent needs data the brief does not give (e.g. spoken labels for options without `rendered_actions`), add it to `/api/me/`, never to the RFC.
- Correct docs/mobile-prd.md (rendering, the app's status, Siri) when the app starts.

## Order of work (for the plan)

1. **Spike (throwaway):** on the iOS 27.3 beta against the production head, a stub briefing (three hard-coded items, no real head calls): does Siri AI route bare follow-ups ("approve", "next", "stop") to `BriefingReplyIntent` while a briefing is active, and how does a turn end and resume?
2. **The briefing machine** as a Swift package with its tests, no UI, against recorded `/api/me/brief` responses.
3. Sign-in, the generated client, Brief screen read-only.
4. Decide/done/snooze/ack in the app; Card and Orders screens.
5. Entities, indexing, intents (the briefing on the machine, then the quick commands), App Shortcuts; on-screen annotations.
6. APNs and notification actions.
7. Talk mode.
8. TestFlight to the owner; App Store when submissions for Siri AI open (spring 2027).

## Left to the builder

- Exact phrasing of the secretary's speech, within: short, counts first, title — lead, never bodies.
- How the machine's state is encoded and stored, within: one briefing at a time per device, saved after every event, expiring with its day.
- Project layout, persistence for the read-only cache, test approach (AppIntentsTesting for intents).
- Whether `TaskEntity` conforms to the reminders schema (above).
- How option names are made speakable when an option's id is terse.
