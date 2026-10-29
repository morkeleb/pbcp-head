# PRD: Mobile App for the Head

Oct 26, 2026 · @Morten Nielsen

## Purpose

The head is a morning-on-the-phone product. The brief is read in bed, in the car, between meetings; a decision is a swipe, not a session. A web app in a mobile browser will not build that habit, so a native app is the thing that turns the protocol into a product people keep.

The app adds nothing to the protocol. It is one more human-facing client of the head, and the protocol was designed so that this is true: decision cards with a default map onto a swipe, choice lists onto controls on the card, snooze onto a long-press, earlier days onto scrolling up the timeline. The one thing that is mobile-only is a push notification on `urgency: immediate`, and that is a hosted-head feature, not a protocol one.

Success looks like: the person opens the app once in the morning, clears every decision in under two minutes, and does not open a mail client until lunch.

## Scope

Three screens, and a deliberate list of what the phone does not do. All three share one masthead: the name "Brief", a dateline in words ("Tue 27 Oct · morning", on the device's clock), search, theme and the menu, in the same places on every screen. Under the name sits one row of the same height everywhere: the week strip on the Brief, "← Brief" and the screen's title on the others.

| Screen | Shows | Actions |
| --- | --- | --- |
| **Brief** | A timeline of days (today on top at open, earlier days above, tomorrow below), each opening with its paragraph; open decisions, then the day's schedule (its cards with `at` on a time rail, RFC 0.8 §8), then artifacts (Updates) and signals folded by thread. Built from the components below | Tap an action, swipe, pull to refresh, tap a day on the week strip; marks the last-visit cursor on close |
| **Card** | The card as the Brief shows it (`DecisionCard`, or `UpdateRow` for an artifact or signal) with its body fully open; then its thread as the Brief lists threads; then its decision log entries as a small table | Decide, snooze, open source, see thread |
| **Orders** | Open orders, each a block styled like a `DecisionCard` with `exec_state`, who holds it and the lease in a small table, its latest progress as an `UpdateRow` beneath; then done orders as `UpdateRow`s of their outcomes | Dictate a new order (text or voice); cancel |

**The components.** The web brief (`app/(ui)/brief/`) is the reference the phone matches. It is made of six self-contained components, each typed from the `/api/me` card shape (`packages/api-types`); the app builds the same six, under the same names, with the same tokens (`app/globals.css`: Newsreader for the masthead, day headings and card titles, Inter for everything else, one violet accent, hairline rules, no shadows):

| Component | Shows | Does |
| --- | --- | --- |
| `DecisionCard` | Producer · labels · time (`at`–`until` when the card has them) · decide (from 900 px; on a phone its options say it) · label · host ↗ (an accent dot while unseen; links to `source.url` in a new tab, http(s) and mailto only; the host always shows, RFC §12, the label once only when it is not the host, and the label is dropped first when the line is too narrow; the card's labels, RFC 0.7 §4.1, in the producer's order and the producer's type, truncate next) and a menu (snooze, open card); title; `rendered_lead`; the proposal in an inset; the first visual while the rest is closed; the rest behind "More"; the actions in order (only an option marked `default` filled, none filled without one, RFC §4.5), Dismiss as quiet text, Edit… only when `edit` is offered, a comment behind a disclosure; options with a body one under another, each its own button beside its body | Decides on a tap at once (the buttons become "Approved · 09:14", with the later cards that reference it beside that, §8); on a swipe or a key after a 4 s undo, a right swipe only with a default; sets `seen_at` when "More" opens |
| `UpdateRow` | An artifact or signal thread: producer · labels · time · acknowledge · label · host ↗ (as on `DecisionCard`; never the kind's name, RFC §4.1a), the newest card's title and `rendered_lead`, its first visual fitted to the row, the thread behind one line, newest last | Acknowledges the thread (the control becomes "Acknowledged · 09:14") |
| `DailyBrief` | "Today's brief" (with "· so far today" until the nightly card exists), "Morning brief" on an earlier day and the day's paragraph: its decisions as title — lead, then one sentence of yesterday's threads the same way, each title linked to its card (`daily_paragraph`) | — |
| `TimeRail` | A day's schedule: its cards with `at`, every producer, `log` included; a bar to `until`, a point without; colour is the producer, length is `until`; the producer legend under it. A card shown on the brief is a marker (time, producer, title) linking to its row | — |
| `WeekStrip` | Seven days, the selected one filled, a dot under days with open decisions (by each card's day, RFC 0.7 §8) | Jumps the timeline to a day |
| `LabelFilter` | Beside the week strip: the labels on the loaded days with counts; while on, a chip with a clear control | Shows only cards carrying any chosen label, in decisions, updates and signals, and only their entries in the daily paragraph; remembered per device; never groups by label (§8) |

**The nightly card's day.** The `head:daily` card dated D is the morning paper for D and reports on D−1; the timeline shows it at the top of D.

Under 900 px the brief is a timeline with a rail of times; from 900 px a broadsheet with decisions on the left (60 %) and the schedule above updates and signals on the right (40 %), with j/k/enter/d. The phone is the first.

**Visuals** (RFC §3.1 Presentation). Diagrams and images in a card are thumbnails fitted to the card width, captioned, in reading order; the Brief shows at most the first visual of a folded card. Tap opens a full-screen viewer with pinch-zoom and pan on the cached SVG or image at native size, a share action, and the fence source behind a disclosure. The viewer is the same component for mermaid output and for producer images, so there is one zoom experience to get right.

Plus a settings screen for producers (name, ceiling, revoke) and notification preferences. That is the whole app.

**What the phone leaves out, on purpose.** No producer management beyond ceilings and revoke; no editing of card bodies; no search in v1; no brief writing or any LLM in the app — the brief arrives already written. If a feature needs a keyboard for more than a sentence, it belongs on the web head.

## Gesture model

The RFC's decision semantics map one to one onto touch, and the mapping is the product.

| Gesture on a decision card | Records | When | RFC |
| --- | --- | --- | --- |
| Tap an action button | That option's `id` as `decision` | At once | §4.4, §4.5 |
| Tap a choice, then its button (options with a `body`) | That option's `id`; the default is pre-selected | At once | §4.4 |
| Tap "Edit…" (only when `actions` lists `edit`), write, send | `edited` + `edited_proposal` | At once | §4.3, §4.4 |
| Tap "Dismiss" | `dismissed` | At once | §4.3 |
| "Add a comment" (a disclosure, never a required field) | `comment` alongside the decision | With it | §4.2, §4.5 |
| Swipe right | The `default` option; `approve` when `actions` is a plain list with `approve`. Nothing when there is no default | After a 4 s undo window | §4.4 |
| Swipe left | `dismissed`, on every decision card; never `reject`, which is a producer action and taken by tapping it | After a 4 s undo window | §4.3, §4.5 |
| Tap the title | Opens the card | — | — |
| Long-press | Snooze picker: tonight, tomorrow's brief, next week | At once | `snoozed_until`, not a state |

The actions are the controls (§4.5): they sit on the card, in the card's order, with the lead and the proposal above them, and nothing gathers them behind a "decide" control. Only a default is drawn as the primary control; a card without a default shows its options with equal weight, so a closed choice is never nudged.

**Taps commit; swipes wait.** A tap is a deliberate choice and is recorded at once: the card shows the decision in place ("Decided: approve · 09:14") and dims, and the protocol's one-way state follows. A swipe is easy to do by accident, so it waits 4 s behind an undo toast; Undo cancels it before anything is sent. Neither is queued offline: with no network the controls are disabled and say why. Artifacts and signals are acknowledged by a button (at once) or by a swipe either way (after the same undo window), which sets `acknowledged_at` and nothing else.

**Orders** are dictated: a text field with a microphone, posted as `head:order:<ulid>` to the producer the person names or to `*`. The app does not try to parse the order; the executor does, and asks back with a decision card if it cannot.

## Auth — what the head must ship before the app

The head has two kinds of caller and they must never share a credential. Producers hold bearer tokens bound to a namespace root (RFC §12). Humans hold a session. The web head can get away with a cookie session; a native app cannot, and retrofitting is painful, so the human auth layer is built API-first from milestone 1 even though only the web uses it at first.

**Decisions.**

1. **Identity providers: Sign in with Apple and passkeys, in that order.** Apple requires Sign in with Apple on any iOS app that offers third-party sign-in, so it is non-negotiable for the App Store. Passkeys (WebAuthn) cover the web head and Android without a password anywhere. No email-and-password at all in v1; a magic-link email as the recovery path only.
2. **Session tokens, not cookies, for the API.** On sign-in the head issues a short-lived access JWT (15 min) and a long-lived refresh token (90 days, rotated on use, stored in the iOS Keychain). The web head uses the same tokens from a cookie-backed client so there is one code path. Refresh tokens are stored hashed server-side and revocable per device.
3. **One head per person, several devices.** The `heads` table gains an `identities` table (provider, subject, head\_id) and a `devices` table (refresh token hash, platform, push token, last seen, name). Settings lists devices and can revoke one.
4. **Decision writes carry the device.** `POST /cards/{id}/decision` from a human session records `actor = device id` in `decision_log`, so the log says which phone approved what. The RFC leaves who-may-decide to the head; this is the head's answer.
5. **No producer route accepts a human session, and no human route accepts a producer token.** Two middlewares, two header conventions (`Authorization: Bearer` for producers, `Authorization: Session` for humans), so a mistake fails loudly.

**What this means for the Next.js app on Vercel.** Add `app/api/auth/{apple,passkey,refresh,logout}` route handlers now; use Auth.js only for the web cookie bridge, not as the source of truth, because its session model does not fit a native refresh-token flow cleanly. Keep the token issuing and verification in `apps/head/lib/auth` as plain functions so the mobile app and the web share them. Apple's sign-in needs a Services ID, a key and a team id in Vercel env; set those up with the App Store account before the app exists so the web head can test the flow.

**Self-hosters** get the same code; Sign in with Apple requires their own Apple developer account, so passkeys are the default there and Apple sign-in is a configuration option.

## Human API

A second, small API under `/api/me/`, session-authenticated, separate from the producer routes. It is what the web head's UI calls too, so building it is not extra work — it is moving the web UI's data access behind an API the phone can share.

| Endpoint | Returns | Notes |
| --- | --- | --- |
| `GET /api/me/brief` | The current `head:daily` card, open decisions, today's folded threads, the last-visit cursor | One call paints the Brief screen |
| `GET /api/me/cards?from=&to=&state=` | Earlier days on the timeline, a week at a time | Paginated by `change_seq`; `before` names the latest earlier day with a card |
| `GET /api/me/cards/{id}` | One card with its thread (predecessors, references, progress) |  |
| `POST /api/me/cards/{id}/decision` | The core decide operation, actor = device | Same semantics as RFC §7.3 |
| `POST /api/me/cards/{id}/ack` | Sets `acknowledged_at` | Artifacts and signals |
| `POST /api/me/cards/{id}/snooze` | Sets `snoozed_until` (`until: null` clears it) |  |
| `POST /api/me/cards/{id}/unsnooze` | Clears `snoozed_until` |  |
| `POST /api/me/visit` | Advances the last-visit cursor | Called when the Brief is closed |
| `GET /api/me/orders` / `POST /api/me/orders` | Open orders with `exec_state`; mint a new order | Cancel is a `dismissed` decision on the order (RFC A.1) |
| `GET /api/me/producers` / `PATCH …/{root}` | Producers, ceilings, revoke | Settings |
| `GET /api/me/devices` / `DELETE …/{id}` | Signed-in devices, each with the zone it last sent | Settings |
| `GET /api/me/settings/head` | Owner id, the head URL a producer is given (origin + `/api`), protocol, extensions, mermaid tiers (§7.5) | Settings → This head |
| `GET`/`POST /api/me/settings/producers`, `PATCH`/`DELETE …/{id}` | Live producer tokens (root, created, last used, ceiling); mint one (shown once, 409 when the root has a live token); set its producer's ceiling; revoke it | Settings → Producers |
| `GET /api/me/settings/labels`, `PATCH …/{label}` | Labels with counts and the owner's ceiling on each (§9) | Settings → Producers |
| `GET /api/me/settings/snippets?root=` | The three values (`producerConfig`) and a curl (`curlSnippet`, @pbcp/client) with this head's api and owner id and `<token>`, the curl's card under `root`; links to each connector's README Setup (`lib/connect.ts`, as `/connect` and `/llms.txt`, which are public) | Settings → Connect a producer |
| `GET /api/me/settings/devices`, `DELETE …/{id}`; `POST /api/me/settings/enrolment` | Devices, signing one out, a one-hour enrolment link for another | Settings → Devices |
| `GET /api/me/settings` / `PATCH` | Head id, display name, effective timezone and its override | Settings. Every `/api/me` request may send `X-Timezone: <IANA zone>`; the head follows the device most recently seen unless the override is set |
| `POST /api/me/devices/{id}/push` | Registers or clears an APNs/FCM token | See Push |

Responses are the same JSON card shape as the producer API, so `@pbcp/core` types are reused in Swift via a generated client (OpenAPI from the Zod schemas). Markdown is rendered on the device; the head never sends HTML.

## Push

Push is the one capability the protocol deliberately does not have, and the phone is where it matters. It is a hosted-head feature: the head sends an APNs (later FCM) notification when a card arrives at `urgency: immediate` after ceilings are applied, and nothing else. No push for `brief` or `log`; the morning brief is pulled, by habit, not pushed.

- Payload is the card id and title only; the body is fetched on open. Nothing from a producer's markdown goes through Apple's servers.
- Tapping opens the Card screen directly; a decision from there behaves exactly as from the Brief.
- Quiet hours are a device setting; `immediate` during quiet hours is delivered silently and surfaces at the top of the next Brief.
- Self-hosted heads can configure their own APNs key; without one the setting is simply absent and `immediate` cards wait for the next open.

**In the web app now (Oct 28, 2026).** While the native app is deferred, the installed web app gets this through Web Push: Settings → Devices has an "Urgent cards" switch per device (off by default), and the PUT that stores a card with `delivery: immediate` sends after its commit, best effort, to each device with it on (`lib/push/urgent.ts`). Unlike the APNs payload above, a Web Push payload is encrypted end to end to the device (RFC 8291), so the push service can't read it: it carries the card's title and its lead as plain text (at most 120 characters), and the card's URL to open. A replacement sends again only if its title or lead changed. There is no outbox: a failed push is not retried.

The head needs one addition for this: an outbox row written in the same transaction as the card, and a tiny sender triggered on write (a Vercel function invoked by the PUT handler after commit). No queue infrastructure; if the send fails the card is still in the brief.

## Build plan

**iOS first, in Swift.** The toolchain, the developer account and the SwiftUI experience already exist from Spejl, and the app is a list and a card. Native is worth it here because the whole value is that the morning flow feels instant; a cross-platform shell would be the thing people notice. Android follows against the same `/api/me/` JSON once the iOS gestures have settled; the API is the contract, not a shared UI codebase. That contract is `packages/api-types/openapi.json`, generated from the head's schemas.

**Deferred (Oct 28, 2026).** The native app is deferred: the web app, installed to the Home Screen, carries the morning brief and its notifications (Web Push) for now. No Swift client is checked in. When the app starts, its client is generated on demand from `packages/api-types/openapi.json` with swift-openapi-generator; mind the nullable fields (`packages/api-types/README.md`).

**What must exist in the head first** (these are milestone-1 and milestone-2 items in the repo skeleton, pulled forward where mobile needs them):

- [ ] Human auth layer: identities, devices, refresh tokens, `Authorization: Session` middleware — built in milestone 1 even though only the web uses it
- [ ] Sign in with Apple configured on the Vercel project (Services ID, key, team id) and tested from the web head
- [ ] Passkey registration and sign-in on the web head
- [ ] `/api/me/` endpoints, with the web UI moved onto them so the phone shares one data path
- [x] OpenAPI generated from the Zod schemas, so the Swift client is generated rather than hand-written (on demand, when the app starts)
- [ ] The brief (its timeline of days) working on the web for a few weeks — the phone copies what proved useful there
- [ ] APNs outbox and sender (hosted tier), behind a config flag

**App milestones.**

1. Sign in, Brief, Card, actions on the card with choice lists, swipe-to-default with undo. Usable for the morning in the first build.
2. Earlier days in the timeline, snooze, acknowledgement, settings (devices, producers).
3. Orders: dictation with voice, open-orders list, cancel.
4. Push on `immediate`; quiet hours.
5. Android, same API, after the iOS gesture set has been stable for a month.

The order is deliberate: the app ships when it can replace the morning mail check, not when it has every screen.
