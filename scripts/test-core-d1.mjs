/** Required packed checks: one normal archive, with no positive export overlays. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const mode = process.argv[2];
assert.ok(mode === 'core' || mode === 'd1', 'Expected core or d1');
const root = mkdtempSync(join(tmpdir(), `turbine-${mode}-pack-`));
let child;
let interrupted;
const forward = (signal) => {
  interrupted = signal;
  if (child) { try { process.kill(-child.pid, signal); } catch {} }
};
const term = () => forward('SIGTERM');
const interrupt = () => forward('SIGINT');
process.on('SIGTERM', term);
process.on('SIGINT', interrupt);
async function run(binary, args, env, capture = false) {
  assert.ok(!interrupted, `Interrupted by ${interrupted}`);
  child = spawn(binary, args, { env, detached: true, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
  let output = '';
  if (capture) child.stdout.on('data', (chunk) => { output += chunk; });
  const [code, signal] = await once(child, 'close');
  assert.equal(code, 0, `${binary} failed (${code ?? signal})`);
  child = undefined;
  return output;
}
try {
  let archive = process.env.TURBINE_CORE_D1_TARBALL;
  if (!archive) {
    const output = await run('npm', ['pack', '--json', '--pack-destination', root], process.env, true);
    const start = output.search(/^\[\r?\n\s+\{/m);
    assert.notEqual(start, -1, 'npm pack must return archive metadata');
    archive = join(root, JSON.parse(output.slice(start))[0].filename);
  }
  const env = {
    ...process.env,
    TURBINE_CORE_D1_TARBALL: resolve(archive),
    TURBINE_DRIVER_NEUTRAL_PACKED: '1',
    DRIVER_NEUTRAL_MINIFLARE_MODULE: resolve('node_modules/miniflare/dist/src/index.js'),
  };
  const tests = mode === 'core'
    ? ['src/test/driver-neutral-packed.test.ts']
    : ['src/test/d1-binding.test.ts', ...['consumer', 'graph', 'runtime'].map((name) => `src/test/fixtures/d1/${name}.test.ts`), 'src/test/fixtures/d1/prerequisite.test.mjs'];
  await run(process.execPath, ['--import', './node_modules/tsx/dist/loader.mjs', '--test', ...tests], env);
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    forward('SIGTERM');
    await once(child, 'close');
  }
  process.off('SIGTERM', term);
  process.off('SIGINT', interrupt);
  rmSync(root, { recursive: true, force: true });
}
