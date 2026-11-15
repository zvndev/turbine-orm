import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

let current;

export { current as default };

// The producer imports CJS pg, which Node exposes in require.cache. Inspect the
// already loaded export; never resolve/import a pg from the bundle's location.
export function installDriver(pool, runtime, driver) {
  assert.equal(runtime, process.version, 'Runtime argument must equal actual process runtime');
  assert.equal(runtime, 'v26.12.0', 'Candidate requires Node26.12.0');
  assert.equal(driver, 'pg@8.22.0', 'Candidate requires pg@8.22.0');
  const matches = Object.values(createRequire(import.meta.url).cache).filter((entry) => {
    const api = entry?.exports;
    return (
      api &&
      api.Pool === pool?.constructor &&
      api.Client === pool?.Client &&
      api.types &&
      /[/\\]lib[/\\]index.js$/.test(entry.filename)
    );
  });
  assert.equal(matches.length, 1, 'Supplied pool must be an actual loaded native pg.Pool');
  const loaded = matches[0];
  const manifest = JSON.parse(
    readFileSync(join(dirname(dirname(realpathSync(loaded.filename))), 'package.json'), 'utf8'),
  );
  assert.equal(manifest.name, 'pg');
  assert.equal(manifest.version, '8.22.0', 'Actual supplied pool driver version mismatch');
  assert.equal(Object.getPrototypeOf(pool), loaded.exports.Pool.prototype, 'Wrapped/subclass pool refused');
  assert.ok(!pool.ending && !pool.ended, 'Supplied pool is closed');
  assert.equal(typeof pool.query, 'function');
  assert.equal(typeof pool.connect, 'function');
  if (current) assert.equal(current, loaded.exports, 'One bundle cannot mix pg module instances');
  current = loaded.exports;
}
