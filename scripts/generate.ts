// pnpm generate — the shapes from the model (model/README.md): Clay runs model/model.json's generators (ts-api, ts-store,
// swift-models, swift-store, swift-client), then the OpenAPI document is built from the generated schemas
// (packages/api-types/openapi.json) and the owner MCP's types from that (packages/owner-mcp/src/api.d.ts). The Swift
// client is generated from that document, so when it changed, Clay runs once more.
//
// pnpm generate --check — leaves the repo as it was. Clay generates into a scratch directory (from the repo root, which
// holds .clay; the ledger and .gitattributes are put back afterwards) and every file it owns is compared with the one in
// the repo; so are openapi.json and api.d.ts. Exits 1 naming each stale file, so a model change that was not
// regenerated, or a generated file edited by hand, fails `pnpm test`.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { openApiText } from '../lib/api/generate';

const ROOT = resolve(import.meta.dirname, '..');
const MODEL = 'model/model.json';
const CLAY = join(ROOT, 'node_modules/.bin/clay');
const OPENAPI = join(ROOT, 'packages/api-types/openapi.json');
const API_D_TS = join(ROOT, 'packages/owner-mcp/src/api.d.ts');
const OPENAPI_TS = join(ROOT, 'packages/owner-mcp/node_modules/.bin/openapi-typescript');

const run = (cmd: string, args: string[], cwd = ROOT) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString();
const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : null);

/** Clay, from the repo root, into `output`. `--force`: Clay's input hash does not see the modules the templates import. */
function clay(output: string): void {
  run(CLAY, ['generate', MODEL, output, '--force']);
}

if (!process.argv.includes('--check')) {
  clay('.');
  const before = read(OPENAPI);
  writeFileSync(OPENAPI, openApiText());
  if (read(OPENAPI) !== before) clay('.');
  run(OPENAPI_TS, ['../api-types/openapi.json', '-o', 'src/api.d.ts'], join(ROOT, 'packages/owner-mcp'));
  console.log('generated: the model’s files, packages/api-types/openapi.json, packages/owner-mcp/src/api.d.ts');
} else {
  const scratch = mkdtempSync(join(tmpdir(), 'pbcp-generate-'));
  const ledger = join(ROOT, '.clay');
  const attributes = join(ROOT, '.gitattributes');
  const kept = { ledger: read(ledger), attributes: read(attributes) };
  const stale: string[] = [];
  try {
    clay(scratch);
    const entries = JSON.parse(readFileSync(ledger, 'utf8')) as { models: Array<{ output: string; generated_files: Record<string, unknown> }> };
    const mine = entries.models.find((m) => resolve(ROOT, m.output) === resolve(scratch));
    for (const file of Object.keys(mine?.generated_files ?? {})) {
      const rel = relative(scratch, resolve(ROOT, file)); // the ledger keeps paths from the repo root
      if (read(join(ROOT, rel)) !== read(join(scratch, rel))) stale.push(rel);
    }
    const openapi = openApiText();
    if (read(OPENAPI) !== openapi) stale.push('packages/api-types/openapi.json');
    writeFileSync(join(scratch, 'openapi.json'), openapi);
    run(OPENAPI_TS, [join(scratch, 'openapi.json'), '-o', join(scratch, 'api.d.ts')], join(ROOT, 'packages/owner-mcp'));
    if (read(API_D_TS) !== read(join(scratch, 'api.d.ts'))) stale.push('packages/owner-mcp/src/api.d.ts');
  } finally {
    if (kept.ledger !== null) writeFileSync(ledger, kept.ledger);
    if (kept.attributes !== null) writeFileSync(attributes, kept.attributes);
    rmSync(scratch, { recursive: true, force: true });
  }
  if (stale.length > 0) {
    console.error(`stale generated files (run \`pnpm generate\`):\n${stale.map((f) => `  ${f}`).join('\n')}`);
    process.exit(1);
  }
  console.log('generated files match the model');
}
