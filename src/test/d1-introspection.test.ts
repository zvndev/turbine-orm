import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { type D1IntrospectOptions, introspectD1 } from '../d1/introspect.js';
import type { D1DatabaseBinding } from '../d1/types.js';
import { turbineD1 } from '../d1.js';
import { assertConstraintNameRelations, CONSTRAINT_NAME_DDL } from './fixtures/constraint-name-shapes.js';
import { executeDdl, withNative } from './fixtures/d1-introspection/native.js';

const ddl = readFileSync(new URL('./fixtures/d1-introspection/catalog.sql', import.meta.url), 'utf8');
async function catalog(check: (binding: D1DatabaseBinding) => Promise<void>) {
  await withNative(async (binding) => {
    await executeDdl(binding, ddl);
    await check(binding);
  });
}
const prototypeName = '__proto__';
const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

test('native D1 metadata matches independent catalog reads including generated, key and default facts', async (t) => {
  await catalog(async (binding) => {
    t.diagnostic(`Node ${process.version}; actual Miniflare/workerd D1 binding; sqlite_version is not authorized.`);
    const schema = await introspectD1(binding, { logger: {} });
    const flags = (await binding.prepare('PRAGMA main.table_list').all<{ name: string; wr: number; strict: number }>())
      .results;
    for (const table of Object.values(schema.tables)) {
      const cols = (
        await binding
          .prepare(`PRAGMA main.table_xinfo(${q(table.name)})`)
          .all<{ name: string; type: string; pk: number; notnull: number; hidden: number; dflt_value: string | null }>()
      ).results;
      const indexes = (
        await binding
          .prepare(`PRAGMA main.index_list(${q(table.name)})`)
          .all<{ name: string; unique: number; partial: number; origin: string }>()
      ).results;
      const tableFlags = flags.find((row) => row.name === table.name)!;
      const primary = cols.filter((column) => column.pk > 0);
      const rowid =
        tableFlags.wr === 0 &&
        primary.length === 1 &&
        !indexes.some((index) => index.origin === 'pk') &&
        primary[0]!.type.toUpperCase() === 'INTEGER'
          ? primary[0]!.name
          : undefined;
      assert.deepEqual(
        table.allColumns,
        cols.filter((column) => column.hidden !== 1).map((column) => column.name),
      );
      assert.deepEqual(
        table.primaryKey,
        primary.sort((a, b) => a.pk - b.pk).map((column) => column.name),
      );
      for (const column of table.columns) {
        const raw = cols.find((row) => row.name === column.name)!;
        assert.equal(column.defaultValue, raw.dflt_value);
        assert.equal(column.dialectType, raw.type);
        assert.equal(column.hasDefault, raw.dflt_value !== null || column.name === rowid || raw.hidden >= 2);
        assert.equal(
          column.nullable,
          raw.notnull === 0 &&
            column.name !== rowid &&
            !(raw.pk > 0 && (tableFlags.wr === 1 || tableFlags.strict === 1)),
        );
        assert.equal(!!column.isGeneratedStored, raw.hidden === 2 || raw.hidden === 3);
      }
      assert.equal(table.indexes.length, indexes.length);
      for (const index of table.indexes) {
        const native = indexes.find((row) => row.name === index.name)!;
        assert.equal(index.unique, native.unique === 1);
        assert.equal(!!index.partial, native.partial === 1);
        const keys = (
          await binding
            .prepare(`PRAGMA main.index_info(${q(index.name)})`)
            .all<{ seqno: number; cid: number; name: string | null }>()
        ).results.sort((a, b) => a.seqno - b.seqno);
        assert.deepEqual(
          index.columns,
          keys.every((key) => key.cid >= 0 && key.name !== null) ? keys.map((key) => key.name) : [],
        );
      }
    }
    assert.equal(Object.getPrototypeOf(schema.tables), null);
    assert.equal(Object.getPrototypeOf(schema.tables[prototypeName]!.columnMap), null);
    assert.ok(schema.tables[prototypeName]);
    assert.ok(schema.tables["quote'表"]);
    assert.ok(schema.tables.sqliteXuser);
    for (const name of ['_cf_METADATA', 'sqlite_sequence', 'key_view', '_turbine_migrations'])
      assert.equal(schema.tables[name], undefined);
    assert.equal(
      schema.tables.number_records!.columns.find((column) => column.name === 'large_value')!.tsType,
      'number',
    );
    assert.equal(
      schema.tables.audit_events!.columns.find((column) => column.name === 'amount')!.tsType,
      'number | string | null',
    );
  });
});

test('native D1 conservatively refines reverse cardinality and keeps composite relation ordering', async () => {
  await catalog(async (binding) => {
    const schema = await introspectD1(binding, { logger: {} });
    const relations = schema.tables.parents!.relations;
    // A to-one is named with the singular, as the PostgreSQL introspector names it.
    for (const name of ['profile', 'primaryProfile', 'indexedProfile', 'caseLink', 'mixedCaseChildren'])
      assert.equal(relations[name]?.type, 'hasOne', name);
    for (const name of ['partialProfiles', 'expressionProfiles', 'supersetProfiles', 'affinityProfiles'])
      assert.equal(relations[name]?.type, 'hasMany', name);
    assert.equal(schema.tables.numeric_parents!.relations.anyProfiles?.type, 'hasMany');
    for (const name of ['collationProfiles', 'binaryChildren'])
      assert.equal(schema.tables.collated_parents!.relations[name]?.type, 'hasMany');
    assert.equal(schema.tables.composite_parents!.relations.compositeLink?.type, 'hasOne');
    assert.deepEqual(schema.tables.composite_links!.relations.compositeParent?.foreignKey, ['tenant_id', 'code']);
    assert.deepEqual(schema.tables.composite_links!.relations.compositeParent?.referenceKey, ['tenant_id', 'code']);
    assert.equal(schema.tables.parents!.relations.tags?.type, 'manyToMany');
    await executeDdl(
      binding,
      "INSERT INTO parents VALUES (1); INSERT INTO affinity_profiles(parent_id) VALUES ('1'), ('01'); INSERT INTO partial_profiles(parent_id, active) VALUES (1, 0), (1, 0)",
    );
    const db = turbineD1(binding, schema, { logger: {}, warnOnUnlimited: false });
    try {
      const parent = await db.table('parents').findFirst({ with: { affinityProfiles: true, partialProfiles: true } });
      assert.equal((parent!.affinityProfiles as unknown[]).length, 2);
      assert.equal((parent!.partialProfiles as unknown[]).length, 2);
    } finally {
      await db.disconnect();
    }
    const legacy = await introspectD1(binding, { logger: {}, legacyToManyUniques: true });
    assert.equal(legacy.tables.parents!.relations.profiles?.type, 'hasMany');
    assert.equal(legacy.tables.composite_parents!.relations.compositeLinks?.type, 'hasMany');
  });
});

test('native D1 names composite foreign keys as PostgreSQL names the same declarations', async () => {
  await withNative(async (binding) => {
    await executeDdl(binding, CONSTRAINT_NAME_DDL.join(';'));
    assertConstraintNameRelations(await introspectD1(binding, { logger: {} }), 'D1');
  });
});

test('native filters, relation renames, quoted and prototype names preserve runtime data', async () => {
  await catalog(async (binding) => {
    const filtered = await introspectD1(binding, {
      include: ['parents', 'profiles', 'prototype_rows', '_turbine_migrations'],
      exclude: ['_turbine_migrations'],
      keepColumnNames: true,
      relationNames: { parents: { profile: 'ownProfile' } },
      logger: {},
    });
    assert.deepEqual(Object.keys(filtered.tables), ['parents', 'profiles', 'prototype_rows']);
    assert.equal(filtered.tables.parents!.relations.ownProfile?.type, 'hasOne');
    const db = turbineD1(binding, filtered, { logger: {}, warnOnUnlimited: false });
    try {
      const created = await db.table('prototype_rows').create({
        data: { [prototypeName]: 'safe', constructor: 'ctor', toString: 'string' },
        select: { id: true },
      });
      assert.equal(typeof (created as Record<string, unknown>).id, 'number');
      const row = (
        await binding
          .prepare('SELECT "__proto__" AS value, constructor AS ctor FROM prototype_rows')
          .all<{ value: string; ctor: string }>()
      ).results[0]!;
      assert.equal(row.value, 'safe');
      assert.equal(row.ctor, 'ctor');
      // Full prototype-key decoding is proved inside workerd by consumers.test.ts.
    } finally {
      await db.disconnect();
    }
    assert.ok((await introspectD1(binding, { include: ['_turbine_migrations'] })).tables._turbine_migrations);
    const quoted = await introspectD1(binding, { include: ["quote'表"], logger: {} });
    const quoteDb = turbineD1(binding, quoted, { logger: {} });
    try {
      const row = await quoteDb.table("quote'表").create({ data: { 'key"part': 'k' } });
      assert.equal(row.café, "c'est");
    } finally {
      await quoteDb.disconnect();
    }
  });
});

test('native computed writes refuse; actual D1 values and defaults match metadata', async () => {
  await catalog(async (binding) => {
    const schema = await introspectD1(binding, {
      include: ['generated_records', 'number_records', 'default_keys', 'without_keys', 'desc_keys'],
      logger: {},
    });
    const db = turbineD1(binding, schema, { logger: {}, warnOnUnlimited: false });
    try {
      const row = await db.table('generated_records').create({ data: { quantity: 4 } });
      assert.equal(row.virtualTotal, 8);
      assert.equal(row.storedTotal, 12);
      await assert.rejects(
        async () => db.table('generated_records').create({ data: { quantity: 4, virtualTotal: 100 } }),
        /generated/i,
      );
      await assert.rejects(
        async () => db.table('generated_records').updateMany({ where: {}, data: { storedTotal: 100 } }),
        /generated/i,
      );
      await assert.rejects(
        binding.prepare('UPDATE generated_records SET virtual_total = 100').all(),
        /generated column/i,
      );
      const defaults = await db.table('default_keys').create({ data: {} });
      assert.equal(defaults.slug, 'new');
      assert.equal(defaults.count, 0);
      assert.equal(defaults.optionalText, null);
      const numeric = await db.table('number_records').create({
        data: { largeValue: 9007199254740991, detail: { ok: true }, stampedAt: new Date('2026-01-02T00:00:00Z') },
      });
      assert.equal(numeric.largeValue, Number.MAX_SAFE_INTEGER);
      assert.equal(typeof numeric.largeValue, 'number');
      assert.equal(numeric.enabled, true);
      assert.deepEqual(numeric.detail, { ok: true });
      assert.ok(numeric.stampedAt instanceof Date);
      assert.equal(schema.tables.without_keys!.columns[0]!.hasDefault, false);
      assert.equal(schema.tables.desc_keys!.columns[0]!.nullable, true);
    } finally {
      await db.disconnect();
    }
    assert.equal(
      (await binding.prepare('SELECT count(*) AS count FROM generated_records').all<{ count: number }>()).results[0]!
        .count,
      1,
    );
  });
});

function forwarding(binding: D1DatabaseBinding, beforeBatch?: () => Promise<void>) {
  const calls: string[] = [];
  let preparedBatch = false;
  const traced: D1DatabaseBinding = {
    prepare(sql) {
      calls.push(sql);
      return binding.prepare(sql);
    },
    async batch(statements) {
      if (!preparedBatch) {
        preparedBatch = true;
        await beforeBatch?.();
      }
      return await binding.batch(statements);
    },
  };
  return { traced, calls };
}

test('unsupported and malformed options refuse before native prepare; failures leave caller binding usable', async () => {
  await catalog(async (binding) => {
    const { traced, calls } = forwarding(binding);
    for (const options of [
      { schema: 'temp' },
      { includeViews: true },
      { dialect: {} },
      { session: true },
      { keepColumnNames: 1 },
      { include: 'parents' },
      { relationNames: { parents: { profiles: 1 } } },
      null,
      { [Symbol('unknown')]: true },
    ]) {
      await assert.rejects(introspectD1(traced, options as D1IntrospectOptions));
      assert.equal(calls.length, 0);
    }
    await assert.rejects(introspectD1(binding, { include: ['key_view'] }), /View introspection/i);
    await assert.rejects(
      introspectD1(binding, { include: ['parents'], relationNames: { parents: { missing: 'x' } } }),
      /no relation/,
    );
    await assert.rejects(
      introspectD1(binding, { include: ['parents', 'profiles'], relationNames: { profiles: { parent: 'parentId' } } }),
      /column/,
    );
    await assert.rejects(
      introspectD1(binding, {
        include: ['parents', 'profiles'],
        relationNames: { parents: { profile: 'bad\nname' } },
      }),
      /control character/,
    );
    await executeDdl(binding, 'CREATE TABLE collision (created_at TEXT, "createdAt" TEXT)');
    await assert.rejects(introspectD1(binding, { include: ['collision'] }), /Field collision/);
    assert.equal(
      (await introspectD1(binding, { include: ['collision'], keepColumnNames: true })).tables.collision!.columns.length,
      2,
    );
    await binding.prepare('CREATE TABLE "bad\nname" (id INTEGER)').all();
    await assert.rejects(introspectD1(binding, { include: ['bad\nname'] }), /control character/);
    assert.equal((await binding.prepare('SELECT 42 AS answer').all<{ answer: number }>()).results[0]!.answer, 42);
  });
});

test('native schema drift between discovery and atomic collection refuses without changing caller ownership', async () => {
  await withNative(async (binding) => {
    await binding.prepare('CREATE TABLE drift (id INTEGER PRIMARY KEY)').all();
    const { traced, calls } = forwarding(binding, async () => {
      await binding.prepare('ALTER TABLE drift ADD COLUMN added TEXT').all();
    });
    await assert.rejects(introspectD1(traced), /catalog changed/);
    assert.ok(calls.every((sql) => /^(SELECT|PRAGMA)/.test(sql)));
    assert.ok(calls.every((sql) => !/schema_version|BEGIN|COMMIT|ROLLBACK|SESSION/i.test(sql)));
    assert.equal((await introspectD1(binding)).tables.drift!.columns.length, 2);
    // Real native statement error is propagated by identity, never swallowed.
    let nativeError: unknown;
    const failing = forwarding(binding, async () => {
      try {
        await binding.prepare('SELECT missing FROM missing').all();
      } catch (error) {
        nativeError = error;
        throw error;
      }
    });
    await assert.rejects(introspectD1(failing.traced), (error) => error === nativeError);
    assert.equal((await binding.prepare('SELECT 1 AS alive').all()).results.length, 1);
  });
});

test('real native batch is sequential and atomic; interactive SQL transactions are rejected', async () => {
  await withNative(async (binding) => {
    await binding.prepare('CREATE TABLE atomic_probe (id INTEGER PRIMARY KEY)').all();
    const results = await binding.batch([
      binding.prepare('INSERT INTO atomic_probe VALUES (1)'),
      binding.prepare('SELECT count(*) AS count FROM atomic_probe'),
    ]);
    assert.deepEqual(results[1]!.results, [{ count: 1 }]);
    await assert.rejects(
      binding.batch([
        binding.prepare('INSERT INTO atomic_probe VALUES (2)'),
        binding.prepare('INSERT INTO atomic_probe VALUES (1)'),
      ]),
      /UNIQUE/,
    );
    assert.deepEqual((await binding.prepare('SELECT id FROM atomic_probe').all()).results, [{ id: 1 }]);
    await assert.rejects(binding.prepare('BEGIN').all(), /transaction|SQLITE_AUTH/i);
  });
});
