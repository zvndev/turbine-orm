/**
 * turbine-orm, `select` / `omit` on single-row writes (build-only, no database)
 *
 * `create`, `update`, `delete` and `upsert` always returned the whole row
 * through `RETURNING *` and took no way to narrow it. On a table with a large
 * JSON column that is most of the bytes a write moves: with a 3.1 KB jsonb
 * payload at concurrency 50, the same INSERT ran at 60,900/s with no RETURNING
 * and 34,500/s with `RETURNING *`. They now take the read path's `select` /
 * `omit`, resolved by the same `resolveProjection`, and the narrowing happens IN
 * the statement (RETURNING on PostgreSQL / SQLite, the re-SELECT on MySQL,
 * OUTPUT on SQL Server), not by trimming a row that already crossed the wire.
 *
 * Live coverage: write-projection.integration.test.ts (PostgreSQL) and the
 * PowDB block in powdb-write-projection.test.ts.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ValidationError } from '../errors.js';
import { mssqlDialect } from '../mssql.js';
import { mysqlDialect } from '../mysql.js';
import type { SchemaMetadata } from '../schema.js';
import { sqliteDialect } from '../sqlite.js';
import { makeQuery, mockTable } from './helpers.js';

function schema(): SchemaMetadata {
  return {
    enums: {},
    tables: {
      events: mockTable(
        'events',
        [
          { name: 'id', field: 'id' },
          { name: 'kind', field: 'kind', pgType: 'text' },
          { name: 'payload', field: 'payload', pgType: 'jsonb' },
          { name: 'owner_email', field: 'ownerEmail', pgType: 'text', pii: true },
          { name: 'user_id', field: 'userId' },
        ],
        {
          user: {
            type: 'belongsTo',
            name: 'user',
            from: 'events',
            to: 'users',
            foreignKey: 'user_id',
            referenceKey: 'id',
          },
        },
      ),
      users: mockTable('users', [{ name: 'id', field: 'id' }]),
    },
  };
}

type Row = { id: number; kind: string; payload: unknown; ownerEmail: string; userId: number };
const events = (options?: Parameters<typeof makeQuery>[2]) =>
  makeQuery<Row>('events', schema(), { warnOnUnlimited: false, ...options });

/** Everything from RETURNING / OUTPUT onward, or the SELECT list of a reselect. */
function returned(sql: string): string {
  const at = Math.min(
    ...['RETURNING', 'OUTPUT'].map((k) => (sql.includes(k) ? sql.indexOf(k) : Number.POSITIVE_INFINITY)),
  );
  return Number.isFinite(at) ? sql.slice(at) : sql;
}

describe('create: select / omit narrow the RETURNING list itself', () => {
  it('select returns only the named columns', () => {
    const d = events().buildCreate({ data: { kind: 'click', payload: { big: true } }, select: { id: true } });
    assert.match(d.sql, /RETURNING "id"$/);
    assert.doesNotMatch(d.sql, /"payload"\s*$/);
  });

  it('omit returns every column but the omitted ones, and PII stays out', () => {
    const d = events().buildCreate({ data: { kind: 'click' }, omit: { payload: true } });
    assert.equal(returned(d.sql), 'RETURNING "id", "kind", "user_id"');
  });

  it('with neither, the default is unchanged (PII excluded, else *)', () => {
    const d = events().buildCreate({ data: { kind: 'click' } });
    assert.equal(returned(d.sql), 'RETURNING "id", "kind", "payload", "user_id"');
  });

  it('select is emitted in TABLE order, so key order cannot mint distinct statements', () => {
    const a = events().buildCreate({ data: { kind: 'x' }, select: { kind: true, id: true } });
    const b = events().buildCreate({ data: { kind: 'x' }, select: { id: true, kind: true } });
    assert.equal(a.sql, b.sql);
  });

  it('snake_case column names resolve like field names, as on reads', () => {
    const d = events().buildCreate({ data: { kind: 'x' }, select: { user_id: true } as never });
    assert.match(d.sql, /RETURNING "user_id"$/);
  });
});

describe('the returned row matches the projection, PII included only when selected', () => {
  const row = { id: 7, kind: 'click', payload: { a: 1 }, owner_email: 'o@x', user_id: 3 };

  it('an explicit select of a PII column is the opt-in, exactly as on a read', () => {
    const d = events().buildCreate({ data: { kind: 'x' }, select: { id: true, ownerEmail: true } });
    assert.match(d.sql, /RETURNING "id", "owner_email"$/);
    assert.deepEqual(d.transform({ rows: [{ id: 7, owner_email: 'o@x' }] } as never), { id: 7, ownerEmail: 'o@x' });
  });

  it('without a select the PII field is still stripped from a row that carries it', () => {
    const d = events().buildCreate({ data: { kind: 'x' } });
    const out = d.transform({ rows: [row] } as never) as Record<string, unknown>;
    assert.equal('ownerEmail' in out, false);
  });

  it('omit never brings PII back', () => {
    const d = events().buildCreate({ data: { kind: 'x' }, omit: { payload: true } });
    const out = d.transform({ rows: [row] } as never) as Record<string, unknown>;
    assert.equal('ownerEmail' in out, false);
  });
});

describe('refusals match the read path, and fire before any SQL exists', () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ['an unknown field', { select: { kynd: true } }, /kynd/],
    ['a relation name', { select: { user: true } }, /relation/i],
    ['an empty select', { select: {} }, /select/i],
    ['an all-false select', { select: { id: false } }, /select/i],
    ['select and omit together', { select: { id: true }, omit: { kind: true } }, /omit/i],
    ['an array select', { select: ['id'] }, /array/i],
    ['an unknown omit field', { omit: { kynd: true } }, /kynd/],
  ];
  for (const [label, projection, message] of cases) {
    it(`create refuses ${label}`, () => {
      assert.throws(
        () => events().buildCreate({ data: { kind: 'x' }, ...projection } as never),
        (err) => err instanceof ValidationError && message.test(err.message),
      );
    });
  }

  it('an omit that removes every column is refused rather than emitting an empty RETURNING', () => {
    assert.throws(
      () =>
        events().buildCreate({
          data: { kind: 'x' },
          omit: { id: true, kind: true, payload: true, userId: true },
        }),
      (err) => err instanceof ValidationError && /no column to return/.test(err.message),
    );
  });
});

describe('update, delete and upsert take the same projection', () => {
  it('update narrows RETURNING', () => {
    const d = events().buildUpdate({ where: { id: 1 }, data: { kind: 'y' }, select: { id: true, kind: true } });
    assert.equal(returned(d.sql), 'RETURNING "id", "kind"');
  });

  it('an update with nothing to set re-selects through the projection', () => {
    const d = events().buildUpdate({ where: { id: 1 }, data: {}, select: { kind: true } });
    assert.match(d.sql, /^SELECT "kind" FROM "events"/);
  });

  it('delete narrows RETURNING', () => {
    const d = events().buildDelete({ where: { id: 1 }, omit: { payload: true } });
    assert.equal(returned(d.sql), 'RETURNING "id", "kind", "user_id"');
  });

  it('upsert narrows RETURNING', () => {
    const d = events().buildUpsert({
      where: { id: 1 },
      create: { id: 1, kind: 'a' },
      update: { kind: 'b' },
      select: { id: true },
    });
    assert.match(d.sql, /RETURNING "id"$/);
  });
});

describe('the write SQL cache keys on the projection', () => {
  // update and delete are served from the template cache. Their key was SET +
  // WHERE only, so without a projection segment the second call below would be
  // handed the first call's statement and return the first caller's columns.
  it('update: same SET and WHERE, different select, different statements', () => {
    const q = events();
    const a = q.buildUpdate({ where: { id: 1 }, data: { kind: 'y' }, select: { id: true } });
    const b = q.buildUpdate({ where: { id: 1 }, data: { kind: 'y' }, select: { kind: true } });
    const c = q.buildUpdate({ where: { id: 1 }, data: { kind: 'y' } });
    assert.equal(returned(a.sql), 'RETURNING "id"');
    assert.equal(returned(b.sql), 'RETURNING "kind"');
    assert.equal(returned(c.sql), 'RETURNING "id", "kind", "payload", "user_id"');
    assert.notEqual(a.preparedName, b.preparedName);
  });

  it('delete: same WHERE, different omit, different statements', () => {
    const q = events();
    const a = q.buildDelete({ where: { id: 1 }, omit: { payload: true } });
    const b = q.buildDelete({ where: { id: 1 } });
    assert.equal(returned(a.sql), 'RETURNING "id", "kind", "user_id"');
    assert.equal(returned(b.sql), 'RETURNING "id", "kind", "payload", "user_id"');
  });
});

describe('every engine narrows in the statement', () => {
  it('SQLite: RETURNING list', () => {
    const d = events({ dialect: sqliteDialect }).buildCreate({ data: { kind: 'x' }, select: { id: true } });
    assert.match(d.sql, /RETURNING "id"$/);
  });

  it('SQL Server: OUTPUT INSERTED.<col> list', () => {
    const d = events({ dialect: mssqlDialect }).buildCreate({ data: { kind: 'x' }, select: { id: true } });
    assert.match(d.sql, /OUTPUT INSERTED\.\[id\]/);
    assert.doesNotMatch(d.sql, /\[payload\]\s+VALUES|INSERTED\.\[payload\]/);
  });

  it('MySQL: the re-SELECT after the write uses the projection', async () => {
    const d = events({ dialect: mysqlDialect }).buildCreate({ data: { id: 5, kind: 'x' }, select: { kind: true } });
    const seen: string[] = [];
    await d.reselect?.(async (sql) => {
      seen.push(sql);
      return { rows: [], rowCount: 1 } as never;
    });
    assert.equal(seen.length, 2, 'INSERT then SELECT');
    assert.match(seen[1] as string, /^SELECT `kind` FROM `events` WHERE `id` = /);
  });
});
