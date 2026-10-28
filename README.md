# pbcp-head

The reference head for the Personal Brief Card Protocol: a Next.js app on Vercel with Postgres that receives cards from producers, records the owner's decisions, and renders the daily brief. The protocol lives in [morkeleb/pbcp](https://github.com/morkeleb/pbcp); this repo implements it.

See `CLAUDE.md` for scope and rules, `docs/head-skeleton.md` for the design, and `docs/mobile-prd.md` for the phone app this head is built to serve.

## Running it locally

```sh
git submodule update --init      # @pbcp/core and @pbcp/client, pinned in vendor/pbcp
pnpm install                     # also builds the vendored packages
docker compose up -d --wait postgres   # Postgres on localhost:5433
cp .env.example .env
pnpm db:migrate
pnpm mint-token morten hermes    # creates head `morten`, prints a producer token for root `hermes`
# afterwards, signed in: /settings mints and revokes tokens and enrols devices; /connect shows how to connect a producer
pnpm enroll morten               # prints a /signin link to register the owner's first passkey
pnpm dev                         # then open /signin from the enroll link, and /brief
pnpm demo morten                 # example cards from each connector (docs/deploy.md, "Demo data"); --remove takes them out
pnpm demo:purge --head morten    # the demo producers' cards and tokens, leaving real producers alone; --dry-run first
```

`pnpm test` builds the head and runs everything: unit tests, the HTTP tests, and the conformance suite from `@pbcp/core/conformance` over HTTP against a head started in test mode on the `pbcp_test` database. CI runs the same suites inside the Docker image (`docker compose run --rm head pnpm test:gate`).

## Deploying

[`docs/deploy.md`](docs/deploy.md): Vercel with Neon Postgres, or self-hosted with `docker compose up -d`. The environment is documented in [`.env.example`](.env.example).

## What is implemented (milestones H1 and H2)

| Route | Auth | RFC |
| --- | --- | --- |
| `GET /` (and `GET /api`) | none, or producer token | §7.5 |
| `PUT /api/cards/{id}` | `Bearer` producer token | §7.1, §5, §8, §9 |
| `GET /api/changes?after=` | `Bearer` producer token | §7.2 |
| `POST /api/cards/{id}/decision` | `Session` | §7.3 |
| `POST /api/me/cards/{id}/decision`, `/seen`, `/ack` | `Session` | §7.3, §4.2 |
| `POST /api/auth/passkey/{register,login}[/options]`, `/api/auth/apple`, `/api/auth/refresh`, `/api/auth/logout` | — | mobile PRD |
| `GET /api/me/brief`, `GET /api/me/cards?date=`, `GET /api/me/cards/{id}`, `POST /api/me/cards/{id}/snooze`, `POST /api/me/cards/{id}/unsnooze`, `POST /api/me/visit` | `Session` | mobile PRD, §8, §9 |
| `GET /api/me`, `GET/PATCH /api/me/settings`, `GET /api/me/producers`, `PATCH /api/me/producers/{root}`, `GET /api/me/devices`, `DELETE /api/me/devices/{id}` | `Session` | §9, §12 |
| `GET /api/me/svg/{hash}`, `GET /api/me/img?u=&s=` | content hash / signed URL | §3.1 |
| `GET /api/cron/brief` | `CRON_SECRET` | nightly `head:daily` card |
| `POST /api/render/draw` | key derived from `SESSION_SECRET` | internal: draws one mermaid fence (the only route with Chromium) |
| `/brief`, `/card/{id}`, `/orders`, `/signin` | web pages over `/api/me` | |
| `/manifest.webmanifest`, `/sw.js` | none | the web app, installable (below) |

The human API's contract is `packages/api-types/openapi.json`, generated from `lib/api/schemas.ts` (`pnpm api:generate`). Clients generate from it: the owner's MCP package does, and a native app will when one starts (`docs/mobile-prd.md`); see `packages/api-types/README.md`. Every `/api/me` request may send `X-Timezone`, and the head follows the owner's active device unless `/api/me/settings` pins a zone.

**The web app is installable.** "Add to Home Screen" in iOS Safari, or Install in Chrome, gives a standalone app that opens on `/brief`.
- **Cached reads.** A service worker (`lib/pwa/service-worker.ts`) keeps the app shell, plus the brief, the card pages and their data. With no network the brief opens from that copy, marked "as of" the time it was fetched; online, the copy is shown first and replaced as soon as the network answers.
- **Diagrams and images** are cached by their URL.
- **Writes need a connection.** Deciding, acknowledging, snoozing and giving orders are never saved to send later: offline, those controls are disabled and say why. A decision whose undo window closes after the connection dropped is dropped too.
- **No push yet.**

Card bodies are rendered once, on receipt, on the server (§3.1): markdown with raw HTML stripped, `mermaid` fences drawn to SVG with the mermaid CLI in headless Chromium with no network (by the draw route, its own function on Vercel), cached by `sha256(fence)`.

Licensed under the Sustainable Use License (see `LICENSE`).
