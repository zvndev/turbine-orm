/**
 * turbine-orm — three-way relation-strategy equivalence: join / batched / flatten
 *
 * The documented guarantee is that a relation-loading strategy changes the PLAN,
 * never the RESULT. `'flatten'` compiles an eligible to-one relation to a LEFT
 * JOIN over a provably-unique key and assembles the object client-side, so it
 * has to survive exactly the shapes that make joins dangerous: a null FK, a
 * relation that matches nothing, a to-many hanging off a to-one, per-relation
 * `select`/`where`, `_count` alongside, a self-relation, and a three-level
 * chain. Each is run under all three strategies and deep-compared.
 *
 * It also pins the FAN-OUT regression: a to-one relation whose target key is not
 * provably unique must fall back to the correlated subquery rather than joining
 * and silently duplicating parent rows.
 *
 * The suite owns its own `flatten_*` tables (created in `before`, dropped in
 * `after`) because the shared fixture in fixtures/seed.sql has no nullable FK,
 * no self-relation and no unique-FK hasOne, and its column counts are asserted
 * by other suites so it must not be extended here.
 *
 * Run: DATABASE_URL=postgres://... npx tsx --test src/test/flatten-parity.integration.test.ts
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { introspect } from '../introspect.js';
import type { SchemaMetadata } from '../schema.js';
import { skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL;
if (SKIP) {
  console.log('⚠ Skipping flatten parity integration tests: DATABASE_URL not set');
}

const DDL = `
DROP TABLE IF EXISTS flatten_items CASCADE;
DROP TABLE IF EXISTS flatten_prices CASCADE;
DROP TABLE IF EXISTS flatten_profiles CASCADE;
DROP TABLE IF EXISTS flatten_people CASCADE;
DROP TABLE IF EXISTS flatten_teams CASCADE;
DROP TABLE IF EXISTS flatten_regions CASCADE;

CREATE TABLE flatten_regions (
  id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code    TEXT NOT NULL,
  label   TEXT
);
CREATE TABLE flatten_teams (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  region_id  BIGINT REFERENCES flatten_regions(id),
  name       TEXT NOT NULL,
  budget     DOUBLE PRECISION,
  opened_at  TIMESTAMPTZ,
  archived   BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE flatten_people (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  team_id    BIGINT REFERENCES flatten_teams(id),
  manager_id BIGINT REFERENCES flatten_people(id),
  name       TEXT NOT NULL,
  joined_at  TIMESTAMPTZ
);
CREATE INDEX idx_flatten_people_team ON flatten_people(team_id);
CREATE INDEX idx_flatten_people_manager ON flatten_people(manager_id);
CREATE TABLE flatten_profiles (
  id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  person_id BIGINT NOT NULL UNIQUE REFERENCES flatten_people(id),
  bio       TEXT
);
CREATE TABLE flatten_prices (
  id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  amount NUMERIC(12,2) NOT NULL
);
CREATE TABLE flatten_items (
  id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  person_id BIGINT NOT NULL REFERENCES flatten_people(id),
  price_id  BIGINT REFERENCES flatten_prices(id),
  label     TEXT NOT NULL,
  qty       INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_flatten_items_person ON flatten_items(person_id);

INSERT INTO flatten_regions (code, label) VALUES ('eu', 'Europe'), ('na', NULL);
INSERT INTO flatten_teams (region_id, name, budget, opened_at, archived) VALUES
  (1, 'Platform', 1000.50, NOW() - INTERVAL '30 days', FALSE),
  (2, 'Growth',   NULL,    NULL,                        FALSE),
  (NULL, 'Orphan Team', 0.00, NOW(), TRUE);
-- person 3 has a NULL team_id (null-FK relation), person 1 manages 2 and 3.
INSERT INTO flatten_people (team_id, manager_id, name, joined_at) VALUES
  (1, NULL, 'Ada',  NOW() - INTERVAL '10 days'),
  (1, 1,    'Brie', NOW() - INTERVAL '9 days'),
  (NULL, 1, 'Cy',   NULL),
  (2, 2,    'Dev',  NOW() - INTERVAL '7 days'),
  (3, NULL, 'Edu',  NOW() - INTERVAL '6 days');
-- Only some people have a profile (hasOne over a UNIQUE FK).
INSERT INTO flatten_profiles (person_id, bio) VALUES (1, 'builds things'), (4, NULL);
INSERT INTO flatten_prices (amount) VALUES (1000.50), (0.01);
INSERT INTO flatten_items (person_id, price_id, label, qty) VALUES
  (1, 1, 'laptop', 1), (1, 2, 'badge', 2), (2, NULL, 'laptop', 1), (4, 1, 'monitor', 3);
`;

let db: TurbineClient;
let schema: SchemaMetadata;

const { it, before, after } = skipGate(SKIP, 'DATABASE_URL not set');

/** Run one raw statement on a throwaway pg client (DDL, outside the ORM). */
async function withRawClient(fn: (c: pg.Client) => Promise<unknown>): Promise<void> {
  const client = new pg.Client({ connectionString: DATABASE_URL! });
  await client.connect();
  try {
    await fn(client);
  } finally {
    await client.end();
  }
}

describe('relation strategy equivalence: join / batched / flatten', () => {
  before(async () => {
    await withRawClient((c) => c.query(DDL));

    schema = await introspect({ connectionString: DATABASE_URL! });
    db = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 5, warnOnUnlimited: false }, schema);
    await db.connect();
  });

  after(async () => {
    if (db) await db.disconnect();
    if (!SKIP) {
      await withRawClient((c) =>
        c.query(
          'DROP TABLE IF EXISTS flatten_items, flatten_prices, flatten_profiles, flatten_people, flatten_teams, flatten_regions CASCADE',
        ),
      );
    }
  });

  /**
   * Run `args` under all three strategies and assert byte-identical output.
   * Compared with both deepEqual (Date identity, key presence) and a JSON
   * round-trip (key ORDER, which deepEqual ignores).
   */
  async function assertThreeWay(table: string, args: Record<string, unknown>): Promise<unknown[]> {
    const join = await db.table(table).findMany({ ...args, relationLoadStrategy: 'join' } as never);
    const flatten = await db.table(table).findMany({ ...args, relationLoadStrategy: 'flatten' } as never);
    const batched = await db.table(table).findMany({ ...args, relationLoadStrategy: 'batched' } as never);
    const label = `${table} ${JSON.stringify(args)}`;
    assert.deepEqual(flatten, join, `flatten must equal join for ${label}`);
    assert.deepEqual(batched, join, `batched must equal join for ${label}`);
    assert.equal(JSON.stringify(flatten), JSON.stringify(join), `flatten key order must match join for ${label}`);
    return flatten as unknown[];
  }

  it('belongsTo with a NULL foreign key assembles as null under all three', async () => {
    const rows = await assertThreeWay('flatten_people', {
      orderBy: { id: 'asc' },
      with: { flattenTeam: true },
    });
    // Cy has no team: the join matched nothing and must be null, not an object
    // of all-NULL columns.
    const cy = rows.find((r) => (r as { name: string }).name === 'Cy') as Record<string, unknown>;
    assert.equal(cy.flattenTeam, null);
    const ada = rows.find((r) => (r as { name: string }).name === 'Ada') as Record<string, unknown>;
    assert.ok(ada.flattenTeam, 'Ada has a team');
  });

  it('hasOne over a UNIQUE fk: matched and unmatched parents', async () => {
    const rows = await assertThreeWay('flatten_people', {
      orderBy: { id: 'asc' },
      with: { flattenProfile: true },
    });
    const withProfile = rows.filter((r) => (r as Record<string, unknown>).flattenProfile !== null);
    assert.equal(withProfile.length, 2, 'exactly two people have a profile');
  });

  it('a to-one whose every projected column is NULL is an object, not null', async () => {
    // Team "Growth" has NULL budget and NULL opened_at; region "na" has a NULL
    // label. Only the discriminator can tell these apart from "no row".
    const rows = await assertThreeWay('flatten_people', {
      where: { name: 'Dev' },
      with: { flattenTeam: { select: { budget: true, openedAt: true } } },
    });
    assert.deepEqual((rows[0] as Record<string, unknown>).flattenTeam, { budget: null, openedAt: null });
  });

  it('three-level to-one chain', async () => {
    await assertThreeWay('flatten_items', {
      orderBy: { id: 'asc' },
      with: { flattenPeople: { with: { flattenTeam: { with: { flattenRegion: true } } } } },
    });
  });

  it('self-relation (manager)', async () => {
    await assertThreeWay('flatten_people', {
      orderBy: { id: 'asc' },
      with: { flattenPeople: { with: { flattenPeople: true } } },
    });
  });

  it('to-many nested under a to-one', async () => {
    await assertThreeWay('flatten_items', {
      orderBy: { id: 'asc' },
      with: { flattenPeople: { with: { flattenItems: { orderBy: { id: 'asc' } } } } },
    });
  });

  it('relation select narrows the same columns', async () => {
    await assertThreeWay('flatten_people', {
      orderBy: { id: 'asc' },
      with: { flattenTeam: { select: { name: true } } },
    });
  });

  it('relation omit drops the same columns', async () => {
    await assertThreeWay('flatten_people', {
      orderBy: { id: 'asc' },
      with: { flattenTeam: { omit: { budget: true } } },
    });
  });

  it('relation where: non-matching relations null out, parents survive', async () => {
    const rows = await assertThreeWay('flatten_people', {
      orderBy: { id: 'asc' },
      with: { flattenTeam: { where: { archived: false } } },
    });
    assert.equal(rows.length, 5, 'every parent row survives a relation filter');
    // Edu is on the archived team, so the relation nulls out but Edu remains.
    const edu = rows.find((r) => (r as { name: string }).name === 'Edu') as Record<string, unknown>;
    assert.equal(edu.flattenTeam, null);
  });

  it('relation orderBy falls back and still matches', async () => {
    await assertThreeWay('flatten_people', {
      orderBy: { id: 'asc' },
      with: { flattenTeam: { orderBy: { name: 'asc' } } },
    });
  });

  it('_count alongside a flattened relation', async () => {
    await assertThreeWay('flatten_people', {
      orderBy: { id: 'asc' },
      with: { flattenTeam: true, _count: { flattenItems: true } },
    });
  });

  it('mixed clause: to-one flattened, to-many still a subquery', async () => {
    await assertThreeWay('flatten_people', {
      orderBy: { id: 'asc' },
      with: { flattenTeam: true, flattenItems: { orderBy: { id: 'asc' } } },
    });
  });

  it('parent where + orderBy + pagination over a join', async () => {
    // The parent's WHERE/ORDER BY reference columns UNQUALIFIED; the flattened
    // join must not put a colliding `name`/`id` in scope (it exposes only
    // prefixed names). And the join key is unique, so LIMIT/OFFSET still count
    // parent rows.
    const rows = await assertThreeWay('flatten_people', {
      where: { name: { not: 'nobody' } },
      orderBy: { id: 'asc' },
      limit: 3,
      offset: 1,
      with: { flattenTeam: true },
    });
    assert.equal(rows.length, 3);
  });

  it('parent where naming a column the joined table also has', async () => {
    // `flatten_people.name` and `flatten_teams.name` collide by name — the
    // ambiguity regression this strategy has to be immune to.
    await assertThreeWay('flatten_people', {
      where: { name: 'Ada' },
      with: { flattenTeam: true },
    });
  });

  it('FAN-OUT REGRESSION: a non-unique to-one key never joins', async () => {
    // `flatten_items.person_id` is NOT unique (Ada has two items), so the
    // reverse hasOne cannot be flattened. Force the shape by asking for the
    // relation from the person side as a to-many and confirming the row count
    // of the PARENT set is untouched under flatten.
    const flat = (await db.table('flatten_people').findMany({
      orderBy: { id: 'asc' },
      with: { flattenItems: { orderBy: { id: 'asc' } } },
      relationLoadStrategy: 'flatten',
    } as never)) as unknown[];
    assert.equal(flat.length, 5, 'flatten must not multiply parent rows');
    const join = await db.table('flatten_people').findMany({
      orderBy: { id: 'asc' },
      with: { flattenItems: { orderBy: { id: 'asc' } } },
      relationLoadStrategy: 'join',
    } as never);
    assert.deepEqual(flat, join);
  });

  it('the emitted plan really is a join, not a correlated subquery', async () => {
    const plan = (
      await db.table('flatten_people').explain({
        with: { flattenTeam: true },
        relationLoadStrategy: 'flatten',
      } as never)
    ).join('\n');
    assert.match(plan, /Join/i, `expected a join node in:\n${plan}`);
    assert.doesNotMatch(plan, /SubPlan/i, `expected no correlated SubPlan in:\n${plan}`);
  });

  it('parent select / omit narrows only the parent projection', async () => {
    await assertThreeWay('flatten_people', {
      orderBy: { id: 'asc' },
      select: { id: true, name: true },
      with: { flattenTeam: true },
    });
    await assertThreeWay('flatten_people', {
      orderBy: { id: 'asc' },
      omit: { joinedAt: true },
      with: { flattenTeam: true },
    });
  });

  it('stableRelationOrder is honored under flatten', async () => {
    await assertThreeWay('flatten_people', {
      orderBy: { id: 'asc' },
      stableRelationOrder: true,
      with: { flattenTeam: true, flattenItems: true },
    });
  });

  it('cursor pagination alongside a flattened relation', async () => {
    await assertThreeWay('flatten_people', {
      orderBy: { id: 'asc' },
      cursor: { id: 1 },
      limit: 2,
      with: { flattenTeam: true },
    });
  });

  it('relation _count ordering stays in scope beside a flattened join', async () => {
    // The `_count` order term is a correlated subquery that references the
    // parent table BY NAME; the added join must not push it out of scope.
    await assertThreeWay('flatten_people', {
      orderBy: { flattenItems: { _count: 'desc' }, id: 'asc' },
      with: { flattenTeam: true },
    });
  });

  it('to-one relation ordering stays in scope beside a flattened join', async () => {
    await assertThreeWay('flatten_people', {
      orderBy: { flattenTeam: { name: 'asc' }, id: 'asc' },
      with: { flattenTeam: true },
    });
  });

  it('a `numeric` column reads identically on all three strategies', async () => {
    // Was a KNOWN GAP until the JSON-wire fidelity fix: `json_build_object`
    // renders a Postgres `numeric` as a JSON NUMBER, so `join` returned the
    // lossy double 1000.5 while `batched`, `flatten` and a top-level read all
    // returned the driver's lossless '1000.50'. `join` now casts the column to
    // text in the JSON and decodes it with the driver's own numeric parser, so
    // all three agree with each other and with a top-level read. Full
    // type-by-type coverage lives in relation-value-fidelity.integration.test.ts.
    const args = { orderBy: { id: 'asc' }, with: { flattenPrice: true } };
    const join = (await db
      .table('flatten_items')
      .findMany({ ...args, relationLoadStrategy: 'join' } as never)) as Record<string, unknown>[];
    const flatten = (await db
      .table('flatten_items')
      .findMany({ ...args, relationLoadStrategy: 'flatten' } as never)) as Record<string, unknown>[];
    const batched = (await db
      .table('flatten_items')
      .findMany({ ...args, relationLoadStrategy: 'batched' } as never)) as Record<string, unknown>[];

    assert.deepEqual(flatten, batched, 'flatten must match batched exactly');
    assert.deepEqual(join, batched, 'join must match batched exactly');
    for (const [name, rows] of [
      ['join', join],
      ['flatten', flatten],
      ['batched', batched],
    ] as const) {
      const amount = (rows[0]!.flattenPrice as Record<string, unknown>).amount;
      assert.equal(typeof amount, 'string', `${name} must not hand back a double`);
      assert.equal(amount, '1000.50', name);
      assert.equal(rows[2]!.flattenPrice, null, `${name}: null relation`);
    }
  });

  it('flatten participates in a transaction', async () => {
    await db.$transaction(async (tx) => {
      const join = await tx
        .table('flatten_people')
        .findMany({ orderBy: { id: 'asc' }, with: { flattenTeam: true }, relationLoadStrategy: 'join' } as never);
      const flatten = await tx
        .table('flatten_people')
        .findMany({ orderBy: { id: 'asc' }, with: { flattenTeam: true }, relationLoadStrategy: 'flatten' } as never);
      assert.deepEqual(flatten, join);
    });
  });

  it('findManyStream yields the same rows under flatten', async () => {
    const streamed: unknown[] = [];
    for await (const row of db.table('flatten_people').findManyStream({
      orderBy: { id: 'asc' },
      with: { flattenTeam: true },
      batchSize: 2,
      relationLoadStrategy: 'flatten',
    } as never)) {
      streamed.push(row);
    }
    const join = await db
      .table('flatten_people')
      .findMany({ orderBy: { id: 'asc' }, with: { flattenTeam: true }, relationLoadStrategy: 'join' } as never);
    assert.deepEqual(streamed, join);
  });
});
