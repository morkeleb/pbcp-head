# ios/ — the head's iOS app (foundation)

The foundation the native app builds on: generated models, a local store, an API client, the outbox and the sync, and an app shell with no screens yet. The design is `docs/superpowers/specs/2026-11-10-ios-secretary-design.md`; the store, sync and outbox mirror the web app's (`docs/local-first.md`, `app/(ui)/local/`). Not here yet, on purpose: screens, Siri and App Intents, the briefing machine's package (`docs/briefing-machine.md`), APNs.

`Spike/` is a throwaway: the Siri AI gate of the iOS design (does Siri route a bare "approve" to the app while a briefing runs?), its own scheme and bundle id, depending on PBCPModels only, deleted in one commit when `Spike/FINDING.md` is written.

It lives in this repo, beside the head, so a model change and the Swift that follows it land in one commit. It is under the repo's licence (`LICENSE`).

## Generated from the model

The shapes are the model's (`model/model.json`, `model/README.md`). `pnpm generate` at the repo root writes the Swift alongside the TypeScript; `pnpm generate --check` fails when any generated file, Swift or TypeScript, is stale or edited by hand. Never edit a `*.generated.swift` file.

| Generator | Writes | Touch file (written once, then yours) |
| --- | --- | --- |
| `swift-models` | `Packages/PBCPModels/Sources/PBCPModels/Models.generated.swift`: a `Codable`, `Sendable`, `Equatable` struct or enum for every entity, snake_case keys as the head sends them, the RFC section from each field's `doc` in its comment. Core's card fields are read from `@pbcp/core`'s schema when it runs, never copied. Meta keys are typed (`Meta.cursor` is a `MetaKey<Int>`) | — |
| `swift-store` | `Packages/PBCPStore/Sources/PBCPStore/Store.generated.swift`: the SQLite schema (WAL; one table per object store, the model's indexes, an FTS5 table over the fields the model names for search), the GRDB records, and the actor `Store`; `Packages/PBCPStore/Tests/PBCPStoreTests/RoundTrip.generated.swift` | `Queries.swift`, for hand-tuned reads |
| `swift-client` | `Packages/PBCPClient/Sources/PBCPClient/Operations.generated.swift`: one async method on `HeadClient` per `/api/me` operation in `packages/api-types/openapi.json`, typed on PBCPModels; reads throw, writes answer a `WriteOutcome` | `Auth.swift`, for Sign in with Apple and the passkey assertion (platform code) |

Hand-written beside them: `PBCPModels/Support.swift` (`JSONValue`, `Nullable`, `Timestamp`, the coding helpers, `effectiveSensitivity`, `MetaKey`), `PBCPStore/Runtime.swift` (HTML to `AttributedString` without WebKit, the outbox laid over a card, a command's body), `PBCPClient/HeadClient.swift` (the session, refresh, step-up), and all of `PBCPSync` (behaviour: the model carries none).

## The module graph

```
PBCPModels ← PBCPStore ┐
PBCPModels ← PBCPClient ┴ PBCPSync ← App
```

One direction only; nothing imports upward. The app does not depend on GRDB. (The brief named `PBCPModels ← PBCPStore ← PBCPClient ← App`; the client does not need the store, so the two sit side by side, and the outbox and the sync, which need both, are a package of their own so they can be tested with a fake head.)

## The invariant

**Nothing touches the database or the network on the main actor, and that is a compile error, not a rule.** The only `DatabasePool` in the app is `Store.pool` and the only `URLSession` is `HeadClient.session`; both are `internal` to their modules, so no view or view model can name them. `Store`, `HeadClient`, `Outbox` and `Sync` are actors; what crosses to the main actor is a `Sendable` value. A view model gets snapshots from the store's observations (`observeDay`, `observeCard`, `observeTasks`, `observeOrders`, `observeWaitingCount`: GRDB `ValueObservation`, values only).

`scripts/check-invariants.sh` type-checks `Tests/Invariants/*.swift`, files that must not compile, against the built modules, and passes only when the compiler refuses each line with the error its `// expect:` comment names. Every target builds with Swift 6 (complete concurrency checking) and warnings as errors.

## The parts

- **Three actors, no singletons.** `Store`, `HeadClient`, `Outbox` (with `Sync` beside them) are made once at launch (`App/Sources/PBCPApp.swift`) and reach views through the SwiftUI environment, so previews and tests inject fakes.
- **The outbox** drains rows in order under one task and answers as `docs/local-first.md`'s table says: 2xx the row leaves and the head's card is merged into the stored one (the head answers owner actions with the protocol card, so what it rendered is kept); 409 the head's state wins; 403 `reauthentication_required` the row waits with every row behind it until `resume` after a passkey step-up, and survives a relaunch; another 4xx the row is dropped; no network or 5xx the row stays and is tried after 1 s, 10 s, 1 min, then every 5 min. It runs on launch, on every return to the foreground, after every sync that reached the head and when the network returns.
- **The sync** reads `GET /api/me/seq` first; pulls the days ahead and the retention window a week at a time, newest first, on its first run; then pages the changes since the cursor; refetches the floors and recomputes every stored card's `effective_sensitivity` (a Swift port of core's `effectiveSensitivity`) when `settings_seq` moves; keeps the brief the head composed; evicts past retention. It runs on launch, on every return to the foreground and from background refresh (`app.pbcp.sync`); a push will start it too once APNs arrives (a later step).
- **Rendering off the main actor.** The head's sanitised HTML is converted to an `AttributedString` inside the store when a card is applied and kept beside it, so a list never parses HTML.
- **Errors are values.** Every write answers `sent`, `conflict(card)`, `needsPerson`, `refused(status, message)` or `offline`. The client never signs out on a network error; a refused refresh signs out.

## Working on it

```sh
pnpm generate                    # at the repo root, after changing model/model.json
cd ios && swift test             # the packages, on macOS
./scripts/check-invariants.sh    # the invariant
cd App && xcodegen generate && open PBCP.xcodeproj
```

Needs Xcode 26 (Swift 6.2 tools) and XcodeGen. The Xcode project is generated from `App/project.yml` and not committed. The app connects to the head in `UserDefaults` `head_url` until onboarding exists.

## Tests

- **The round trip** (`RoundTrip.generated.swift`): every `model/fixtures/*.json` is decoded with the generated model, written to the SQLite store, read back and encoded to canonical JSON equal to the fixture. The TypeScript half (`test/model/roundtrip.test.ts`) reads the same files, so a field one side keeps and the other drops fails.
- **The store**: a day of cards applied from a background task while a main-actor observer receives snapshots; latest change_seq wins; the outbox laid over a card; search; meta rows and eviction.
- **The outbox**: each of the head's answers, with a fake head.
- **The sync**: a moved `settings_seq` recomputes effective sensitivity with no card changed.

CI (`.github/workflows/ios.yml`): the generate check, `swift test`, the invariant check, and the app built for the simulator.

## What Swift could not express as generated

- **Core's timestamps are `String`.** Core's schema checks a timestamp with a refinement, which its JSON Schema does not carry, so core's fields (`received_at`, `at`, …) are strings; the model's own `Timestamp` fields are the `Timestamp` type (the text kept exactly, `.date` to read it).
- **Producers' own fields** survive in `extra: [String: JSONValue]` on the types the protocol leaves open (the card, its source and actions, the describe document).
- **`T | null`, optional** is `Nullable<T>?`, so absent and null stay apart and encode back as they came.
- **A union with no tag** (`SnoozeRequest`: `until` or `preset`) decodes by which key is present.
- **Clay's TypeScript engine cannot write a `.swift` file**: it names its output after the template, and loads only `.ts` templates. The Swift generators are one-line EJS templates (Clay strips `.ejs`) that hand the model to a TypeScript emitter (`model/generators/swift-*/emit*.ts`) through jiti, from the repo root, where Clay always runs. A Clay change that lets a `ts` template name a non-`.ts` output would remove the bridge.
