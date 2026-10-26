# pbcp-head

The reference head for the Personal Brief Card Protocol: a Next.js app on Vercel with Postgres that receives cards from producers, records the owner's decisions, and renders the daily brief. The protocol lives in [morkeleb/pbcp](https://github.com/morkeleb/pbcp); this repo implements it.

See `CLAUDE.md` for scope and rules, `docs/head-skeleton.md` for the design, and `docs/mobile-prd.md` for the phone app this head is built to serve.

## Running it locally

```sh
git submodule update --init      # @pbcp/core and @pbcp/client, pinned in vendor/pbcp
pnpm install                     # also builds the vendored packages
docker compose up -d --wait      # Postgres on localhost:5433
cp .env.example .env
pnpm db:migrate
pnpm mint-token morten hermes    # creates head `morten`, prints a producer token for root `hermes`
pnpm enroll morten               # prints a /signin link to register the owner's first passkey
pnpm dev                         # then open /signin from the enroll link, and /brief
```

`pnpm test` builds the head and runs everything: unit tests, the HTTP tests, and the conformance suite from `@pbcp/core/conformance` over HTTP against a head started in test mode on the `pbcp_test` database.

## What is implemented (milestones H1 and H2)

| Route | Auth | RFC |
| --- | --- | --- |
| `GET /` (and `GET /api`) | none, or producer token | §7.5 |
| `PUT /api/cards/{id}` | `Bearer` producer token | §7.1, §5, §8, §9 |
| `GET /api/changes?after=` | `Bearer` producer token | §7.2 |
| `POST /api/cards/{id}/decision` | `Session` | §7.3 |
| `POST /api/me/cards/{id}/decision`, `/seen`, `/ack` | `Session` | §7.3, §4.2 |
| `POST /api/auth/passkey/{register,login}[/options]`, `/api/auth/apple`, `/api/auth/refresh`, `/api/auth/logout` | — | mobile PRD |
| `GET /api/me/brief`, `GET /api/me/cards?date=`, `GET /api/me/cards/{id}`, `POST /api/me/cards/{id}/snooze`, `POST /api/me/visit` | `Session` | mobile PRD, §8, §9 |
| `GET/PATCH /api/me`, `GET /api/me/producers`, `PATCH /api/me/producers/{root}`, `GET /api/me/devices`, `DELETE /api/me/devices/{id}` | `Session` | §9, §12 |
| `GET /api/me/svg/{hash}`, `GET /api/me/img?u=&s=` | content hash / signed URL | §3.1 |
| `GET /api/cron/brief` | `CRON_SECRET` | nightly `head:daily` card |
| `/brief`, `/day/{date}`, `/card/{id}`, `/signin` | web pages over `/api/me` | |

Card bodies are rendered once, on receipt, on the server (§3.1): markdown with raw HTML stripped, `mermaid` fences drawn to SVG with the mermaid CLI in headless Chromium with no network, cached by `sha256(fence)`.

Licensed under the Sustainable Use License (see `LICENSE`).
