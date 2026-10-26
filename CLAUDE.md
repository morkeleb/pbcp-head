# head — reference head for PBCP

This repo is the **product**: the reference head (Next.js on Vercel, Postgres) and, later, its phone app. It implements RFC draft 0.3 of the Personal Brief Card Protocol. The protocol itself lives in `morkeleb/pbcp` and arrives here as `@pbcp/core` and `@pbcp/client`; this repo never redefines a protocol rule.

## Read first

- `rfc/pbcp-draft-0.3.md` — a read-only copy of the spec, for reference. The canonical text is in the `pbcp` repo. If the head needs the RFC to change, open an issue there; do not edit the copy.
- `docs/head-skeleton.md` — the schema, routes, rendering pipeline and build order for this repo.
- `docs/mobile-prd.md` — why the human auth layer is built API-first from day one, and the `/api/me/` surface the phone will use.

## Dependency on the protocol

`@pbcp/core` and `@pbcp/client` are not on npm yet. Depend on them from git at the `v0.3.0` tag (`morkeleb/pbcp`, merge commit `e8521db`): a git dependency with the package subpath if pnpm resolves it (`github:morkeleb/pbcp#e8521db&path:packages/core`), otherwise a git submodule at `vendor/pbcp` with `file:` links. Either way, pin the commit. When the packages are published, switch to the npm versions in one commit.

## What is being built, in order

**Milestone H1 — the core over HTTP.** Stop at the end of this milestone.

1. Postgres schema from `docs/head-skeleton.md` (Drizzle): `heads`, `producer_tokens`, `cards`, `change_counter`, `decision_log`, plus the auth tables from the mobile PRD (`identities`, `devices`). Migrations checked in.
2. Producer routes: `PUT /api/cards/[id]`, `GET /api/changes`, `POST /api/cards/[id]/decision`, and `GET /` (RFC §7.5). Each route parses, loads, calls `@pbcp/core`, applies the returned effect in one transaction, responds. The handlers contain no protocol logic of their own.
3. Producer auth: bearer token → sha256 → `producer_tokens`; root attached to the request. A CLI or script to mint a token for a head.
4. Human auth layer, API-first: Sign in with Apple and passkeys behind `app/api/auth/*`, access JWT + rotating refresh token, `Authorization: Session` middleware, `devices` rows. No UI beyond a minimal sign-in page.
5. `/api/me/` routes for the owner-side actions the conformance suite needs: decide, seen, acknowledge. The rest of `/api/me/` is milestone H2.
6. **The gate:** the conformance suite from `@pbcp/core/conformance` (C01–C15, C21, C22, C24 at SHOULD, R01–R08) runs over HTTP against this head on local Postgres via an adapter in `test/conformance/`, and passes. This is the first time two implementations of the protocol are compared; treat any failure as either a head bug or an RFC finding, never as a reason to edit a fixture.

**Milestone H2 — the brief** (not yet): `/api/me/brief`, day view, last-visit cursor, the nightly `head:daily` card, urgency ceilings, server-side rendering pipeline, the web UI on `/api/me`.

**Milestone H3 — orders**, then push, then the iOS app, in that order.

## Rules

- **Protocol logic lives in `@pbcp/core`.** If a route needs to decide something the core does not, that is either a head concern (auth, storage, rendering) or an RFC gap. Never reimplement a core rule in a handler.
- **One transaction per protocol operation.** Counter bump, card write(s), decision log — all or nothing. `change_seq` comes from `change_counter` inside the same transaction.
- **Two credential types, never mixed.** Producer routes accept only `Authorization: Bearer <producer token>`; `/api/me/` accepts only `Authorization: Session <jwt>`. A route that accepts both is a bug.
- **No worker process.** Lease expiry (later) is evaluated lazily; the brief is a Vercel Cron. The head deploys as one Vercel project.
- **Render on receipt, server-side.** Producer markdown is never executed in a browser or on a phone (RFC §3.1). This is milestone H2, but nothing in H1 may assume client-side rendering.
- **No marketing, no product names** beyond what the RFC's examples use.
- TypeScript strict, Next.js App Router, Drizzle, Postgres, vitest. `docker-compose.yml` brings up Postgres for local work and CI.

## Licence

Sustainable Use License (see `LICENSE`): free to use, modify and self-host for yourself or your organisation; not free to offer this application as a hosted service to third parties. The protocol it implements is MIT in its own repo, and anyone may build a different head from it.

## When unsure

Quote the RFC section in the commit. A question the RFC cannot answer goes to the `pbcp` repo's `rfc/OPEN.md` as an issue, not into a guess here.
