# Trust: what the head keeps, and who may see it

What a head holds about its owner is the record the RFC calls "the sensitive record" (§12): the cards that reached them, what they saw, what they decided and what they ordered. This page says how this head treats it.

## At rest

Card content is encrypted at rest with a key per head. The head reads a card only to render it when it arrives, to fold it into your brief, or to show it to a signed-in device. The operator holds no index of your content. Deleting your head destroys its key. Self-hosting is one Vercel project and a Postgres.

**How.** Each head has a data key, 32 random bytes, kept in the database only wrapped (AES-256-GCM) under the deployment's master key, `HEAD_MASTER_KEY`, which lives in the host's environment and nowhere in the database. Each value is sealed with AES-256-GCM under the data key, with a random nonce and the head and column bound to it, so a value moved to another head or column, or altered by one bit, fails to open: that card is left out of what is served, and the rest is served. The head unwraps the data key for the request that needs it and keeps it nowhere.

**What is encrypted, and what is not, and why.** One rule: content is encrypted; the metadata the head needs to route, order and sync is not.

| | Encrypted | In clear |
| --- | --- | --- |
| Cards | title, summary, body, labels, source (address and label), actions (labels and bodies), any field a producer adds, the rendered HTML and lead, the daily paragraph, your comment and edited text, the copy kept of what you decided on | ids, kind, producer, thread, state, the change counter, every time, the decision value, urgency, delivery, sensitivity, `about`, `at`, `until`, the card's day, `supersedes`, `references`, the orders fields |
| Decision log | your comment and edited text, the copy of the card | card id, the decision value, the device, the time |
| Diagrams | the drawings and their errors | the hash (scoped to your head), the diagram type |
| Invite requests | the address | a keyed digest of it, the time, the browser |

Labels are encrypted because they are a producer's words about your life (`divorce-lawyer`); thread ids are opaque keys. `at` and `about` stay clear because the schedule, the day view and the week strip are indexes over them. The decision value stays clear because producers read it through sync (RFC §7.2). Tokens, devices and sessions were already hashes or opaque.

**What it does not buy.** It is not end-to-end. The head decrypts a card to render it when it arrives, to serve it to your signed-in devices and your assistant, and to fold the nightly brief; whoever runs the head and holds `HEAD_MASTER_KEY` can read content while serving a request. What it protects against is a copy of the database, a backup, or a leaked connection string: those read as ciphertext. Producers that read your mailbox see the mail in their own runner. The protocol is unchanged (RFC §12 leaves storage to the head).

**Search** runs on your devices (docs/local-first.md); the head has no search over content.

**Deleting a head** destroys its data key first: every encrypted value of it is unreadable from that moment, and the rows are then deleted (`pnpm head:delete`).

## Sensitivity

RFC Draft 0.9 §4.1 gives every card a producer-owned `sensitivity`: `normal` (the default), `private` or `confirm`. It says how carefully the head must handle the card's content and its decision on surfaces the owner does not fully control.

**The producer's floor, the owner's ceiling** (§9, §12 "Sensitivity is a floor"). A producer says how carefully a card must at least be handled; the owner may only make that stricter. Settings → Producers sets a floor per producer and per label, and Settings → Preferences one for every card. The head handles each card at the highest of its own value and every floor that covers it (`effective_sensitivity` in /api/me). A floor applies the moment it is set, to the cards already stored as well as new ones: unlike an urgency ceiling, which is about attention and applies to cards stored from then on, a floor is about exposure. The card itself is never rewritten: its `sensitivity` stays as the producer sent it, for equality (§5) and in what the head returns and syncs.

**What each surface may show** of a card whose effective sensitivity is `private` or `confirm`:

| Surface | Shows |
| --- | --- |
| The signed-in web app (brief, card page, day view) | Everything, as any card. It is the owner's own session. |
| Web Push (urgent cards, the daily notification) | The producer's name and the card's kind only ("A private decision from mail"), and it opens the brief, not the card. The RFC allows the title, but asks for producer and kind only on a locked device; the head cannot tell whether a device is locked when it pushes, so every push meets that rule. The daily notification counts private entries ("and 1 private decision"). |
| An assistant connector (the owner MCP at /api/mcp, or any OAuth client with a scoped token) | Id, kind, producer, title, state, labels, when, source, both sensitivities, the decision and its time. Never the summary, lead, body, option bodies, rendered HTML, first visual, or the owner's comment and edited proposal (on the card or in its decision log): an assistant's responses may be indexed. An open `confirm` card comes without `actions`. The nightly card's body is its spoken paragraph, and the brief's paragraph is always the spoken one, private entries counted. **The head itself strips this** from every response to an assistant's scoped token (lib/me.ts `redactForAssistant`), so the rule holds for any client the head registers; the MCP package's own stripping is a second layer, not the rule. |
| Text for outside the session (`/api/me/brief?spoken=1`, a card's `spoken_paragraph`) | Private entries counted, never named. For any text generated outside the head, such as by a model, a private card goes in as a count. |
| The front door's demo | Never shows one. |

**An assistant connector cannot approve a `confirm` card.** A `confirm` card is everything `private` is, and the head records a decision on it, any value including `dismissed`, only after the person has identified themselves to the head again within five minutes on the session that decides: a passkey sign-in, Sign in with Apple, or a passkey step-up (`POST /api/auth/passkey/step-up`). A refresh of the session does not count. Anything else is refused with `403 reauthentication_required`, before anything is written. An assistant holds the owner's credential, not the person, so its session can never satisfy this; neither can a notification action or a voice intent. In the web app, choosing a control on a `confirm` card asks for the passkey and then records the decision, and the controls say so beforehand. Snoozing, acknowledging and opening a card are not decisions and are unaffected.
