import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { command } from '../../../tooling/lifecycle-examples/harness.mjs';

const here = fileURLToPath(new URL('../', import.meta.url));
const check = process.argv.includes('--check');
// The emitter resolves public facade import roots from the output's project ancestry.
const output = check ? mkdtempSync(join(here, 'fixture/.emit-check-')) : join(here, 'fixture');
const report = { steps: [] };
try {
  command(
    report,
    here,
    here,
    process.execPath,
    [
      join(here, 'node_modules/prisma/dist/prisma.js'),
      'contract',
      'emit',
      '--config',
      join(here, 'prisma.config.ts'),
      '--output-path',
      output,
    ],
    { ...process.env, DO_NOT_TRACK: '1', PRISMA_DISABLE_TELEMETRY: '1' },
  );
  if (check)
    for (const file of ['contract.json', 'contract.d.ts']) {
      assert.ok(
        readFileSync(join(output, file), 'utf8') === readFileSync(join(here, 'fixture', file), 'utf8'),
        `Generated drift: ${file}`,
      );
    }
  console.log(check ? 'Contract regeneration is byte-identical' : 'Contract emitted');
} finally {
  if (check) rmSync(output, { recursive: true, force: true });
}
