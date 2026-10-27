# Head — reference implementation skeleton

Extracted from the pbcp repo's `docs/skeleton.md`. The protocol packages are in `morkeleb/pbcp`; this repo is the product.

## Repo 2 — `head` (Sustainable Use)

The product: the reference head and its phone app, one API contract between them. Depends on `@pbcp/core` and `@pbcp/client` from npm, pinned, and runs the conformance suite in CI.

```
head/
├── apps/
│   ├── head/                  Next.js 15, App Router, Vercel
│   │   ├── app/api/cards/[id]/route.ts            PUT            (producer)
│   │   ├── app/api/cards/[id]/decision/route.ts   POST
│   │   ├── app/api/cards/[id]/claim/route.ts      POST           (orders ext.)
│   │   ├── app/api/changes/route.ts               GET            (producer)
│   │   ├── app/api/me/**                          human API      (session)  — see mobile PRD
│   │   ├── app/api/auth/{apple,passkey,refresh,logout}           — see mobile PRD
│   │   ├── app/api/cron/brief/route.ts            nightly summary card
│   │   ├── app/(ui)/brief, day/[date], card/[id]  the review surface, on /api/me
│   │   ├── db/schema.ts        Drizzle schema (Postgres)
│   │   └── lib/                auth (producer + session), counter, folding, push outbox
│   └── ios/                   SwiftUI; client generated from the head's OpenAPI
├── packages/
│   └── api-types/             OpenAPI from the Zod schemas, consumed by ios/
└── docker-compose.yml         Postgres for self-hosters
```

### Head app

Next.js App Router on Vercel, Postgres via Drizzle (Neon in hosted mode, any Postgres self-hosted). Four tables carry the whole protocol; the fifth is the one piece of state the RFC leaves to the head.

```sql
create table heads (
  id            text primary key,          -- person id, e.g. 'morten'
  created_at    timestamptz not null default now()
);

create table producer_tokens (
  token_hash    bytea primary key,
  head_id       text not null references heads(id),
  root          text not null,             -- namespace root this token may write; one root per token (§12)
  instance      text,                      -- optional principal suffix, two installs ≠ one producer
  urgency_ceiling text not null default 'brief',
  executor      boolean not null default false,   -- eligible for to_producer:'*' (head policy, A.1)
  revoked_at    timestamptz
);

create table cards (
  head_id       text not null references heads(id),
  id            text not null,
  producer      text not null,             -- denormalised from id, checked on write
  namespace     text not null,             -- second id segment, for supersedes checks
  producer_doc  jsonb not null,            -- the ProducerCard exactly as accepted (equality is computed on this)
  state         text not null,             -- open | decided | superseded
  change_seq    bigint not null,
  received_at   timestamptz not null, changed_at timestamptz not null,
  seen_at timestamptz, acknowledged_at timestamptz, snoozed_until timestamptz,
  decision text, edited_proposal text, comment text, decided_at timestamptz, delegated_to text,
  decided_doc   jsonb,                     -- frozen copy of producer_doc at decision time (§4.3)
  exec_state text, claimed_by text, claim_expires_at timestamptz, claim_seq int,
  wildcard_eligible text[],                -- executors snapshotted at mint time (A.1)
  primary key (head_id, id)
);
create index cards_sync on cards (head_id, change_seq);
create index cards_thread on cards (head_id, producer, (producer_doc->>'thread'));

create table change_counter (
  head_id text primary key references heads(id),
  seq     bigint not null default 0
);
-- every write: update change_counter set seq = seq + 1 where head_id = $1 returning seq  (same transaction)

create table decision_log (                -- append-only; the thing the hosted version is really keeping
  head_id text, card_id text, decision text, decided_at timestamptz, decided_doc jsonb, actor text
);
```

**Routes** are thin: parse → load → call `@pbcp/core` → apply the returned effect in one transaction → respond. The handler for `PUT /api/cards/[id]` is the only one with any logic of its own, and that logic is "begin; bump counter; if `supersedes`, also mark the predecessor; commit".

| Route | Core call | Transactional effect |
| --- | --- | --- |
| `PUT /api/cards/[id]` | `parseCard`, `inRoot`, `canSupersede`, `checkOutcome`, `submit`, `applyOutcome` | insert/replace card; mark predecessor; one or two `change_seq`; an outcome (stored under its per-claim id) moves its order when it comes from the current claim (A.3) |
| `GET /api/changes?after=` | — | `where change_seq > $after and (producer = $root or (kind='order' and (to_producer = $root or $root = any(wildcard_eligible)))) order by change_seq limit 200` |
| `POST /api/cards/[id]/decision` | `decide` | set decision fields, freeze `decided_doc`, append `decision_log`; for orders also `exec_state = cancelled` |
| `POST /api/cards/[id]/claim` | `checkLease`, `expireIfDue`, `claim`, `ClaimRefusal` | `select … for update`; expiry is evaluated inside the same row lock and kept when the claim is refused (409 `lease_held`, 410 `order_terminal`); a renewal keeps `claim_seq` (A.2, A.5) |
| `GET /api/cron/brief` | — | Vercel Cron, 05:30 local; mints `head:daily:YYYY-MM-DD` through the same PUT path |

Auth: bearer token → sha256 → `producer_tokens` lookup, root attached to the request. Human sessions for the UI are a separate concern (NextAuth or similar) and never touch producer routes.

**No worker process.** Lease expiry is evaluated lazily on the next claim or sync that touches the order, which A.2 permits; the brief is the only scheduled job. That is what keeps the whole head deployable as a single Vercel project.

**MCP adapter** (`@pbcp/mcp`): three tools, `submit_card`, `poll_changes`, `claim_order`, each a one-line call into `HeadClient`. Shipped separately so the head app has no MCP dependency.

**Rendering pipeline** (RFC §3.1). Every card body is rendered once, on receipt, server-side, and the result is what both web and phone display. No producer text is ever executed in a browser or on a phone.

1. On PUT, after commit: markdown → HTML through a strict renderer (no raw HTML, GFM tables and tasks on), with `mermaid` fences lifted out.
2. Each fence is sanitised (`click`, URL-loading `%%{init}%%`, `htmlLabels` stripped), classified by type into core / extended / other, and rendered to SVG with the mermaid CLI in a Vercel function. Output is cached in blob storage under `sha256(fence)`; identical fences across cards and re-PUTs are drawn once.
3. A fence that fails or is unsupported is replaced by the fallback block from §3.1 — the type label, a one-line note, the source in a collapsed code block.
4. The rendered HTML, with `<img src="/api/me/svg/<hash>">` where the diagrams go, is stored beside the card. `/api/me/svg/<hash>` serves the cached SVG with a long cache lifetime; the iOS app shows it in a native image view, no WebView.
5. `GET /` reports `render.mermaid: ["core", "extended"]` so producers can check what this head draws.

This is also why the "dashboard" needs no feature of its own: the Brief renders artifact cards, and a card with a `gantt`, a `pie` and an `xychart-beta` is a dashboard. Pinning favourite cards to the top is a head preference, not a protocol concern.

## Build order and the open-source / hosted split

Open source with a hosted alternative is the right shape for this, and the layout is already cut along that line. The protocol and the connectors have to be open or nobody trusts the authority boundary; the hosted product earns its keep on the parts that are a chore to run yourself. The split follows n8n: the line is drawn between building on the protocol (always allowed, actively promoted) and reselling the app (not allowed), never between features.

| Layer | Licence | Why |
| --- | --- | --- |
| `@pbcp/core`, `@pbcp/client`, `@pbcp/mcp`, `rfc/`, `connectors/` | MIT | A protocol with a proprietary client is not a protocol. Anyone may build another head, another client, another connector — that is adoption, and it is the goal. |
| `apps/head` | Sustainable Use Licence (n8n's model) | Free to self-host, read, modify and run for yourself or your company. Not free to offer *this app* as a hosted service to others. A competing head built from the RFC is allowed and welcome; a rehosted copy of this one is not. |
| Hosted head | Paid | Decision memory kept and backed up for years, the mobile app, push on `immediate`, the nightly brief writer, head-to-head delegation when Appendix B lands. None of it needs to be closed; it needs to be *run*. |

Self-hosted and hosted are one codebase with a `HOSTED=1` switch for billing and multi-head routing. The first paying customer is you, which keeps the hosted features honest.

**Milestone 1 — the core round-trips (one week of evenings).**

1. `@pbcp/core`: types, parser, equality, `submit`/`decide`/`canSupersede`. Conformance C01–C15 pass in-process.
2. `apps/head`: schema, the three core routes, token auth. C01–C15 pass over HTTP against local Postgres.
3. `@pbcp/client`: `HeadClient` + `runProducer`. A CLI `pbcp submit card.md` / `pbcp sync` on top of it.
4. `connectors/imap`: your real mailbox → decision cards → approve → reply sent. The first day you read mail in the head and not in the mail client is the milestone.

**Milestone 2 — the brief.** Day view, global last-visit cursor, the nightly `head:daily` card, urgency ceilings. Still no LLM; folding is mechanical.

**Milestone 3 — orders.** `orders.ts`, the claim route, `runExecutor`, C16–C20. A Claude Code loop as the first executor. Todoist as the second, which is where the "orders are the to-do list" claim gets tested.

**Deliberately after that:** the LLM brief writer, the mobile app, delegation, and any second head implementation. Each is a reason to revisit the RFC with evidence rather than opinion.
