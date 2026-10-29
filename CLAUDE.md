# head — reference head for PBCP

This repo is the **product**: the reference head (Next.js on Vercel, Postgres). It implements RFC draft 0.8 of the Personal Brief Card Protocol. The protocol itself lives in `morkeleb/pbcp` and arrives here as `@pbcp/core` and `@pbcp/client`; this repo never redefines a protocol rule.

## Read first

- `vendor/pbcp/rfc/pbcp-draft-0.8.md` — the spec, as pinned by the submodule. The canonical text is in the `pbcp` repo. If the head needs the RFC to change, open an issue there; never edit the vendored copy.
- `docs/head-skeleton.md` — the schema, routes, rendering pipeline and build order for this repo.
- `docs/mobile-prd.md` — why the human auth layer is built API-first from day one, and the `/api/me/` surface the phone will use.

## Dependency on the protocol

`@pbcp/core` and `@pbcp/client` are not on npm yet. They come from a git submodule at `vendor/pbcp` (`morkeleb/pbcp`), pinned to `d9b9c1f`, and linked as workspace packages (`pnpm-workspace.yaml`). Move the pin in its own commit, and run the conformance gate with it. When the packages are published, switch to the npm versions in one commit and remove the submodule.

## Where this is

H1 (the core over HTTP, behind the conformance gate), H2 (the brief) and H3 (orders) are done, and the gate passes all 59 cases of the Draft 0.7 suite over HTTP. Since then these have shipped:
- the brief: the nightly `head:daily` card, and a live `/brief` laid out by day;
- Settings: producers with ceilings, pairing codes, devices and preferences, plus the `/connect` reference page;
- the owner's MCP server at `/api/mcp`, with OAuth;
- Web Push for the daily notification and for urgent cards;
- the landing page at `/`.

The native phone app is deferred, and the Swift client was removed: the web app on a phone, with push, is the phone client for now. There is no milestone list to work through. New work arrives as a brief or an issue, and `docs/` describes what exists.

Not here yet, and known: encryption of card content at rest (before anyone but the owner has an account); an offline outbox in the PWA for decisions made without a network; Obsidian vault sync of the decision log; OAuth clients identified by a Client ID Metadata Document.

## Rules

- **Protocol logic lives in `@pbcp/core`.** If a route needs to decide something the core does not, that is either a head concern (auth, storage, rendering) or an RFC gap. Never reimplement a core rule in a handler.
- **One transaction per protocol operation.** Counter bump, card write(s), decision log — all or nothing. `change_seq` comes from `change_counter` inside the same transaction.
- **Two credential types, never mixed.** Producer routes accept only `Authorization: Bearer <producer token>`; `/api/me/` accepts only `Authorization: Session <jwt>`. A route that accepts both is a bug.
- **No worker process.** Lease expiry is evaluated lazily; the brief is a Vercel Cron. The head deploys as one Vercel project.
- **Render on receipt, server-side.** Producer markdown is never executed in a browser or on a phone (RFC §3.1).
- **No marketing, no product names** beyond what the RFC's examples use.
- The signed-out front door (`/` for a browser) is the one page that may use product language; the no-marketing rule applies to code, docs and every other page.
- TypeScript strict, Next.js App Router, Drizzle, Postgres, vitest. `docker-compose.yml` brings up Postgres for local work and CI.

## Licence

Sustainable Use License (see `LICENSE`): free to use, modify and self-host for yourself or your organisation; not free to offer this application as a hosted service to third parties. The protocol it implements is MIT in its own repo, and anyone may build a different head from it.

## When unsure

Quote the RFC section in the commit. A question the RFC cannot answer goes to the `pbcp` repo's `rfc/OPEN.md` as an issue, not into a guess here.
