// pnpm generate — the shapes from the model (model/README.md): Clay runs model/model.json's generators (ts-api, ts-store),
// then the OpenAPI document is built from the generated schemas (packages/api-types/openapi.json) and the owner MCP's
// types from that (packages/owner-mcp/src/api.d.ts).
//
// pnpm generate --check — writes nothing. Clay generates into a scratch directory and every file it owns is compared
// with the one in the repo; so are openapi.json and api.d.ts. Exits 1 naming each stale file, so a model change that was
// not regenerated, or a generated file edited by hand, fails `pnpm test`.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openApiText } from '../lib/api/generate';

const ROOT = resolve(import.meta.dirname, '..');
const MODEL = join(ROOT, 'model/model.json');
const CLAY = join(ROOT, 'node_modules/.bin/clay');
const OPENAPI = join(ROOT, 'packages/api-types/openapi.json');
const API_D_TS = join(ROOT, 'packages/owner-mcp/src/api.d.ts');
const OPENAPI_TS = join(ROOT, 'packages/owner-mcp/node_modules/.bin/openapi-typescript');

const run = (cmd: string, args: string[], cwd: string) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString();

/** Clay into `dir` (which holds a .clay ledger); the paths it generated, relative to `dir`. */
function clay(dir: string, model: string): string[] {
  run(CLAY, ['generate', model, '.'], dir);
  const ledger = JSON.parse(readFileSync(join(dir, '.clay'), 'utf8')) as { models: Array<{ path: string; generated_files: Record<string, unknown> }> };
  return ledger.models.flatMap((m) => Object.keys(m.generated_files));
}

if (!process.argv.includes('--check')) {
  clay(ROOT, 'model/model.json');
  writeFileSync(OPENAPI, openApiText());
  run(OPENAPI_TS, ['../api-types/openapi.json', '-o', 'src/api.d.ts'], join(ROOT, 'packages/owner-mcp'));
  console.log('generated: the model’s files, packages/api-types/openapi.json, packages/owner-mcp/src/api.d.ts');
} else {
  const scratch = mkdtempSync(join(tmpdir(), 'pbcp-generate-'));
  const stale: string[] = [];
  try {
    writeFileSync(join(scratch, '.clay'), JSON.stringify({ models: [] }));
    for (const file of clay(scratch, MODEL)) {
      const mine = join(ROOT, file);
      if (!existsSync(mine) || readFileSync(mine, 'utf8') !== readFileSync(join(scratch, file), 'utf8')) stale.push(file);
    }
    const openapi = openApiText();
    if (readFileSync(OPENAPI, 'utf8') !== openapi) stale.push('packages/api-types/openapi.json');
    writeFileSync(join(scratch, 'openapi.json'), openapi);
    run(OPENAPI_TS, [join(scratch, 'openapi.json'), '-o', join(scratch, 'api.d.ts')], join(ROOT, 'packages/owner-mcp'));
    if (readFileSync(API_D_TS, 'utf8') !== readFileSync(join(scratch, 'api.d.ts'), 'utf8')) stale.push('packages/owner-mcp/src/api.d.ts');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  if (stale.length > 0) {
    console.error(`stale generated files (run \`pnpm generate\`):\n${stale.map((f) => `  ${f}`).join('\n')}`);
    process.exit(1);
  }
  console.log('generated files match the model');
}
