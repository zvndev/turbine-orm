/** Fault injection wraps a real workerd runtime; the established command owner reaps it. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const [library, root, mode] = process.argv.slice(2);
const require = createRequire(join(library, 'package.json'));
const { Miniflare } = require('miniflare');
const local = require(join(library, 'dist/cjs/cli/d1-local.js'));
const { migrateD1 } = require('turbine-orm/d1/migrate');
mkdirSync(root, { recursive: true });
process.chdir(root);
const context = local.resolveD1Context({
  engine: 'd1',
  url: '',
  schema: 'main',
  out: './out',
  migrationsDir: './migrations',
  d1: { binding: 'DB', databaseId: `d1-local-project-${mode}`, persist: './state' },
});
mkdirSync(context.persist);
let actual;
let underlyingDisposed = false;
let late;
let lateObserved = false;
class FaultRuntime {
  constructor(options) {
    console.log(
      `D1 lifecycle fault service before launch: ${context.persist}; DB=${options.d1Databases.DB};127.0.0.1:0;inspector0;mode=${mode}`,
    );
    const launchedAt = Date.now();
    actual = new Miniflare(options);
    const initialReady = actual.ready;
    if (mode === 'interrupted') setTimeout(() => process.kill(process.pid, 'SIGTERM'), 200);
    this.ready =
      mode === 'stalled' || mode === 'late' || mode === 'interrupted'
        ? initialReady.then(
            () =>
              new Promise((resolve) => {
                if (mode === 'late')
                  late = setTimeout(
                    () => {
                      lateObserved = true;
                      resolve(new URL('http://127.0.0.1:1'));
                    },
                    Math.max(0, 30200 - (Date.now() - launchedAt)),
                  );
              }),
          )
        : initialReady;
  }
  getD1Database(name) {
    return actual.getD1Database(name);
  }
  dispose() {
    if (mode === 'dispose-fail') return Promise.reject(Error('injected disposal failure'));
    if (mode === 'dispose-stall') return new Promise(() => {});
    return actual.dispose().then(() => {
      underlyingDisposed = true;
    });
  }
}
const report = { mode, node: process.version, primaryPreserved: false, lockRetained: false, externalDisposal: false };
try {
  let caught = false;
  try {
    await local.withLocalD1(
      context,
      async (binding) => {
        if (mode === 'dispose-fail') {
          await migrateD1(
            {
              prepare: (sql) => binding.prepare(sql),
              batch: async (statements) => (await binding.batch(statements)).slice(1),
            },
            [{ id: '0001_items', statements: ['CREATE TABLE items(id INTEGER PRIMARY KEY)'] }],
          );
        }
        return 1;
      },
      FaultRuntime,
    );
  } catch (error) {
    caught = true;
    if (mode === 'dispose-fail') {
      assert.equal(error.outcome, 'unknown');
      report.primaryPreserved = true;
    } else assert.match(String(error), mode === 'dispose-stall' ? /cleanup failed/ : /startup exceeded/);
  }
  assert(caught);
  const unresolved = mode.startsWith('dispose-');
  assert.equal(local.d1CleanupResolved(context), !unresolved);
  report.lockRetained = existsSync(join(context.persist, '.turbine-d1.lock'));
  assert.equal(report.lockRetained, unresolved);
  if (unresolved) {
    const binding = await actual.getD1Database('DB');
    await binding.prepare('CREATE TABLE still_admitted(id INTEGER)').all();
    report.lateMutationPossible = true;
  }
  if (mode === 'late') {
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert(lateObserved);
    report.lateReadyAfterDisposal = true;
  }
} finally {
  clearTimeout(late);
  if (!underlyingDisposed) await actual?.dispose();
  report.externalDisposal = true;
  // Do not claim helper cleanup or remove its retained lock. Parent waits for owner reaping.
  writeFileSync(join(root, 'lifecycle.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report));
