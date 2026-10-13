/**
 * Naming a PII-tagged column in `select` does not unlock it.
 *
 * `select` is ordinary request data: a parsed query string or JSON body is a
 * `select` object. The one thing request data cannot produce is the `UNSAFE`
 * symbol, which is why `includePii` is gated on it. A bare `select: { ssn: true }`
 * used to return the column anyway, so a handler that spread a request body into
 * the query args exposed every PII column the body named, contradicting the
 * promise that no JSON payload can unlock PII.
 *
 * The rule lives in `resolveProjection`, the one function every projection goes
 * through, so these tests drive each caller of it: the top level, `with` at every
 * depth under the join, positional, flatten and batched strategies, and single-row
 * write returns. They also pin what must NOT change: `omit`, predicates, a
 * PII-tagged primary key, and a correlation key the batched loader adds itself.
 *
 * Run: npx tsx --test src/test/security-perimeter-pii-select.test.ts
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { describe, it } from 'node:test';
import {
  includeKeysForBatching,
  markStitchOnly,
  STITCH_ONLY_FIELDS,
  stitchOnlyFields,
} from '../query/batched-loader.js';
import type { QueryInterface } from '../query/index.js';
import { UNSAFE } from '../query/index.js';
import { piiSelectRefusedMessage } from '../query/relations.js';
import type { SchemaMetadata, TableMetadata } from '../schema.js';
import { introspectSqliteDatabase, turbineSqlite } from '../sqlite.js';
import { makeQuery, mockTable } from './helpers.js';

// ---------------------------------------------------------------------------
// Fixture: users(id, name, email[PII], ssn[PII]) -> posts(id, author_id, title, secret[PII]) -> comments
// ---------------------------------------------------------------------------

function setPii(table: TableMetadata, columnName: string): void {
  const col = table.columns.find((c) => c.name === columnName);
  if (!col) throw new Error(`fixture: no column "${columnName}" on "${table.name}"`);
  col.pii = true;
}

function schema(): SchemaMetadata {
  const users = mockTable(
    'users',
    [
      { name: 'id', field: 'id' },
      { name: 'name', field: 'name', pgType: 'text' },
      { name: 'email', field: 'email', pgType: 'text' },
      { name: 'ssn', field: 'ssn', pgType: 'text' },
    ],
    {
      posts: {
        type: 'hasMany',
        name: 'posts',
        from: 'users',
        to: 'posts',
        foreignKey: 'author_id',
        referenceKey: 'id',
      },
    },
  );
  const posts = mockTable(
    'posts',
    [
      { name: 'id', field: 'id' },
      { name: 'author_id', field: 'authorId' },
      { name: 'title', field: 'title', pgType: 'text' },
      { name: 'secret', field: 'secret', pgType: 'text' },
    ],
    {
      author: {
        type: 'belongsTo',
        name: 'author',
        from: 'posts',
        to: 'users',
        foreignKey: 'author_id',
        referenceKey: 'id',
      },
    },
  );
  setPii(users, 'email');
  setPii(users, 'ssn');
  setPii(posts, 'secret');
  return { enums: {}, tables: { users, posts } };
}

type Q = QueryInterface<Record<string, unknown>>;
const users = (options?: Parameters<typeof makeQuery>[2]): Q => makeQuery('users', schema(), options) as unknown as Q;
const posts = (options?: Parameters<typeof makeQuery>[2]): Q => makeQuery('posts', schema(), options) as unknown as Q;

/** Asserts an E003 that names the column and the opt-in. */
function refusal(column: string): (err: unknown) => boolean {
  return (err: unknown) =>
    err instanceof Error &&
    (err as { code?: string }).code === 'TURBINE_E003' &&
    err.message.includes(`names "${column}", which is tagged PII`) &&
    err.message.includes('includePii: UNSAFE');
}

// ---------------------------------------------------------------------------

describe('select naming a PII column: top level', () => {
  it('findMany, findFirst and findUnique refuse it', () => {
    assert.throws(() => users().buildFindMany({ select: { id: true, ssn: true } }), refusal('ssn'));
    assert.throws(() => users().buildFindMany({ select: { email: true } }), refusal('email'));
    assert.throws(() => users().buildFindUnique({ where: { id: 1 }, select: { ssn: true } }), refusal('ssn'));
    assert.throws(() => users().buildFindFirst({ select: { ssn: true } }), refusal('ssn'));
  });

  it('refuses the snake_case spelling of a column field too', () => {
    const s = schema();
    s.tables.users!.columns.find((c) => c.name === 'email')!.field = 'emailAddress';
    s.tables.users!.columnMap = { ...s.tables.users!.columnMap, emailAddress: 'email' };
    s.tables.users!.reverseColumnMap = { ...s.tables.users!.reverseColumnMap, email: 'emailAddress' };
    const q = makeQuery('users', s) as unknown as Q;
    assert.throws(() => q.buildFindMany({ select: { emailAddress: true } }), /names "emailAddress"/);
    assert.throws(() => q.buildFindMany({ select: { email: true } }), /names "emailAddress"/);
  });

  it('is decided per key: a false value names nothing, so it is not a request', () => {
    const { sql } = users().buildFindMany({ select: { id: true, ssn: false } });
    assert.match(sql, /"users"\."id"/);
    assert.doesNotMatch(sql, /ssn/);
  });

  it('includePii: UNSAFE unlocks it, and returns exactly the named columns', () => {
    const { sql } = users().buildFindMany({ select: { id: true, ssn: true }, includePii: UNSAFE });
    assert.match(sql, /"users"\."ssn"/);
    assert.doesNotMatch(sql, /"users"\."name"/);
  });

  it('a literal includePii: true is still refused (the symbol is the only key)', () => {
    assert.throws(
      () => users().buildFindMany({ select: { ssn: true }, includePii: true as never }),
      /includePii|UNSAFE/,
    );
  });

  it('a request body spread into the args cannot unlock it', () => {
    // The shape the README promises is safe: parsed request data spread into args.
    const body = JSON.parse('{"select":{"id":true,"ssn":true},"includePii":true}') as Record<string, unknown>;
    assert.throws(() => users().buildFindMany({ where: { id: 1 }, ...body } as never));
    const justSelect = JSON.parse('{"select":{"ssn":true}}') as Record<string, unknown>;
    assert.throws(() => users().buildFindMany({ where: { id: 1 }, ...justSelect } as never), refusal('ssn'));
  });

  it('a JSON body cannot forge the loader exemption', () => {
    // The exemption is a symbol-keyed, non-enumerable marker. JSON.parse yields
    // only string keys, so no payload can carry it.
    const forged = JSON.parse(`{"select":{"ssn":true},"${String(STITCH_ONLY_FIELDS)}":["ssn"]}`) as Record<
      string,
      unknown
    >;
    assert.throws(() => users().buildFindMany({ ...forged } as never), refusal('ssn'));
    assert.equal(stitchOnlyFields(JSON.parse('{"ssn":true}') as object), undefined);
  });

  it('the error text names the table and the field', () => {
    assert.equal(
      piiSelectRefusedMessage('users', 'ssn').includes('`select` on "users" names "ssn"'),
      true,
      'message shape the refusal() matcher relies on',
    );
  });
});

describe('what the rule does not touch', () => {
  it('omit, and the default projection, are unchanged: PII stays out', () => {
    const { sql } = users().buildFindMany({ omit: { name: true } });
    assert.doesNotMatch(sql, /"users"\."(name|email|ssn)"/);
    assert.match(sql, /"users"\."id"/);
  });

  it('where, orderBy and having on a PII column are still allowed', () => {
    assert.doesNotThrow(() => users().buildFindMany({ where: { ssn: '1' }, orderBy: { email: 'asc' } }));
  });

  it('a select that names only non-PII columns is unchanged', () => {
    const { sql } = users().buildFindMany({ select: { id: true, name: true } });
    assert.match(sql, /"users"\."name"/);
  });

  it('a PII-tagged PRIMARY KEY is never stripped, so selecting it is allowed', () => {
    const s = schema();
    setPii(s.tables.users!, 'id');
    const q = makeQuery('users', s) as unknown as Q;
    assert.doesNotThrow(() => q.buildFindMany({ select: { id: true } }));
  });

  it('an untagged schema emits the same SQL with and without includePii', () => {
    const s = schema();
    for (const t of Object.values(s.tables)) for (const c of t.columns) c.pii = undefined;
    const q = makeQuery('users', s) as unknown as Q;
    assert.equal(
      q.buildFindMany({ select: { email: true } }).sql,
      q.buildFindMany({ select: { email: true }, includePii: UNSAFE }).sql,
    );
  });
});

describe('select naming a PII column: relations at every depth', () => {
  for (const jsonEncoding of ['object', 'positional'] as const) {
    describe(`join strategy, ${jsonEncoding} encoding`, () => {
      const opts = { jsonEncoding } as const;

      it('a relation select naming PII is refused, and unlocked by includePii', () => {
        const args = { with: { posts: { select: { title: true, secret: true } } } };
        assert.throws(() => users(opts).buildFindMany(args), refusal('secret'));
        assert.doesNotThrow(() => users(opts).buildFindMany({ ...args, includePii: UNSAFE }));
      });

      it('a nested relation select two levels down is refused', () => {
        assert.throws(
          () => users(opts).buildFindMany({ with: { posts: { with: { author: { select: { ssn: true } } } } } }),
          refusal('ssn'),
        );
      });

      it('a relation whose select names only non-PII columns is unchanged', () => {
        assert.doesNotThrow(() => users(opts).buildFindMany({ with: { posts: { select: { title: true } } } }));
      });

      it('the relation refusal reaches findUnique and findFirst as well', () => {
        const withPii = { with: { posts: { select: { secret: true } } } };
        assert.throws(() => users(opts).buildFindUnique({ where: { id: 1 }, ...withPii }), refusal('secret'));
        assert.throws(() => users(opts).buildFindFirst(withPii), refusal('secret'));
      });
    });
  }

  it('flatten strategy: a to-one relation select naming PII is refused, not planned around', () => {
    const q = posts({ jsonEncoding: 'object' });
    assert.throws(
      () => q.buildFindMany({ with: { author: { select: { id: true, ssn: true } } }, relationLoadStrategy: 'flatten' }),
      refusal('ssn'),
    );
    // Control: the same plan with a non-PII select really flattens (the refusal
    // above is not a flatten fallback to the subquery path throwing instead).
    const ok = q.buildFindMany({
      with: { author: { select: { id: true, name: true } } },
      relationLoadStrategy: 'flatten',
    });
    assert.match(ok.sql, /f\d+__/, 'flatten plan engaged');
  });
});

describe('select naming a PII column: single-row writes', () => {
  it('a write cannot carry includePii, so a PII select is refused before any SQL exists', () => {
    assert.throws(() => users().buildCreate({ data: { name: 'x' }, select: { id: true, ssn: true } }), refusal('ssn'));
    assert.throws(
      () => users().buildUpdate({ where: { id: 1 }, data: { name: 'x' }, select: { ssn: true } }),
      refusal('ssn'),
    );
    assert.throws(() => users().buildDelete({ where: { id: 1 }, select: { email: true } }), refusal('email'));
    assert.throws(
      () =>
        users().buildUpsert({
          where: { id: 1 },
          create: { id: 1, name: 'x' },
          update: { name: 'y' },
          select: { ssn: true },
        }),
      refusal('ssn'),
    );
  });

  it('the refusal text tells the caller how to read the row back', () => {
    try {
      users().buildCreate({ data: { name: 'x' }, select: { ssn: true } });
      assert.fail('expected a refusal');
    } catch (err) {
      assert.match((err as Error).message, /A write never returns a PII column/);
    }
  });
});

describe('the batched loader keeps working when it adds a PII key itself', () => {
  const meta = schema().tables.users!;

  it('marks only the fields it added, and not the ones the caller named', () => {
    const named = includeKeysForBatching(meta, { id: true, name: true }, undefined, ['id', 'email']);
    assert.deepEqual([...(stitchOnlyFields(named.select) ?? [])], ['email']);
    assert.deepEqual(named.strip, ['email']);

    // Already selected by the caller: not added, not marked, so the resolver still judges it.
    const alreadyThere = includeKeysForBatching(meta, { id: true, email: true }, undefined, ['email']);
    assert.equal(stitchOnlyFields(alreadyThere.select), undefined);
  });

  it('the marker is invisible to enumeration, copies and JSON', () => {
    const marked = markStitchOnly({ id: true }, ['email']);
    assert.deepEqual(Object.keys(marked), ['id']);
    assert.equal(JSON.stringify(marked), '{"id":true}');
    assert.equal(stitchOnlyFields({ ...marked }), undefined, 'a spread copy drops the exemption');
  });

  it('the resolver exempts exactly the marked fields', () => {
    const q = users();
    const marked = markStitchOnly({ id: true, email: true }, ['email']);
    assert.doesNotThrow(() => q.buildFindMany({ select: marked }));
    // ssn is not in the marked set, so naming it is still refused.
    const partly = markStitchOnly({ id: true, email: true, ssn: true }, ['email']);
    assert.throws(() => q.buildFindMany({ select: partly }), refusal('ssn'));
  });
});

// ---------------------------------------------------------------------------
// The batched loader against a real (in-process) database
// ---------------------------------------------------------------------------

const DatabaseSync: (new (path: string) => DatabaseSyncType) | undefined = (() => {
  try {
    return createRequire(process.cwd())('node:sqlite').DatabaseSync;
  } catch {
    return undefined;
  }
})();

const dbIt: typeof it = DatabaseSync
  ? it
  : (((name: string) => it(name, { skip: 'requires node:sqlite (Node >= 22.5)' }, () => {})) as typeof it);

const SCHEMA_SQL = `
CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL);
CREATE TABLE posts (id INTEGER PRIMARY KEY, author_email TEXT REFERENCES users(email), title TEXT NOT NULL);
INSERT INTO users VALUES (1, 'a@x', 'a'), (2, 'b@x', 'b');
INSERT INTO posts VALUES (1, 'a@x', 'p1'), (2, 'a@x', 'p2'), (3, 'b@x', 'p3');
`;

function taggedDb(): { db: DatabaseSyncType; meta: SchemaMetadata } {
  const db = new DatabaseSync!(':memory:');
  db.exec(SCHEMA_SQL);
  const meta = introspectSqliteDatabase(db);
  // The correlation key is PII on BOTH sides: users.email (parent key) and posts.author_email (child key).
  for (const c of meta.tables.users!.columns) if (c.name === 'email') c.pii = true;
  for (const c of meta.tables.posts!.columns) if (c.name === 'author_email') c.pii = true;
  return { db, meta };
}

describe('batched and auto strategies with a PII-tagged correlation key', () => {
  for (const strategy of ['batched', 'auto', 'join'] as const) {
    dbIt(
      `a select that never names the key still stitches under '${strategy}', and the key never escapes`,
      async () => {
        const { db, meta } = taggedDb();
        const client = turbineSqlite(db, meta, { warnOnUnlimited: false });
        try {
          const rows = (await client.table('users').findMany({
            select: { name: true },
            with: { posts: { select: { title: true } } },
            orderBy: { id: 'asc' },
            relationLoadStrategy: strategy,
          } as never)) as Record<string, unknown>[];
          assert.deepEqual(
            rows.map((r) => [r.name, (r.posts as { title: string }[]).map((p) => p.title)]),
            [
              ['a', ['p1', 'p2']],
              ['b', ['p3']],
            ],
          );
          for (const row of rows) {
            assert.equal(Object.hasOwn(row, 'email'), false, 'parent PII key stripped');
            for (const post of row.posts as Record<string, unknown>[]) {
              assert.equal(Object.hasOwn(post, 'authorEmail'), false, 'child PII key stripped');
            }
          }
        } finally {
          await client.disconnect();
        }
      },
    );

    dbIt(`naming the PII key in select is still refused under '${strategy}'`, async () => {
      const { db, meta } = taggedDb();
      const client = turbineSqlite(db, meta, { warnOnUnlimited: false });
      try {
        await assert.rejects(
          () =>
            client.table('users').findMany({
              select: { email: true, name: true },
              with: { posts: true },
              relationLoadStrategy: strategy,
            } as never),
          /names "email", which is tagged PII/,
        );
        await assert.rejects(
          () =>
            client.table('users').findMany({
              select: { name: true },
              with: { posts: { select: { authorEmail: true, title: true } } },
              relationLoadStrategy: strategy,
            } as never),
          /names "authorEmail", which is tagged PII/,
        );
      } finally {
        await client.disconnect();
      }
    });
  }

  dbIt('includePii: UNSAFE returns the key when the caller asked for it, under the batched strategy', async () => {
    const { db, meta } = taggedDb();
    const client = turbineSqlite(db, meta, { warnOnUnlimited: false });
    try {
      const rows = (await client.table('users').findMany({
        select: { email: true, name: true },
        with: { posts: { select: { authorEmail: true } } },
        orderBy: { id: 'asc' },
        relationLoadStrategy: 'batched',
        includePii: UNSAFE,
      } as never)) as Record<string, unknown>[];
      assert.equal(rows[0]!.email, 'a@x');
      assert.equal((rows[0]!.posts as Record<string, unknown>[])[0]!.authorEmail, 'a@x');
    } finally {
      await client.disconnect();
    }
  });
});
