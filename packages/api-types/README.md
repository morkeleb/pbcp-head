# @pbcp-head/api-types

The head's human API (`/api/me/` and `GET /`) as an OpenAPI 3.1 document, `openapi.json`. The phone builds against it. It is generated; don't edit it.

- **Source:** the Zod schemas in `lib/api/schemas.ts`. The routes parse their request bodies with them, and the card shape is `@pbcp/core`'s.
- **Swift client:** `apps/ios/Generated/` is generated from this document by [`swift-openapi-generator`](https://github.com/apple/swift-openapi-generator), with `apps/ios/Generated/openapi-generator-config.yaml`. Use it with `OpenAPIRuntime` and a transport such as `OpenAPIURLSession`.
- **Not in the document:** sign-in (`/api/auth/*`) and the producer protocol routes (RFC §7).

## Regenerating

After changing `lib/api/schemas.ts` or `lib/api/openapi.ts`:

```sh
# the generator once, e.g. from a checkout of apple/swift-openapi-generator at 1.14.3:
#   swift build -c release --product swift-openapi-generator
SWIFT_OPENAPI_GENERATOR=/path/to/swift-openapi-generator pnpm api:generate
```

Commit both `openapi.json` and `apps/ios/Generated/`, so a change to the API shows up in review as a diff in both. `test/api-types.test.ts` fails in these cases:
- `openapi.json` no longer matches the schemas;
- the Swift files were generated from another version of it (`apps/ios/Generated/openapi.sha256`);
- an `/api/me` route has no entry.

`test/http/contract.test.ts` calls every route and checks the real responses against `openapi.json`.

## Things the document says that the types can't

- **`X-Timezone`.** Every `/api/me` request may send `X-Timezone: <IANA zone>`. The head follows the device most recently seen with one, unless the owner set an override in `/api/me/settings`. An unknown zone is 400.
- **`snooze.until` is UTC only.** It must end in `Z` or `+00:00` and be later than now; an offset such as `+02:00` is 400 `invalid_snooze`. Presets are resolved in the effective timezone.
- **Nullable fields are always present.** Fields typed `[…, "null"]` are always in the JSON, sometimes as `null`. swift-openapi-generator can't express that, so the Swift client is generated from a copy where they are optional (`scripts/api-generate.ts`). Decoding is the same, because JSON `null` decodes as `nil`.
- **Errors are one shape.** Every refusal, including the image routes' 403/404/502, is `{ "error": "<code>", "message": "…" }`.
- **Owner actions return the protocol card.** `decision`, `seen`, `ack`, `snooze` and `unsnooze` answer with the protocol `Card`, not the `MeCard` the reads return; there is no `rendered_html`. Keep the rendered fields from the earlier read.
