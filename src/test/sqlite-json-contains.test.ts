/**
 * turbine-orm: SQLite refuses a JSON containment it cannot answer
 *
 * SQLite has no equivalent of PostgreSQL's `@>`, so Turbine emulated pathless
 * containment as `EXISTS (SELECT 1 FROM json_each(col) WHERE value = $1)`. The
 * bound param is JSON TEXT (`JSON.stringify(operand)`) and `json_each.value`
 * yields the DECODED SQL value, so the two sides are in different encodings and
 * the predicate never holds. Measured against a real in-process SQLite:
 *
 *   stored                  filter               postgres   sqlite
 *   ["gold"]                contains: 'gold'     match      none    ('gold' = '"gold"')
 *   [1]                     contains: 1          match      none    (INTEGER 1 = TEXT '1')
 *   {"a":1,"tier":"gold"}   contains: { a: 1 }   match      none    (no structural walk)
 *
 * So this is not a limitation that bites structural operands and spares scalar
 * ones, which is how it was reported and how the code comment described it: the
 * feature returned zero rows for EVERY operand and had never worked at all.
 * Fewer rows with no error is the exact degrade the dialect contract's "refuse,
 * do not degrade" rule exists to prevent, so `supportsJsonContains` is false on
 * this engine and the filter raises E017.
 *
 * Two things these tests are careful about:
 *   1. the pathless `equals` spelling compiles to the SAME expression, so it
 *      degraded identically and is refused under its own clause name;
 *   2. the check runs on the cache-HIT path as well as the build path. A
 *      JsonFilter fingerprints by which KEYS are present, so every `contains`
 *      on a column shares one cache entry, and a build-only gate would be
 *      skipped for that entry's whole warm life.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { describe, it } from 'node:test';
import { postgresDialect } from '../dialect.js';
import { UnsupportedFeatureError } from '../errors.js';
import { mysqlDialect } from '../mysql.js';
import type { SchemaMetadata } from '../schema.js';
import { introspectSqliteDatabase, sqliteDialect, turbineSqlite } from '../sqlite.js';
import { makeQuery, mockTable } from './helpers.js';

function schema(): SchemaMetadata {
  return {
    enums: {},
    tables: {
      docs: mockTable('docs', [
        { name: 'id', field: 'id' },
        { name: 'meta', field: 'meta', pgType: 'jsonb' },
      ]),
    },
  };
}

const engine = (dialect: typeof postgresDialect) => makeQuery('docs', schema(), { dialect });

/** `assert.throws` returns undefined, and these tests assert on the message. */
function caught(fn: () => unknown): UnsupportedFeatureError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof UnsupportedFeatureError, `expected E017, got ${err}`);
    return err;
  }
  throw new Error('expected the call to throw, it returned');
}

describe('sqlite: pathless JSON containment is refused', () => {
  it('an object operand throws E017 naming the feature', () => {
    const err = caught(() => engine(sqliteDialect).buildFindMany({ where: { meta: { contains: { a: 1 } } } } as never));
    assert.equal(err.code, 'TURBINE_E017');
    assert.match(err.message, /JSON containment \(`contains` without `path`\)/);
    assert.match(err.message, /sqlite/);
    // Actionable: name the alternative that IS exact on this engine.
    assert.match(err.message, /\{ path: \[\.\.\.\], equals: \.\.\. \}/);
  });

  it('an array operand throws too', () => {
    caught(() => engine(sqliteDialect).buildFindMany({ where: { meta: { contains: ['gold'] } } } as never));
  });

  it('a SCALAR operand throws as well, because it never worked either', () => {
    // The part the report had backwards. `contains: 'gold'` looked supported
    // and returned nothing, which is worse than an error, so it is refused with
    // everything else rather than left as a silent wrong answer.
    for (const operand of ['gold', 1, 1.5, true, null]) {
      caught(() => engine(sqliteDialect).buildFindMany({ where: { meta: { contains: operand } } } as never));
    }
  });

  it('the pathless `equals` spelling is refused under its OWN name', () => {
    // It compiles to the same expression, so it degraded the same way. The
    // message names `equals` rather than `contains` because the two spellings
    // are far enough apart that naming the wrong one would send the reader to
    // the wrong line.
    const err = caught(() => engine(sqliteDialect).buildFindMany({ where: { meta: { equals: { a: 1 } } } } as never));
    assert.match(err.message, /JSON containment \(`equals` without `path`\)/);
  });

  it('the refusal survives a warm SQL cache', () => {
    // The load-bearing one. A JsonFilter's fingerprint records which keys are
    // present, not what they hold, so a first call warms the template a second
    // would otherwise be served from, skipping any build-only gate.
    const q = engine(sqliteDialect);
    caught(() => q.buildFindMany({ where: { meta: { contains: 'gold' } } } as never));
    caught(() => q.buildFindMany({ where: { meta: { contains: { a: 1 } } } } as never));
  });

  it('a path-scoped `equals` is untouched: it compiles to json_extract, which is exact', () => {
    const built = engine(sqliteDialect).buildFindMany({ where: { meta: { path: ['a'], equals: 1 } } } as never);
    assert.match(built.sql, /json_extract/);
  });

  it('a path-scoped range filter is untouched too', () => {
    const built = engine(sqliteDialect).buildFindMany({ where: { meta: { path: ['a'], gt: 1 } } } as never);
    assert.match(built.sql, /json_extract/);
  });
});

describe('the other engines are untouched', () => {
  it('postgres accepts an object operand and emits @>', () => {
    const built = engine(postgresDialect).buildFindMany({ where: { meta: { contains: { a: 1 } } } } as never);
    assert.match(built.sql, /"meta" @> \$1::jsonb/);
    assert.deepEqual(built.params, ['{"a":1}']);
  });

  it('postgres accepts a scalar operand unchanged', () => {
    const built = engine(postgresDialect).buildFindMany({ where: { meta: { contains: 'gold' } } } as never);
    assert.match(built.sql, /"meta" @> \$1::jsonb/);
    assert.deepEqual(built.params, ['"gold"']);
  });

  it('mysql accepts both', () => {
    assert.doesNotThrow(() => engine(mysqlDialect).buildFindMany({ where: { meta: { contains: { a: 1 } } } } as never));
    assert.doesNotThrow(() => engine(mysqlDialect).buildFindMany({ where: { meta: { contains: 'gold' } } } as never));
  });

  it('the capability is declared true by default and false only where it is false', () => {
    // Every engine dialect is built by spreading postgresDialect, so the
    // default here IS inherited: the flag only means anything because sqlite
    // sets it explicitly. That is the same shape supportsVector uses.
    assert.equal(postgresDialect.supportsJsonContains, true);
    assert.equal(mysqlDialect.supportsJsonContains, true);
    assert.equal(sqliteDialect.supportsJsonContains, false);
  });
});

// ---------------------------------------------------------------------------
// The same claim against a real in-process SQLite database rather than the
// emitted SQL. This is what turned a documented limitation into a measured bug:
// every build-only assertion above would have passed just as happily on the
// degrading version, because the degrade was in the SEMANTICS of valid SQL.
// ---------------------------------------------------------------------------

const DatabaseSync: (new (path: string) => DatabaseSyncType) | undefined = (() => {
  try {
    return createRequire(process.cwd())('node:sqlite').DatabaseSync;
  } catch {
    return undefined;
  }
})();

const liveIt: typeof it = DatabaseSync
  ? it
  : (((name: string) =>
      it(name, { skip: 'turbine-orm/sqlite requires node:sqlite (Node >= 22.5)' }, () => {})) as typeof it);

describe('sqlite, live', () => {
  liveIt('the emulation it replaced really did match nothing', async () => {
    // Run the OLD predicate by hand against the engine, with the operand encoded
    // exactly as the JSON filter path encoded it. This is the measurement the
    // refusal rests on; if a future SQLite makes it work, this test fails and
    // the flag should be revisited rather than the test relaxed.
    const db = new (DatabaseSync as NonNullable<typeof DatabaseSync>)(':memory:');
    db.exec('CREATE TABLE docs (id INTEGER PRIMARY KEY, meta JSON)');
    db.exec(`INSERT INTO docs VALUES (1,'["gold"]'), (2,'[1]'), (3,'{"a":1,"tier":"gold"}')`);
    const emulation = db.prepare(
      'SELECT id FROM docs WHERE EXISTS (SELECT 1 FROM json_each(meta) WHERE json_each.value = ?)',
    );
    for (const operand of ['gold', 1, { a: 1 }]) {
      assert.deepEqual(emulation.all(JSON.stringify(operand)), [], `expected no match for ${JSON.stringify(operand)}`);
    }
    // ... while the value really is present, under a different encoding.
    assert.equal(emulation.all('gold').length, 2, 'the raw value matches; only the JSON-text encoding does not');
  });

  liveIt('the ORM refuses rather than returning that empty result', async () => {
    const db = new (DatabaseSync as NonNullable<typeof DatabaseSync>)(':memory:');
    db.exec('CREATE TABLE docs (id INTEGER PRIMARY KEY, meta JSON)');
    db.exec(`INSERT INTO docs VALUES (1,'{"a":1,"tier":"gold"}')`);
    const client = turbineSqlite(db, introspectSqliteDatabase(db));
    try {
      await assert.rejects(
        () => client.table('docs').findMany({ where: { meta: { contains: { a: 1 } } } } as never),
        (err: unknown) => err instanceof UnsupportedFeatureError && err.code === 'TURBINE_E017',
      );
    } finally {
      await client.disconnect();
    }
  });

  liveIt('the path-scoped alternative the error recommends actually runs', async () => {
    // An error that names a remedy is only useful if the remedy runs, so this
    // executes the exact shape the message points at, end to end.
    //
    // A STRING operand, deliberately. A NUMERIC `{ path, equals }` is a
    // SEPARATE open bug on this engine, found while writing this file and
    // reported rather than fixed here: that branch binds `String(value)` and
    // compares it against `json_extract`'s DECODED value, so TEXT '1' never
    // equals INTEGER 1 and the filter returns nothing. The RANGE branch a few
    // lines below it in where.ts already does the right thing (it casts the
    // extract and binds the raw number), which is what the fix should mirror.
    // Pinning the working half here keeps this test honest about which half
    // that is.
    const db = new (DatabaseSync as NonNullable<typeof DatabaseSync>)(':memory:');
    db.exec('CREATE TABLE docs (id INTEGER PRIMARY KEY, meta JSON)');
    db.exec(`INSERT INTO docs VALUES (1,'{"a":1,"tier":"gold"}'), (2,'{"a":2,"tier":"silver"}')`);
    const client = turbineSqlite(db, introspectSqliteDatabase(db));
    try {
      const rows = await client
        .table('docs')
        .findMany({ where: { meta: { path: ['tier'], equals: 'gold' } } } as never);
      assert.equal(rows.length, 1);
      assert.equal((rows[0] as { id: number }).id, 1);
      // The range operators are exact for numbers today, so they are a real
      // answer for the numeric case until the `equals` branch is fixed.
      const ranged = await client.table('docs').findMany({ where: { meta: { path: ['a'], gt: 1 } } } as never);
      assert.equal(ranged.length, 1);
      assert.equal((ranged[0] as { id: number }).id, 2);
    } finally {
      await client.disconnect();
    }
  });
});
