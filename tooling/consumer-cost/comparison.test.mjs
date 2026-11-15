import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { comparisonSchema, comparisonWorkload, comparisonOracle } from './comparison-fixtures.mjs';
import { parseComparison, installedInventory } from './compare.mjs';

const args = ['--compare', '--tarball', '/candidate.tgz', '--sha256', 'a'.repeat(64), '--work-root', '/own/work',
  '--cache', '/own/cache', '--locks', '/own/locks', '--out', '/own/out'];

test('comparison refuses ambiguous input, credentials, nonlocal services and unlabeled network installs', () => {
  assert.deepEqual(parseComparison(args).sizes, [5]);
  for (const extra of [ ['--arms', '__proto__'], ['--sizes', '100,100'], ['--sizes', '1001'],
    ['--install-mode', 'registry-cold'], ['--allow-network'], ['--work-root', '/own/locks'], ['--pg-url', 'postgres://u:p@127.0.0.1/db'],
    ['--pg-url', 'postgres://u@example.com/db'], ['--compiler-heap-mb', '0'] ]) {
    assert.throws(() => parseComparison([...args, ...extra]), undefined, extra.join(' '));
  }
});

test('every supported scale has the full eight-column ring and selected/nested/dynamic contracts', () => {
  for (const arm of ['turbine', 'drizzle-stable', 'drizzle-rc', 'prisma']) for (const n of [100, 500, 1000]) {
    const schema = Object.values(comparisonSchema(arm, n)).join('');
    const source = comparisonWorkload(arm, n);
    assert.ok(schema.length > n * 100);
    assert.equal((source.match(/export async function query\d+\(/g) ?? []).length, n);
    assert.equal((source.match(/@ts-expect-error/g) ?? []).length, n * 4);
    for (let i = 0; i < n; i++) {
      assert.ok(source.includes(`query${i}(db: DB, minimum: number, enabled: boolean)`));
      assert.ok(schema.includes(arm === 'prisma' ? `model Records${i}` : `records_${i}`));
    }
    assert.ok(source.includes("row.children[number]['parent']"));
    assert.ok(source.includes('selected[0]!.label'));
  }
});

test('independent result oracle rejects omissions, unsafe numbers, temporal coercions and reordered rows', async () => {
  const work = await mkdtemp(join(tmpdir(), 'consumer-oracle-'));
  try {
    await writeFile(join(work, 'oracle.mjs'), comparisonOracle);
    const { verify, expected } = await import(pathToFileURL(join(work, 'oracle.mjs')));
    const actual = structuredClone(expected);
    for (const row of [...actual.full, ...actual.dynamic]) row.createdAt = new Date(row.createdAt);
    verify(actual, 'turbine');
    for (const mutate of [r => r.full.pop(), r => delete r.full[0].note, r => r.full.reverse(),
      r => r.full[0].children.pop(), r => r.full[0].amount = 123456789.0123456789,
      r => r.full[0].id = Number(r.full[0].id), r => r.full[0].createdAt = r.full[0].createdAt.toISOString(),
      r => r.dynamic = []]) {
      const broken = structuredClone(actual); mutate(broken); assert.throws(() => verify(broken, 'turbine'));
    }
  } finally { await rm(work, { recursive: true, force: true }); }
});

test('projection and foreign-key public scalar types are checked before lossless normalization', async () => {
  const work = await mkdtemp(join(tmpdir(), 'consumer-scalar-types-'));
  try {
    await writeFile(join(work, 'oracle.mjs'), comparisonOracle);
    const { verify, expectedFor } = await import(pathToFileURL(join(work, 'oracle.mjs')));
    // The native runner supplies the actual generated Prisma.Decimal API. This
    // distinct brand exercises that supplied API without installing a comparator.
    class Decimal {
      constructor(value) { this.value = value; }
      static isDecimal(value) { return value instanceof Decimal; }
      toFixed() { return this.value; }
      equals(value) { return this.value === value; }
    }
    for (const arm of ['turbine', 'drizzle-stable', 'drizzle-rc', 'prisma']) {
      for (const domain of ['safe', 'precision']) {
        const prepare = (value, key) => {
          if (key === 'createdAt') return new Date(value);
          if (['id', 'parentId'].includes(key) && arm !== 'turbine') return BigInt(value);
          if (key === 'amount' && arm === 'prisma') return new Decimal(value);
          if (Array.isArray(value)) return value.map(v => prepare(v));
          if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, prepare(v, k)]));
          return value;
        };
        const valid = () => prepare(structuredClone(expectedFor(arm, domain)));
        verify(valid(), arm, domain, Decimal);
        for (const mutate of [
          r => { r.selected[0].id = arm === 'turbine' ? BigInt(r.selected[0].id) : String(r.selected[0].id); },
          r => { r.selected[0].amount = arm === 'prisma' ? r.selected[0].amount.toFixed(10) : new Decimal(r.selected[0].amount); },
          r => { r.full[0].parentId = arm === 'turbine' ? BigInt(r.full[0].parentId) : String(r.full[0].parentId); },
        ]) {
          const wrong = valid(); mutate(wrong);
          assert.throws(() => verify(wrong, arm, domain, Decimal), undefined, `${arm}/${domain} public scalar type`);
        }
      }
    }
  } finally { await rm(work, { recursive: true, force: true }); }
});

test('Decimal normalization refuses any precision discarded by fixed-scale rendering', async () => {
  const work = await mkdtemp(join(tmpdir(), 'consumer-decimal-precision-'));
  try {
    await writeFile(join(work, 'oracle.mjs'), comparisonOracle);
    const { normalize } = await import(pathToFileURL(join(work, 'oracle.mjs')));
    class Decimal {
      constructor(exact, rendered = exact) { this.exact = exact; this.rendered = rendered; }
      static isDecimal(value) { return value instanceof Decimal; }
      toFixed() { return this.rendered; }
      equals(value) { return this.exact === value; }
    }
    assert.equal(normalize(new Decimal('123456789.0123456789'), Decimal), '123456789.0123456789');
    for (const exact of ['123456789.01234567891', '123456789.01234567889']) {
      assert.throws(() => normalize(new Decimal(exact, '123456789.0123456789'), Decimal), /precision/);
    }
  } finally { await rm(work, { recursive: true, force: true }); }
});

test('inventory includes actual runtime driver closure, distinguishes missing optionals and hashes payload changes', async () => {
  const work = await mkdtemp(join(tmpdir(), 'consumer-inventory-'));
  try {
    for (const [name, dependencies] of [['turbine-orm', { pg: '^8' }], ['pg', {}], ['pg-pool', {}]]) {
      await mkdir(join(work, 'node_modules', name), { recursive: true });
      await writeFile(join(work, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: '1.0.0', dependencies }));
    }
    const lock = { packages: { '': {}, ...Object.fromEntries(['turbine-orm', 'pg', 'pg-pool', 'missing-optional'].map(n => [`node_modules/${n}`, { integrity: 'sha512-pin', devOptional: n === 'pg-pool', optional: n === 'pg-pool', peer: n === 'pg-pool' }])) } };
    const first = await installedInventory(work, lock);
    assert.equal(first.packages.length, 3);
    assert.equal(first.mandatoryPg.declared, true);
    assert.deepEqual(Object.fromEntries(['devOptional', 'optional', 'peer'].map(k => [k, first.packages.find(p => p.name === 'pg-pool')[k]])), { devOptional: true, optional: true, peer: true });
    assert.deepEqual(first.mandatoryPg.installed, [{ path: 'node_modules/pg', version: '1.0.0' }]);
    await writeFile(join(work, 'node_modules/pg-pool', 'changed.js'), 'changed runtime payload');
    const second = await installedInventory(work, lock);
    assert.notEqual(first.installedPayloadSha256, second.installedPayloadSha256);
    assert.ok(second.bytes > first.bytes);
    await mkdir(join(work, 'node_modules', 'unlocked'));
    await writeFile(join(work, 'node_modules/unlocked/package.json'), JSON.stringify({ name: 'unlocked', version: '1' }));
    await assert.rejects(installedInventory(work, lock), /absent from role lock/);
  } finally { await rm(work, { recursive: true, force: true }); }
});
