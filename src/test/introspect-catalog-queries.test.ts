/**
 * turbine-orm, catalog-read determinism (no database required)
 *
 * `turbine generate` writes files that people commit and diff. That only works
 * if introspection is a function of the SCHEMA and nothing else. Two properties
 * carry that guarantee, both of them living in SQL text where no other test can
 * see them, and both of them silently violable:
 *
 *   1. EVERY catalog query must impose a total ORDER. Without one Postgres may
 *      return rows in any order it likes, and it changes its mind: a `DROP INDEX`
 *      + `CREATE INDEX` of an unchanged index, or a VACUUM FULL, permutes
 *      `pg_indexes`. Those rows land in metadata.ts as ARRAYS, so the generated
 *      file churns between a developer's machine and CI for no schema change.
 *   2. The foreign-key query must order by NAME, never by `con.oid`. An OID is
 *      allocation order, so ordering by it encodes the order the DDL happened to
 *      run in, and the FK walk order decides which relation wins a contested
 *      name (see the ordering suite below, which pins that dependency). A
 *      database restored from a dump then disagreed with one built by replaying
 *      the migrations, on relation NAMES and CARDINALITY.
 *
 * The FK query must also filter to DECLARED constraints (`conparentid = 0`),
 * because one foreign key against a partitioned table materializes an extra
 * catalog row per partition, each of which introspected as its own belongsTo.
 *
 * These are asserted against the SQL SOURCE TEXT deliberately. The rules cannot
 * be reached through any exported function (the queries are module-private
 * template literals executed against a pool the introspector opens itself), and
 * a test that needs a live PostgreSQL to notice a dropped ORDER BY is a test
 * that does not run on most changes. The live proof lives alongside this, in
 * introspect-foreign-keys.integration.test.ts.
 *
 * Run: npx tsx --test src/test/introspect-catalog-queries.test.ts
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildRelationsFromForeignKeys, type ForeignKeyEntry } from '../introspect.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const introspectSrc = readFileSync(resolve(repoRoot, 'src/introspect.ts'), 'utf-8');
const mcpSrc = readFileSync(resolve(repoRoot, 'src/cli/mcp.ts'), 'utf-8');

/**
 * Every `const SQL_NAME = \`...\`` in introspect.ts, as { name, body }. Anchored
 * on the declaration so the surrounding prose (which quotes SQL fragments at
 * length) is never mistaken for a query.
 */
function catalogQueries(source: string): { name: string; body: string }[] {
  const found: { name: string; body: string }[] = [];
  const re = /^const (SQL_[A-Z_]+) = `([\s\S]*?)`;$/gm;
  for (let m = re.exec(source); m !== null; m = re.exec(source)) {
    found.push({ name: m[1]!, body: m[2]! });
  }
  return found;
}

describe('introspection catalog queries are deterministically ordered', () => {
  const queries = catalogQueries(introspectSrc);

  it('finds every SQL_ constant (guards the matcher itself)', () => {
    // A matcher that silently found nothing would make every assertion below
    // vacuously true, which is the failure mode this whole file exists to stop.
    const names = queries.map((q) => q.name).sort();
    assert.deepStrictEqual(names, [
      'SQL_CHECKS',
      'SQL_COLUMNS',
      'SQL_ENUMS',
      'SQL_FOREIGN_KEYS',
      'SQL_INDEXES',
      'SQL_MATVIEWS',
      'SQL_MATVIEW_COLUMNS',
      'SQL_PRIMARY_KEYS',
      'SQL_TABLES',
      'SQL_UNIQUE_CONSTRAINTS',
      'SQL_VIEWS',
    ]);
  });

  it('gives every catalog query an ORDER BY', () => {
    for (const { name, body } of queries) {
      assert.match(body, /\bORDER BY\b/, `${name} has no ORDER BY, so its rows arrive in physical catalog order`);
    }
  });

  it('orders the foreign-key query by name rather than by OID', () => {
    const fk = queries.find((q) => q.name === 'SQL_FOREIGN_KEYS')!;
    assert.match(fk.body, /ORDER BY\s+src\.relname,\s*con\.conname,\s*sk\.ord/);
    assert.doesNotMatch(fk.body, /ORDER BY\s+con\.oid/, 'con.oid is allocation order, not schema order');
  });

  it('reads only DECLARED foreign-key constraints', () => {
    const fk = queries.find((q) => q.name === 'SQL_FOREIGN_KEYS')!;
    assert.match(fk.body, /con\.conparentid = 0/, 'partition-clone constraints introspect as phantom relations');
  });
});

/**
 * `turbine mcp` reads the catalog through its own copy of these queries (it runs
 * inside its own read-only transaction rather than the pool `introspect()`
 * opens), and its schema tools have to describe the same relations the generated
 * client exposes. A rule enforced on one copy and not the other is not enforced.
 */
describe('the MCP server reads the catalog under the same rules', () => {
  it('orders its foreign-key query by name and reads only declared constraints', () => {
    const fkQuery = mcpSrc.slice(mcpSrc.indexOf('con.oid::text AS constraint_oid'));
    assert.match(fkQuery.slice(0, 2000), /ORDER BY src\.relname, con\.conname, sk\.ord/);
    assert.match(fkQuery.slice(0, 2000), /con\.conparentid = 0/);
  });

  it('orders its index query', () => {
    const indexQuery = /SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = \$1[^`]*/.exec(mcpSrc);
    assert.ok(indexQuery, 'MCP index query not found, update this test');
    assert.match(indexQuery[0], /ORDER BY tablename, indexname/);
  });
});

// ---------------------------------------------------------------------------
// WHY the ordering above is load-bearing rather than cosmetic
// ---------------------------------------------------------------------------

/**
 * `buildRelationsFromForeignKeys` walks its FK list in order, accumulating the
 * names it has taken, so the FIRST foreign key to want a contested name keeps it
 * and the later one is renamed. That is a deliberate design (legacy-first
 * naming), and it is exactly why the ORDER of the list is a correctness input
 * rather than a detail: the ONLY thing standing between it and non-deterministic
 * output is the catalog query's ORDER BY.
 *
 * This suite pins the dependency so that a future refactor which makes the
 * builder order-INSENSITIVE (a fine thing to do) fails here and tells the reader
 * that the SQL ordering rule can be relaxed, rather than leaving it as folklore.
 */
describe('relation naming depends on foreign-key walk order', () => {
  const users = new Map<string, Set<string>>([
    ['users', new Set(['id'])],
    ['profiles', new Set(['id', 'userId'])],
    ['profile', new Set(['id', 'userId'])],
  ]);
  // profiles.user_id is UNIQUE, so its reverse side is a hasOne named with the
  // singular of the child table: `profile`. The `profile` table's plain FK wants
  // the very same name for its hasMany. One of them must be renamed.
  const uniqueSets = new Map<string, string[][]>([['profiles', [['user_id']]]]);
  const fk = (sourceTable: string): ForeignKeyEntry => ({
    sourceTable,
    sourceColumns: ['user_id'],
    targetTable: 'users',
    targetColumns: ['id'],
    constraintName: `${sourceTable}_user_id_fkey`,
  });

  /** Suppress the collision-rename warning, which is by design. */
  function silenced<T>(fn: () => T): T {
    const original = console.warn;
    console.warn = () => {};
    try {
      return fn();
    } finally {
      console.warn = original;
    }
  }

  const namesFor = (order: ForeignKeyEntry[]) => {
    const rels = silenced(() => buildRelationsFromForeignKeys(order, users, undefined, undefined, uniqueSets));
    return Object.entries(rels.get('users') ?? {})
      .map(([name, def]) => `${name}:${def.type}->${def.to}`)
      .sort();
  };

  it('resolves a contested name differently for two different walk orders', () => {
    const uniqueFirst = namesFor([fk('profiles'), fk('profile')]);
    const plainFirst = namesFor([fk('profile'), fk('profiles')]);

    // Both orders are internally consistent; they simply disagree, which is the
    // whole point. `users.profile` is a hasOne on `profiles` in one and a hasMany
    // on `profile` in the other, so the same relation name reads a different
    // table with a different shape.
    assert.deepStrictEqual(uniqueFirst, ['profile:hasOne->profiles', 'profileRel:hasMany->profile']);
    assert.deepStrictEqual(plainFirst, ['profile:hasMany->profile', 'profiles:hasOne->profiles']);
    assert.notDeepStrictEqual(
      uniqueFirst,
      plainFirst,
      'if this ever passes, the builder became order-insensitive and the SQL ORDER BY rule can be revisited',
    );
  });
});
