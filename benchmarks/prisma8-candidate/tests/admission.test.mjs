import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertExact, assertIncrementEffect, canonical } from '../dist/canonical/equivalence.js';
import { verifyWrite } from '../dist/canonical/extended-equivalence.js';
import { assertRoute, catalog, comparatorNames } from '../scripts/catalog.mjs';
import { drain, observe } from '../scripts/native.mjs';
import { here, json, sha256, verifyPins, verifyRuntime } from '../scripts/verify-pins.mjs';

test('immutable canonical corpus, public contract and installed package identities pass', () => {
  const result = verifyPins();
  assert.equal(result.runtime.version, 'v26.12.0');
  assert.equal(result.pins.packages['@prisma/orm-postgres'].version, '8.0.0-rc.23');
  assert.equal(result.pins.packages.prisma.version, '8.0.0-rc.33');
});
test('ineligible or changed runtime fails with an identity-specific error', () => {
  const pin = json(join(here, 'identity.json')).runtime;
  assert.throws(() => verifyRuntime(pin, { ...pin, version: 'v24.10.0' }), /runtime version mismatch/);
  assert.throws(() => verifyRuntime(pin, { ...pin, sha256: 'a'.repeat(64) }), /runtime sha256 mismatch/);
});
test('canonical bytes are checked, and corruption is observable', () => {
  const manifest = json(join(here, 'canonical/manifest.json'));
  const bytes = readFileSync(join(here, 'canonical/equivalence.ts'));
  assert.equal(sha256(bytes), manifest['equivalence.ts'].sha256);
  assert.notEqual(sha256(Buffer.concat([bytes, Buffer.from('corrupt')])), manifest['equivalence.ts'].sha256);
});
test('complete explicit catalog retains refusals and unavailable metrics', () => {
  const rows = catalog();
  assert.equal(rows.length, 30);
  assert.equal(new Set(rows.map((r) => r.id)).size, 30);
  assert.equal(rows.filter((r) => r.group === 'headline').length, 11);
  for (const row of rows)
    for (const [name, cell] of Object.entries(row.arms)) {
      assert.ok(['implemented', 'refused', 'optional-input-required'].includes(cell.status), `${row.id}/${name}`);
      assert.equal(cell.metrics, null);
      if (cell.status === 'refused') assert.ok(cell.reason.length > 10);
    }
  for (const id of ['headline-7', 'headline-8', 'strategy-one', 'strategy-many', 'cold-user']) {
    assert.equal(rows.find((r) => r.id === id).arms['Prisma 8 buffered'].status, 'refused');
  }
  for (const name of comparatorNames) assert.ok(rows.every((r) => r.arms[name].status === 'optional-input-required'));
  assert.ok(rows.find((r) => r.id === 'dashboard-independent'));
  assert.ok(rows.find((r) => r.id === 'dashboard-sequential'));
});
test('native portal proof refuses buffering, wrong batch size and absent portal', () => {
  const valid = [
    { kind: 'bind', portal: 'C_1' },
    { kind: 'execute', rows: 1000 },
  ];
  assert.doesNotThrow(() => assertRoute(valid, true));
  assert.throws(() => assertRoute([], true), /named portal and Execute rows=1000/);
  assert.throws(
    () =>
      assertRoute(
        [
          { kind: 'bind', portal: 'C_1' },
          { kind: 'execute', rows: 100 },
        ],
        true,
      ),
    /rows=1000/,
  );
  assert.throws(() => assertRoute([{ kind: 'execute', rows: 1000 }], true), /named portal/);
  assert.throws(() => assertRoute(valid, false), /Buffered route/);
});
test('wire observation is fully removable before timing warmup', () => {
  const pool = new EventEmitter();
  const original = () => {};
  const connection = Object.fromEntries(['bind', 'execute', 'parse', 'query', 'close'].map((name) => [name, original]));
  const trace = observe(pool);
  pool.emit('connect', { connection });
  connection.execute({ rows: 1000 });
  assert.equal(trace.length, 1);
  trace.detach();
  for (const name of Object.keys(connection)) assert.equal(connection[name], original);
  assert.equal(pool.listenerCount('connect'), 0);
  connection.execute({ rows: 1000 });
  assert.equal(trace.length, 1);
});
test('ordered oracle catches omitted field/row, changed value and unsafe integer', () => {
  const expected = [
    { id: '9007199254740993', email: 'safe', nullable: null },
    { id: '2', email: 'second', nullable: null },
  ];
  assertExact('valid exact integers', [{ ...expected[0], id: 9007199254740993n }, expected[1]], expected);
  assert.throws(() => assertExact('omission', expected.slice(1), expected), /omission: exact result mismatch/);
  assert.throws(() => assertExact('corruption', [{ ...expected[0], email: 'wrong' }, expected[1]], expected), /email/);
  assert.throws(() => assertExact('missing field', [{ id: expected[0].id }, expected[1]], expected), /keys\/length/);
  assert.throws(() => assertExact('order', [...expected].reverse(), expected), /mismatch/);
  assert.throws(() => canonical({ id: Number(expected[0].id) }), /Unsafe integer/);
});
test('full-drain guard rejects a convincing first row followed by truncation', async () => {
  const expected = [
    { id: 1n, body: 'first' },
    { id: 2n, body: 'second' },
  ];
  async function* truncated() {
    yield expected[0];
  }
  await assert.rejects(() => drain(truncated(), expected, 'omitted-tail'), /full drain omitted rows/);
  await assert.rejects(() => drain([expected[1], expected[0]], expected, 'reordered'), /ordered row 0/);
  assert.equal((await drain(expected, expected, 'complete')).count, 2);
});
test('returning a correct-looking row cannot conceal an omitted write effect', async () => {
  const before = [
    { id: '1', slug: 'update-target', amount: -777 },
    { id: '2', slug: 'sentinel-a', amount: -777 },
    { id: '3', slug: 'sentinel-b', amount: -777 },
  ];
  const unchangedOracle = { query: async () => ({ rows: before }) };
  await assert.rejects(
    () => verifyWrite(unchangedOracle, 'update', 'no-op', before, 8, { ...before[0], amount: 8 }),
    /actual write effect.*amount/,
  );
  assert.throws(
    () => assertIncrementEffect('no-op increment', [{ id: 1, view_count: 4 }], [{ id: 1, view_count: 4 }]),
    /write effect/,
  );
  assert.throws(
    () =>
      assertIncrementEffect(
        'wrong row',
        [
          { id: 1, view_count: 4 },
          { id: 2, view_count: 4 },
        ],
        [
          { id: 1, view_count: 4 },
          { id: 2, view_count: 5 },
        ],
      ),
    /write effect/,
  );
});
