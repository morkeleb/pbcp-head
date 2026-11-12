# model/ — the shapes the head and its clients share

One declarative model of the owner API (`/api/me`, and `GET /`) and of what a client keeps on the device (the store, the outbox, the meta rows). Generators read it with [Clay](https://morkeleb.github.io/clay/) and write the files that carry those shapes. The head generates its TypeScript here. A client in another language pins this folder and generates its own code from the same model, so contract drift between the two can't creep in unseen.

The model carries **shapes and invariants**: which fields exist and are required, which enums are closed, which fields must have at least one given. It never carries **behaviour**. How a fold is composed, when the outbox sends, or what a 409 means is code and prose, gauged by tests and by the briefing machine's event lists.

It never redefines a protocol field. Core's producer-owned card and head fields (`ProducerCardSchema`, `HeadFieldsSchema`) and its enums (`KINDS`, `STATES`, `URGENCIES`, `SENSITIVITIES`) are **imports**: the generated code extends or reads core's schema by reference, so a change to the RFC arrives through `@pbcp/core` and nowhere else. Every head-owned field cites where its rule comes from in a `doc` attribute (an RFC section, or a doc), and a generated type's comment repeats it.

## What it holds

| Entity | What it is | Layer |
| --- | --- | --- |
| `Card` | Core's card (by reference), core's head fields, the orders extension's outcome fields (A.3) | api |
| `MeCard` | The card as `/api/me` serves it: `Card` plus `effective_sensitivity`, `rendered_html`, `rendered_lead`, `lead`, `first_visual`, `day`, `replaced_by`, `paragraph`, `spoken_paragraph`, … | api |
| `ParagraphParts` (entries, folds, tasks) | The daily paragraph in parts, both sensitivities per entry, folds (RFC 0.9 §8), routine tasks (§9) | api |
| `Brief`, `BriefStamp`, `LastVisit`, `Fold` | `GET /api/me/brief`, `GET /api/me/seq` (`settings_seq`) | api |
| `CardDetail`, `CardList`, `CardSummary`, `OrderWithProgress`, `OrderList` | The card page, the change feed, orders | api |
| `Settings`, `Producer`, `Label`, `Device`, tokens, pairing, … | What Settings shows and changes | api |
| request bodies (`DecisionRequest`, `SnoozeRequest`, `OrderRequest`, the patches, …) | What the routes parse | api |
| `StepUpOptions`, `StepUpRequest`, `StepUpResult` | The passkey step-up (`/api/auth/passkey/step-up`; sign-in routes stay out of the OpenAPI document) | api, unregistered |
| `Floors` | The owner's floors as a device keeps them (§9) | store |
| `OutboxRow`, `OutboxAction`, `OutboxStatus` | A command not yet sent | store |
| `Meta` | The meta rows, by key: cursor, `settings_seq`, floors, fold policies, retention, archive, oldest day, the last brief, orders, `synced_at` | store |
| `Command`, `Outcome` | What a row asks of the head and the route it goes to; what became of it (sent, conflict, needs-person, refused, waiting) | store |
| `store` | The object stores, their keys and indexes, and the schema version | store |

## The generators

`pnpm generate` runs Clay on `model/model.json`. It then builds the OpenAPI document from the generated schemas (`packages/api-types/openapi.json`, as before) and the owner MCP's types from that (`packages/owner-mcp/src/api.d.ts`). `pnpm generate --check` writes nothing: it generates into a scratch directory and fails, naming each file, when a generated file in the repo differs. It runs first in `pnpm test`.

| Generator | Writes | Replaces |
| --- | --- | --- |
| `ts-api` | `lib/api/schemas.generated.ts`: a Zod schema for every api-layer entity, registered as `responses` or `requests` | The hand-written schemas in `lib/api/schemas.ts`, which now keeps `parseRequest` and re-exports these |
| `ts-store` | `app/(ui)/local/model.generated.ts` (`MeCard` and the other API types it keeps, as `z.infer` of ts-api's schemas; `Floors`, `OutboxRow`, `Meta`, the object stores and `STORE_VERSION`); `app/(ui)/local/commands.generated.ts` (`Command`, `COMMAND_ROUTES`, `Outcome`); `test/model/roundtrip.test.ts` | The hand-written types in `components.tsx`, `store.ts`, `outbox.ts`, `feed.ts`, `db.ts` and `orders-view.tsx` |

Both are Clay `engine: "ts"` templates under `generators/`, sharing `generators/lib/`. A precheck (`generators/checks/model-keys.ts`) refuses a model with a key this README does not document, or a reference to a name the model does not have, before anything is written.

**Generated files are never edited.** Change the model or a template and run `pnpm generate`. `clay init-claude` installed a Claude Code hook (`.claude/settings.json`) that refuses an edit to any file in Clay's ledger (`.clay`). `.gitattributes` marks those files as generated, so their diffs fold in review.

**A touch file is emitted once and never overwritten.** ts-store's one touch file is `app/(ui)/local/store.local.ts`, for IndexedDB index choices the model does not state. Clay does not track it, and the device owns it from then on.

## The model format

`model.json` is a Clay model: `name`, `generators`, and `model` with these keys. The precheck enforces exactly these.

- `imports` — names taken from elsewhere by reference: `{ name, import, from, kind: "schema" | "const", doc }`. `from` is a package or a repo path.
- `scalars` — named primitives (`Timestamp`, `Zone`, `Seq`).
- `enums` — `{ name, values }`, or `{ name, from, plus }` for a core constant plus extra values; `export` names a constant array to export; `layer: "store"` for client-only enums.
- `types` — `{ name, fields }`, with:
  - `extends` (a type or a schema import);
  - `union` (variants, each with `fields`);
  - `is` (another schema, under this name) or `alias`;
  - `registry` (`responses` | `requests`), `id`, `description` (the document's component);
  - `describe`, `doc`;
  - `export: false`;
  - `atLeastOne: { fields, message }` (an invariant);
  - `layer: "store"`.
- A field is `{ name, type, … }`, where `type` is one of:
  - `string`, `integer`, `number`, `boolean`, `unknown`;
  - `literal` (`value`), `enum` (`values`), `ref` (`ref`, optional `member` of a schema import);
  - `array` / `record` (`of`), `object` (`fields`, optional `extends`, optional `name` for clients that need one).

  Modifiers are `optional`, `nullable`, `min`, `nonnegative`, `positive` and `pattern`. `describe` is what the API document says. `doc` is where the rule comes from, and it never reaches the document. `{ "spread": "HeadFields" }` in a field list places every field of that import there.
- `store` — `version`, and `objectStores: [{ const, name, keyPath, autoIncrement, holds, indexes }]`.

## Fixtures: the contract across languages

`fixtures/*.json` are samples, each `{ "entity": "<name>", "value": { … } }`:
- a day's brief, and a brief with a fold of six;
- a private decision, a confirm task, and a card with every optional field absent;
- a superseded card with `replaced_by`;
- an order, an outcome, a delegated decision, and the nightly card.

The generated test `test/model/roundtrip.test.ts` takes each fixture through the store and back:
1. decodes it with the generated schema;
2. writes it to the web store through `db.ts` (in `fake-indexeddb`);
3. reads it back and encodes it to canonical JSON (keys sorted), which must equal the fixture.

It also fails when a field of a stored entity appears in no fixture. A field added to the model needs a sample.

A second language's generated test reads the same files and does the same: decode, store, read back, encode, compare. A field the web store keeps and another client drops then fails on one side. The briefing machine's event lists (`docs/briefing-machine.md`) are not here: they gauge behaviour, which the model does not carry.

## Pinning `model/` from a client repo

A client repo adds this repository as a git submodule (the way this repo pins `vendor/pbcp`), at a commit of `main`. It points Clay at the submodule's `model/model.json` with its own generators, and runs `clay init` in its own root for its own ledger. To take a model change, it moves the submodule pin in a commit of its own, regenerates, and runs its round-trip test over the submodule's `model/fixtures/`.

A generator in another language reads core's card fields the same way the TypeScript does: by reference, from `@pbcp/core`'s schema in the pinned `vendor/pbcp` (for example `z.toJSONSchema(ProducerCardSchema)` run at generation time). It never copies them into its own model.

## What Clay provided, and what is this repo's

Clay's own commands set up its parts:
- `clay init --yes` wrote `.clay` (the ledger of generated files), the managed block in `.gitattributes`, and the `.clay` merge driver in the local `.git/config`. Each clone runs `pnpm exec clay config automerge true` once to get the driver.
- `clay init-claude` wrote `.claude/settings.json`.

Clay has no stale-file check and installs no git hooks. So `scripts/generate.ts` (`pnpm generate` and `--check`) and the test-script gate are this repo's.
