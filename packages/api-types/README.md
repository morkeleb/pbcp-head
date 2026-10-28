# @pbcp-head/api-types

The head's human API (`/api/me/` and `GET /`) as an OpenAPI 3.1 document, `openapi.json`. It is the contract clients generate from: `packages/owner-mcp` (`pnpm api-types`), and a native app when one starts (`docs/mobile-prd.md`). It is generated; don't edit it.

- **Source:** the Zod schemas in `lib/api/schemas.ts`. The routes parse their request bodies with them, and the card shape is `@pbcp/core`'s.
- **Not in the document:** sign-in (`/api/auth/*`) and the producer protocol routes (RFC §7).

## Regenerating

After changing `lib/api/schemas.ts` or `lib/api/openapi.ts`:

```sh
pnpm api:generate                          # openapi.json
(cd packages/owner-mcp && pnpm api-types)  # the MCP package's types from it
```

Commit `openapi.json`, so a change to the API shows up in review as a diff. `test/api-types.test.ts` fails when `openapi.json` no longer matches the schemas, or an `/api/me` route has no entry.

`test/http/contract.test.ts` calls every route and checks the real responses against `openapi.json`.

## Things the document says that the types can't

- **`X-Timezone`.** Every `/api/me` request may send `X-Timezone: <IANA zone>`. The head follows the device most recently seen with one, unless the owner set an override in `/api/me/settings`. An unknown zone is 400.
- **`snooze.until` is UTC only.** It must end in `Z` or `+00:00` and be later than now; an offset such as `+02:00` is 400 `invalid_snooze`. Presets are resolved in the effective timezone.
- **Nullable fields are always present.** Fields typed `[…, "null"]` are always in the JSON, sometimes as `null`. swift-openapi-generator 1.x can't express that: it drops the `null` and decodes such a field as required, so `"next": null` fails. A Swift client should be generated from a copy where those properties are optional instead (JSON `null` then decodes as `nil`). The transform that did this was removed with the checked-in client; it is in git history at `scripts/api-generate.ts` before this change.
- **Errors are one shape.** Every refusal, including the image routes' 403/404/502, is `{ "error": "<code>", "message": "…" }`.
- **Owner actions return the protocol card.** `decision`, `seen`, `ack`, `snooze` and `unsnooze` answer with the protocol `Card`, not the `MeCard` the reads return; there is no `rendered_html`. Keep the rendered fields from the earlier read.
