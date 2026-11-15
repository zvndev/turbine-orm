import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { admittedCatalog, comparatorNames } from './catalog.mjs';
import { json, sha256 } from './verify-pins.mjs';

const versions = { 'Drizzle stable': '0.45.4', 'Drizzle RC': '1.0.0-rc.5', 'Prisma 7': '7.10.1' };

// Optional adapters are supplied as reviewed immutable bundles, never imported from sibling installs.
export async function comparators(path, url, rows, report, scope) {
  if (!path) return [];
  const input = json(resolve(path));
  assert.equal(input.format, 1, 'Comparator manifest format=1 required');
  assert.ok(Array.isArray(input.arms) && input.arms.length, 'Nonempty comparator arms required');
  admittedCatalog(input.arms);
  const seen = new Set(),
    arms = [];
  report.comparatorInputs = [];
  for (const pin of input.arms) {
    assert.ok(
      comparatorNames.includes(pin.name) && !seen.has(pin.name),
      `Unknown or duplicate optional arm: ${pin.name}`,
    );
    seen.add(pin.name);
    if (versions[pin.name]) assert.equal(pin.version, versions[pin.name], `Wrong comparator version: ${pin.name}`);
    assert.equal(
      pin.driver,
      'pg@8.22.0',
      'Matched candidate comparison requires pg@8.22.0; preserve pg8.23.1 baseline separately',
    );
    assert.equal(pin.implementationKind, 'typed-orm', 'Raw SQL is not an admitted typed ORM comparator');
    assert.match(pin.sourceCommit, /^[a-f0-9]{40}$/, 'Comparator source commit required');
    for (const key of ['artifact', 'module']) {
      assert.match(pin[key]?.sha256 ?? '', /^[a-f0-9]{64}$/, `Comparator ${key} SHA256 required`);
      assert.equal(sha256(readFileSync(resolve(pin[key].path))), pin[key].sha256, `Comparator ${key} changed`);
    }
    assert.ok(
      Array.isArray(pin.supported) && pin.supported.length && new Set(pin.supported).size === pin.supported.length,
      'Explicit nonempty unique scenario support required',
    );
    for (const id of pin.supported)
      assert.ok(
        rows.some((row) => row.id === id && row.arms['Prisma 8 buffered'].status === 'implemented'),
        `Optional comparator scenario not admitted: ${id}`,
      );
    const { createArm } = await import(pathToFileURL(resolve(pin.module.path)).href);
    assert.equal(typeof createArm, 'function', 'Comparator bundle must export createArm');
    const pool = new pg.Pool({ connectionString: url, max: 3, connectionTimeoutMillis: 2000 });
    scope.registerStop(() => pool.end());
    const adapter = await createArm({ pool, runtime: process.version, driver: 'pg@8.22.0' });
    assert.equal(adapter.pool, pool, 'Comparator must retain supplied matched driver pool');
    assert.equal(typeof adapter.close, 'function', 'Comparator close required');
    scope.registerStop(() => adapter.close());
    for (const method of ['runHeadline', 'runExtended', 'dashboard', 'stream'])
      assert.equal(typeof adapter[method], 'function', `Missing optional ${method}`);
    for (const row of rows)
      row.arms[pin.name] = pin.supported.includes(row.id)
        ? { status: 'implemented', route: 'external-typed-orm', metrics: null }
        : { status: 'refused', reason: 'Not declared by supplied comparator manifest', metrics: null };
    report.comparatorInputs.push(pin);
    arms.push({ ...adapter, name: pin.name, route: 'buffered' });
  }
  return arms;
}
