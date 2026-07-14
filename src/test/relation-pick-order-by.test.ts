/**
 * turbine-orm: pick-row relation ordering (top-level findMany orderBy)
 *
 * `orderBy: { versions: { pick: { orderBy, where? }, by, direction?, nulls? } }`
 * orders parents by a value read from ONE related row of a hasMany relation:
 * a correlated scalar subquery with its own `ORDER BY … LIMIT 1`:
 *
 *   ORDER BY (SELECT ord0."data" #>> $n::text[] FROM "versions" ord0
 *             WHERE ord0."instance_id" = "instances"."id" AND ord0."is_current" = $m
 *             ORDER BY ord0."created_at" DESC LIMIT 1) ASC NULLS LAST
 *
 * Scope in this release: hasMany relations, top-level findMany orderBy only.
 * manyToMany, to-one relations, and nested `with` orderBy throw a clear E003.
 *
 * Cache safety: relation name, by-shape (column vs path vs cast), direction,
 * nulls, pick.orderBy shape, and pick.where SHAPE are fingerprinted; the JSON
 * paths and pick.where values are bound params mirrored by the collect paths.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { RelationError, UnsupportedFeatureError, ValidationError } from '../errors.js';
import { introspect } from '../introspect.js';
import { mysqlDialect } from '../mysql.js';
import type { SchemaMetadata } from '../schema.js';
import { sqliteDialect } from '../sqlite.js';
import { makeQuery, mockTable, skipGate } from './helpers.js';

function schema(): SchemaMetadata {
  return {
    enums: {},
    tables: {
      instances: mockTable(
        'instances',
        [
          { name: 'id', field: 'id' },
          { name: 'name', field: 'name', pgType: 'text' },
        ],
        {
          versions: {
            type: 'hasMany',
            name: 'versions',
            from: 'instances',
            to: 'versions',
            foreignKey: 'instance_id',
            referenceKey: 'id',
          },
          tags: {
            type: 'manyToMany',
            name: 'tags',
            from: 'instances',
            to: 'tags',
            foreignKey: 'id',
            referenceKey: 'id',
            through: { table: 'instance_tags', sourceKey: 'instance_id', targetKey: 'tag_id' },
          },
          owner: {
            type: 'belongsTo',
            name: 'owner',
            from: 'instances',
            to: 'owners',
            foreignKey: 'owner_id',
            referenceKey: 'id',
          },
        },
      ),
      versions: mockTable('versions', [
        { name: 'id', field: 'id' },
        { name: 'instance_id', field: 'instanceId' },
        { name: 'title', field: 'title', pgType: 'text' },
        { name: 'data', field: 'data', pgType: 'jsonb' },
        { name: 'created_at', field: 'createdAt', pgType: 'timestamptz' },
        { name: 'is_current', field: 'isCurrent', pgType: 'bool' },
      ]),
      tags: mockTable('tags', [
        { name: 'id', field: 'id' },
        { name: 'label', field: 'label', pgType: 'text' },
      ]),
      instance_tags: mockTable('instance_tags', [
        { name: 'instance_id', field: 'instanceId' },
        { name: 'tag_id', field: 'tagId' },
      ]),
      owners: mockTable('owners', [
        { name: 'id', field: 'id' },
        { name: 'name', field: 'name', pgType: 'text' },
      ]),
    },
  };
}

describe('pick-row relation ordering: SQL generation', () => {
  it('plain-column by → correlated scalar subquery with inner ORDER BY … LIMIT 1', () => {
    const q = makeQuery('instances', schema());
    const { sql, params } = q.buildFindMany({
      orderBy: { versions: { pick: { orderBy: { createdAt: 'desc' } }, by: 'title' } },
    } as never);
    assert.match(
      sql,
      /ORDER BY \(SELECT ord0\."title" FROM "versions" ord0 WHERE ord0\."instance_id" = "instances"\."id" ORDER BY ord0\."created_at" DESC LIMIT 1\) ASC/,
    );
    assert.deepEqual(params, []);
  });

  it('JSON-path by binds the path as one text[] param (text comparison by default)', () => {
    const q = makeQuery('instances', schema());
    const { sql, params } = q.buildFindMany({
      orderBy: {
        versions: { pick: { orderBy: { createdAt: 'desc' } }, by: { field: 'data', path: ['title'] } },
      },
    } as never);
    assert.match(
      sql,
      /ORDER BY \(SELECT ord0\."data" #>> \$1::text\[\] FROM "versions" ord0 WHERE ord0\."instance_id" = "instances"\."id" ORDER BY ord0\."created_at" DESC LIMIT 1\) ASC/,
    );
    assert.deepEqual(params, [['title']]);
  });

  it("JSON-path by with type: 'numeric' adds the ::numeric cast; direction and nulls respected", () => {
    const q = makeQuery('instances', schema());
    const { sql, params } = q.buildFindMany({
      orderBy: {
        versions: {
          pick: { orderBy: { createdAt: 'desc' } },
          by: { field: 'data', path: ['price'], type: 'numeric' },
          direction: 'desc',
          nulls: 'last',
        },
      },
    } as never);
    assert.ok(sql.includes('(ord0."data" #>> $1::text[])::numeric'), sql);
    assert.match(sql, /LIMIT 1\) DESC NULLS LAST/);
    assert.deepEqual(params, [['price']]);
  });

  it('pick.where filters the candidate rows (values parameterized)', () => {
    const q = makeQuery('instances', schema());
    const { sql, params } = q.buildFindMany({
      orderBy: {
        versions: {
          pick: { orderBy: { createdAt: 'desc' }, where: { isCurrent: true } },
          by: 'title',
        },
      },
    } as never);
    assert.match(
      sql,
      /WHERE ord0\."instance_id" = "instances"\."id" AND ord0\."is_current" = \$1 ORDER BY ord0\."created_at" DESC LIMIT 1/,
    );
    assert.deepEqual(params, [true]);
  });

  it('pick.orderBy supports OrderBySpec nulls and JSON-path entries', () => {
    const q = makeQuery('instances', schema());
    const { sql, params } = q.buildFindMany({
      orderBy: {
        versions: {
          pick: { orderBy: { data: { path: ['rev'], type: 'numeric', direction: 'desc' } } },
          by: 'title',
        },
      },
    } as never);
    assert.ok(sql.includes('ORDER BY (ord0."data" #>> $1::text[])::numeric DESC LIMIT 1'), sql);
    assert.deepEqual(params, [['rev']]);
  });

  it('param order: where → by path → pick.where → pick.orderBy path → limit', () => {
    const q = makeQuery('instances', schema());
    const { sql, params } = q.buildFindMany({
      where: { name: { contains: 'x' } },
      orderBy: {
        versions: {
          pick: {
            orderBy: { data: { path: ['rev'], type: 'numeric', direction: 'desc' } },
            where: { isCurrent: true },
          },
          by: { field: 'data', path: ['title'] },
        },
      },
      limit: 5,
    } as never);
    assert.deepEqual(params, ['%x%', ['title'], true, ['rev'], 5]);
    assert.ok(sql.includes('"name" LIKE $1'), sql);
    assert.ok(sql.includes('#>> $2::text[]'), sql);
    assert.ok(sql.includes('"is_current" = $3'), sql);
    assert.ok(sql.includes('#>> $4::text[])::numeric DESC'), sql);
    assert.ok(sql.includes('LIMIT $5'), sql);
  });

  it('composes with a plain column ordering in the same orderBy', () => {
    const q = makeQuery('instances', schema());
    const { sql } = q.buildFindMany({
      orderBy: {
        versions: { pick: { orderBy: { createdAt: 'desc' } }, by: 'title' },
        name: 'asc',
      },
    } as never);
    assert.match(sql, /LIMIT 1\) ASC, "name" ASC/);
  });
});

describe('pick-row relation ordering: scope errors', () => {
  it('manyToMany relation throws a clear E003 naming the limitation', () => {
    const q = makeQuery('instances', schema());
    assert.throws(
      () =>
        q.buildFindMany({
          orderBy: { tags: { pick: { orderBy: { label: 'asc' } }, by: 'label' } },
        } as never),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        assert.match(err.message, /not supported on manyToMany relation "tags"/);
        return true;
      },
    );
  });

  it('to-one relation throws E003 pointing at direct column ordering', () => {
    const q = makeQuery('instances', schema());
    assert.throws(
      () =>
        q.buildFindMany({
          orderBy: { owner: { pick: { orderBy: { name: 'asc' } }, by: 'name' } },
        } as never),
      /only for to-many \(hasMany\) relations; "owner" is belongsTo/,
    );
  });

  it('missing pick.orderBy throws E003 (determinism required)', () => {
    const q = makeQuery('instances', schema());
    assert.throws(
      () => q.buildFindMany({ orderBy: { versions: { pick: {}, by: 'title' } } } as never),
      /requires `pick\.orderBy` to choose ONE related row deterministically/,
    );
    assert.throws(
      () => q.buildFindMany({ orderBy: { versions: { pick: { orderBy: {} }, by: 'title' } } } as never),
      /requires `pick\.orderBy`/,
    );
  });

  it('invalid by shape throws E003', () => {
    const q = makeQuery('instances', schema());
    assert.throws(
      () => q.buildFindMany({ orderBy: { versions: { pick: { orderBy: { createdAt: 'desc' } }, by: 7 } } } as never),
      /requires `by`: a target column name or a JSON-path spec/,
    );
  });

  it('unknown by column throws the standard unknown-field E003', () => {
    const q = makeQuery('instances', schema());
    assert.throws(
      () =>
        q.buildFindMany({ orderBy: { versions: { pick: { orderBy: { createdAt: 'desc' } }, by: 'bogus' } } } as never),
      /Unknown field "bogus" in orderBy on table "versions"/,
    );
  });

  it('JSON-path by on a non-JSON column throws E003', () => {
    const q = makeQuery('instances', schema());
    assert.throws(
      () =>
        q.buildFindMany({
          orderBy: {
            versions: { pick: { orderBy: { createdAt: 'desc' } }, by: { field: 'title', path: ['x'] } },
          },
        } as never),
      /column "title" on table "versions" is not a JSON column/,
    );
  });

  it('unknown relation throws E005', () => {
    const q = makeQuery('instances', schema());
    assert.throws(
      () => q.buildFindMany({ orderBy: { bogusRel: { pick: { orderBy: { x: 'asc' } }, by: 'x' } } } as never),
      RelationError,
    );
  });

  it('nested `with` orderBy throws E003 (top-level only)', () => {
    const s = schema();
    // versions → back-reference so the nested with has a relation to order by.
    s.tables.versions!.relations = {
      revisions: {
        type: 'hasMany',
        name: 'revisions',
        from: 'versions',
        to: 'versions',
        foreignKey: 'instance_id',
        referenceKey: 'id',
      },
    };
    const q = makeQuery('instances', s);
    assert.throws(
      () =>
        q.buildFindMany({
          with: {
            versions: {
              orderBy: { revisions: { pick: { orderBy: { createdAt: 'desc' } }, by: 'title' } },
            },
          },
        } as never),
      /only supported in a top-level findMany orderBy/,
    );
  });

  it('a nested pick inside pick.orderBy throws E003 (top-level only)', () => {
    const s = schema();
    s.tables.versions!.relations = {
      revisions: {
        type: 'hasMany',
        name: 'revisions',
        from: 'versions',
        to: 'versions',
        foreignKey: 'instance_id',
        referenceKey: 'id',
      },
    };
    const q = makeQuery('instances', s);
    assert.throws(
      () =>
        q.buildFindMany({
          orderBy: {
            versions: {
              pick: { orderBy: { revisions: { pick: { orderBy: { createdAt: 'desc' } }, by: 'title' } } },
              by: 'title',
            },
          },
        } as never),
      /only supported in a top-level findMany orderBy/,
    );
  });

  it('groupBy orderBy context throws E003', () => {
    const q = makeQuery('instances', schema());
    assert.throws(
      () =>
        q.buildGroupBy({
          by: ['name'],
          orderBy: { versions: { pick: { orderBy: { createdAt: 'desc' } }, by: 'title' } },
        } as never),
      /only supported in a top-level findMany orderBy/,
    );
  });
});

describe('pick-row relation ordering: dialect gating', () => {
  it('plain-column pick ordering compiles on SQLite', () => {
    const q = makeQuery('instances', schema(), { dialect: sqliteDialect, sqlCache: false });
    const { sql } = q.buildFindMany({
      orderBy: { versions: { pick: { orderBy: { createdAt: 'desc' } }, by: 'title' } },
    } as never);
    assert.match(sql, /ORDER BY \(SELECT ord0\."title" FROM "versions" ord0/);
  });

  it('plain-column pick ordering compiles on MySQL (backtick quoting)', () => {
    const q = makeQuery('instances', schema(), { dialect: mysqlDialect, sqlCache: false });
    const { sql } = q.buildFindMany({
      orderBy: { versions: { pick: { orderBy: { createdAt: 'desc' } }, by: 'title' } },
    } as never);
    assert.ok(sql.includes('ORDER BY (SELECT ord0.`title` FROM `versions` ord0'), sql);
  });

  it('nulls placement throws E017 on MySQL (same as every other orderBy path)', () => {
    const q = makeQuery('instances', schema(), { dialect: mysqlDialect, sqlCache: false });
    assert.throws(
      () =>
        q.buildFindMany({
          orderBy: { versions: { pick: { orderBy: { createdAt: 'desc' } }, by: 'title', nulls: 'last' } },
        } as never),
      UnsupportedFeatureError,
    );
  });
});

describe('pick-row relation ordering: cache safety', () => {
  it('double-run identity: plain-column by', () => {
    const q = makeQuery('instances', schema());
    const args = {
      where: { name: 'n' },
      orderBy: { versions: { pick: { orderBy: { createdAt: 'desc' } }, by: 'title' } },
    } as never;
    const first = q.buildFindMany(args);
    const second = q.buildFindMany(args);
    assert.equal(second.sql, first.sql);
    assert.deepEqual(second.params, first.params);
    assert.deepEqual(first.params, ['n']);
  });

  it('double-run identity: JSON by + pick.where + pick.orderBy JSON path', () => {
    const q = makeQuery('instances', schema());
    const args = {
      where: { name: 'n' },
      orderBy: {
        versions: {
          pick: {
            orderBy: { data: { path: ['rev'], type: 'numeric', direction: 'desc' } },
            where: { isCurrent: true },
          },
          by: { field: 'data', path: ['title'] },
          direction: 'desc',
          nulls: 'first',
        },
      },
      limit: 3,
    } as never;
    const first = q.buildFindMany(args);
    const second = q.buildFindMany(args);
    assert.equal(second.sql, first.sql);
    assert.deepEqual(second.params, first.params);
    assert.deepEqual(first.params, ['n', ['title'], true, ['rev'], 3]);
  });

  it('same shape with different path/where values shares SQL text but binds its own params', () => {
    const q = makeQuery('instances', schema());
    const a = q.buildFindMany({
      orderBy: {
        versions: {
          pick: { orderBy: { createdAt: 'desc' }, where: { isCurrent: true } },
          by: { field: 'data', path: ['title'] },
        },
      },
    } as never);
    const b = q.buildFindMany({
      orderBy: {
        versions: {
          pick: { orderBy: { createdAt: 'desc' }, where: { isCurrent: false } },
          by: { field: 'data', path: ['weight'] },
        },
      },
    } as never);
    assert.equal(a.sql, b.sql);
    assert.deepEqual(a.params, [['title'], true]);
    assert.deepEqual(b.params, [['weight'], false]);
  });

  it('by-shape, direction, nulls, pick.orderBy shape, and pick.where shape each change the SQL text', () => {
    const q = makeQuery('instances', schema());
    const base = q.buildFindMany({
      orderBy: { versions: { pick: { orderBy: { createdAt: 'desc' } }, by: 'title' } },
    } as never);
    const jsonBy = q.buildFindMany({
      orderBy: { versions: { pick: { orderBy: { createdAt: 'desc' } }, by: { field: 'data', path: ['t'] } } },
    } as never);
    const numericBy = q.buildFindMany({
      orderBy: {
        versions: { pick: { orderBy: { createdAt: 'desc' } }, by: { field: 'data', path: ['t'], type: 'numeric' } },
      },
    } as never);
    const desc = q.buildFindMany({
      orderBy: { versions: { pick: { orderBy: { createdAt: 'desc' } }, by: 'title', direction: 'desc' } },
    } as never);
    const nulls = q.buildFindMany({
      orderBy: { versions: { pick: { orderBy: { createdAt: 'desc' } }, by: 'title', nulls: 'last' } },
    } as never);
    const pickAsc = q.buildFindMany({
      orderBy: { versions: { pick: { orderBy: { createdAt: 'asc' } }, by: 'title' } },
    } as never);
    const pickWhere = q.buildFindMany({
      orderBy: {
        versions: { pick: { orderBy: { createdAt: 'desc' }, where: { isCurrent: true } }, by: 'title' },
      },
    } as never);
    const pickWhereNull = q.buildFindMany({
      orderBy: {
        versions: { pick: { orderBy: { createdAt: 'desc' }, where: { isCurrent: null } }, by: 'title' },
      },
    } as never);
    const texts = [base, jsonBy, numericBy, desc, nulls, pickAsc, pickWhere, pickWhereNull].map((d) => d.sql);
    assert.equal(new Set(texts).size, texts.length, `expected all distinct SQL texts:\n${texts.join('\n')}`);
  });

  it('a pick ordering never collides with a _count ordering on the same relation', () => {
    const q = makeQuery('instances', schema());
    const count = q.buildFindMany({ orderBy: { versions: { _count: 'desc' } } } as never);
    const pick = q.buildFindMany({
      orderBy: { versions: { pick: { orderBy: { createdAt: 'desc' } }, by: 'title' } },
    } as never);
    assert.notEqual(count.sql, pick.sql);
  });

  it('warmed cache still validates: a bad shape throws on the second call too', () => {
    const q = makeQuery('instances', schema());
    const good = {
      orderBy: { versions: { pick: { orderBy: { createdAt: 'desc' } }, by: 'title' } },
    } as never;
    q.buildFindMany(good); // warm
    assert.throws(
      () => q.buildFindMany({ orderBy: { tags: { pick: { orderBy: { label: 'asc' } }, by: 'label' } } } as never),
      /manyToMany/,
    );
  });
});

// ---------------------------------------------------------------------------
// Integration tests (require DATABASE_URL)
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL;
if (SKIP) {
  console.log('⚠ Skipping pick-row ordering integration tests: DATABASE_URL not set');
}

describe('pick-row relation ordering: integration', () => {
  const { it, before, after } = skipGate(SKIP, 'DATABASE_URL not set');
  let db: TurbineClient;
  let schemaMeta: SchemaMetadata;
  const PARENTS = '_pick_instances';
  const CHILDREN = '_pick_versions';

  before(async () => {
    const setup = new pg.Client({ connectionString: DATABASE_URL! });
    await setup.connect();
    try {
      await setup.query(`DROP TABLE IF EXISTS ${CHILDREN}`);
      await setup.query(`DROP TABLE IF EXISTS ${PARENTS}`);
      await setup.query(`CREATE TABLE ${PARENTS} (id serial PRIMARY KEY, name text NOT NULL)`);
      await setup.query(
        `CREATE TABLE ${CHILDREN} (
           id serial PRIMARY KEY,
           instance_id int NOT NULL REFERENCES ${PARENTS}(id),
           title text,
           data jsonb NOT NULL DEFAULT '{}',
           is_current boolean NOT NULL DEFAULT false,
           created_at timestamptz NOT NULL
         )`,
      );
      // Parent 1: newest version title "banana" (numeric rank 2)
      // Parent 2: newest version title "apple"  (numeric rank 3)
      // Parent 3: newest version title NULL     (numeric rank 1)
      // Parent 4: no versions at all → NULL key
      await setup.query(`INSERT INTO ${PARENTS} (name) VALUES ('p1'), ('p2'), ('p3'), ('p4')`);
      await setup.query(
        `INSERT INTO ${CHILDREN} (instance_id, title, data, is_current, created_at) VALUES
           (1, 'zebra',  '{"rank": 9}', false, '2024-01-01'),
           (1, 'banana', '{"rank": 2}', true,  '2024-03-01'),
           (2, 'apple',  '{"rank": 3}', true,  '2024-02-01'),
           (2, 'aardvark', '{"rank": 1}', false, '2024-01-15'),
           (3, NULL,     '{"rank": 1}', true,  '2024-04-01')`,
      );
    } finally {
      await setup.end();
    }
    schemaMeta = await introspect({ connectionString: DATABASE_URL! });
    // introspect discovers the FK → hasMany relation automatically.
    db = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 3 }, schemaMeta);
    await db.connect();
  });

  after(async () => {
    if (db) await db.disconnect();
    const teardown = new pg.Client({ connectionString: DATABASE_URL! });
    await teardown.connect();
    try {
      await teardown.query(`DROP TABLE IF EXISTS ${CHILDREN}`);
      await teardown.query(`DROP TABLE IF EXISTS ${PARENTS}`);
    } finally {
      await teardown.end();
    }
  });

  /** The hasMany relation name introspection assigns for _pick_versions.instance_id. */
  function versionsRelation(): string {
    const rels = schemaMeta.tables[PARENTS]?.relations ?? {};
    const name = Object.keys(rels).find((r) => rels[r]?.to === CHILDREN && rels[r]?.type === 'hasMany');
    assert.ok(name, `expected a hasMany relation to ${CHILDREN}, got: ${Object.keys(rels).join(', ')}`);
    return name!;
  }

  it('orders parents by the newest version title, NULLS LAST (missing rows sort last)', async () => {
    const rel = versionsRelation();
    const rows = (await db.table(PARENTS).findMany({
      orderBy: {
        [rel]: { pick: { orderBy: { createdAt: 'desc' } }, by: 'title', direction: 'asc', nulls: 'last' },
      },
    } as never)) as { name: string }[];
    // Newest titles: p1=banana, p2=apple, p3=NULL, p4=(no row → NULL).
    assert.deepEqual(rows.map((r) => r.name).slice(0, 2), ['p2', 'p1']);
    assert.deepEqual(new Set(rows.map((r) => r.name).slice(2)), new Set(['p3', 'p4']));
  });

  it('pick.where narrows to flagged rows; numeric JSON rank ordering', async () => {
    const rel = versionsRelation();
    const rows = (await db.table(PARENTS).findMany({
      where: { name: { in: ['p1', 'p2', 'p3'] } },
      orderBy: {
        [rel]: {
          pick: { orderBy: { createdAt: 'desc' }, where: { isCurrent: true } },
          by: { field: 'data', path: ['rank'], type: 'numeric' },
          direction: 'desc',
        },
      },
    } as never)) as { name: string }[];
    // Current-row ranks: p1=2, p2=3, p3=1 → desc: p2, p1, p3.
    assert.deepEqual(
      rows.map((r) => r.name),
      ['p2', 'p1', 'p3'],
    );
  });

  it('tie behavior: pick.orderBy decides which row supplies the key', async () => {
    const rel = versionsRelation();
    // Ascending created_at picks the OLDEST row: p1=zebra(9), p2=aardvark(1), p3=NULL-title rank 1.
    const rows = (await db.table(PARENTS).findMany({
      where: { name: { in: ['p1', 'p2'] } },
      orderBy: {
        [rel]: { pick: { orderBy: { createdAt: 'asc' } }, by: 'title', direction: 'asc' },
      },
    } as never)) as { name: string }[];
    assert.deepEqual(
      rows.map((r) => r.name),
      ['p2', 'p1'], // aardvark < zebra
    );
  });
});
