/**
 * Studio: the saved-query round trip, exercised rather than pattern-matched.
 *
 * The builder pane holds database COLUMN names (that is what the Data and
 * Schema tabs label a column with); a Turbine query addresses a column by its
 * camelCase FIELD name. When the emit side started translating to field names,
 * the loader was left translating in neither direction: it read every saved key
 * as a column name, so on any snake_case schema `hydrate` produced clauses
 * whose `column` matched nothing, and the emit side then DROPPED them. No
 * toast, no validation error, no console warning: a reloaded saved query simply
 * returned more rows than it did when it was saved. `orderBy` and `select` /
 * `omit` had the same mismatch, showing "(none)" and inactive chips while the
 * emitted args still carried them.
 *
 * That defect could not have been caught by the tests it shipped with, which
 * asserted that particular lines of JavaScript existed in the served HTML.
 * These tests instead extract the pure `builder-args` region out of the HTML
 * that is actually served and RUN it, so save -> disk -> load -> save is tested
 * as behaviour. `node:vm` on a delimited region of our own shipped source is the
 * only way to reach browser code from a Node test without adding a DOM
 * dependency, which the package's one-runtime-dependency rule forbids; it is
 * confined to this file and never used at runtime.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runInThisContext } from 'node:vm';
import { STUDIO_HTML } from '../cli/studio-ui.generated.js';

// ---------------------------------------------------------------------------
// Load the region under test out of the served HTML
// ---------------------------------------------------------------------------

const BEGIN = '// === BEGIN builder-args ===';
const END = '// === END builder-args ===';

interface Column {
  name: string;
  field: string;
  tsType: string;
}
interface Relation {
  name: string;
  to: string;
  type: string;
}
interface TableMeta {
  name: string;
  columns: Column[];
  relations?: Relation[];
}
interface WhereRow {
  column: string;
  op: string;
  value: unknown;
  insensitive: boolean;
}
interface LocalArgs {
  combinator: string;
  where: WhereRow[];
  with: Array<{ relation: string; expanded: boolean; args: LocalArgs }>;
  orderBy: { column: string | null; dir: string };
  limit: number | null;
  select: string[];
  omit: string[];
}
type FindTable = (name: string) => TableMeta | undefined;

interface Unresolved {
  kind: string;
  key: string;
  index?: number;
  path: string[];
}

interface BuilderArgsApi {
  fieldName(t: TableMeta, column: string): string;
  columnName(t: TableMeta, key: string): string | null;
  buildFindManyArgs(a: LocalArgs, t: TableMeta, findTable: FindTable): Record<string, unknown>;
  assembleWhere(a: LocalArgs, t: TableMeta): Record<string, unknown> | null;
  hydrate(args: Record<string, unknown>, t: TableMeta, findTable: FindTable, issues?: string[]): LocalArgs;
  unresolvedColumns(a: LocalArgs, t: TableMeta, findTable: FindTable, path?: string[]): Unresolved[];
  describeUnresolved(entry: Unresolved): string;
}

function loadBuilderArgs(): { BuilderArgs: BuilderArgsApi; emptyBuilderArgs: () => LocalArgs } {
  const start = STUDIO_HTML.indexOf(BEGIN);
  const end = STUDIO_HTML.indexOf(END);
  assert.ok(start !== -1 && end > start, 'builder-args region present in the served HTML');
  const source = STUDIO_HTML.slice(start, end);
  // `runInThisContext`, not `runInNewContext`: a new context is a new realm, so
  // every object the region builds would carry a foreign `Object.prototype` and
  // `assert.deepEqual` would reject values that are in fact equal. The region
  // is pure, so evaluating it here is safe, and a stray reference to
  // `document` / `State` / `window` still throws (Node has none of them).
  return runInThisContext(`${source}\n;({ BuilderArgs, emptyBuilderArgs })`) as {
    BuilderArgs: BuilderArgsApi;
    emptyBuilderArgs: () => LocalArgs;
  };
}

const { BuilderArgs, emptyBuilderArgs } = loadBuilderArgs();

// ---------------------------------------------------------------------------
// A snake_case schema, which is the population the defect covered: every table
// whose column spelling differs from its field spelling.
// ---------------------------------------------------------------------------

const USERS: TableMeta = {
  name: 'users',
  columns: [
    { name: 'id', field: 'id', tsType: 'number' },
    { name: 'email_address', field: 'emailAddress', tsType: 'string' },
    { name: 'created_at', field: 'createdAt', tsType: 'Date' },
    { name: 'is_active', field: 'isActive', tsType: 'boolean' },
  ],
  relations: [{ name: 'posts', to: 'posts', type: 'hasMany' }],
};

const POSTS: TableMeta = {
  name: 'posts',
  columns: [
    { name: 'id', field: 'id', tsType: 'number' },
    { name: 'author_id', field: 'authorId', tsType: 'number' },
    { name: 'published_at', field: 'publishedAt', tsType: 'Date' },
  ],
  relations: [],
};

const TABLES = new Map<string, TableMeta>([
  ['users', USERS],
  ['posts', POSTS],
]);
const findTable: FindTable = (name) => TABLES.get(name);

function paneArgs(overrides: Partial<LocalArgs> = {}): LocalArgs {
  return Object.assign(emptyBuilderArgs(), overrides);
}

/** Save, then load, then save again: the persisted form must be a fixed point. */
function roundTrip(local: LocalArgs, table: TableMeta): { saved: Record<string, unknown>; reloaded: LocalArgs } {
  const saved = BuilderArgs.buildFindManyArgs(local, table, findTable);
  const reloaded = BuilderArgs.hydrate(saved, table, findTable);
  const resaved = BuilderArgs.buildFindManyArgs(reloaded, table, findTable);
  assert.deepEqual(resaved, saved, 'the persisted args survive a load/save cycle unchanged');
  return { saved, reloaded };
}

// ---------------------------------------------------------------------------

describe('Studio saved queries: the builder round trip', () => {
  it('keeps a where clause on a snake_case column across save and reload', () => {
    const local = paneArgs({
      where: [{ column: 'created_at', op: 'gt', value: '2026-01-01', insensitive: false }],
      limit: 25,
    });
    const { saved, reloaded } = roundTrip(local, USERS);

    // What goes to disk (and to `/api/builder`, and into the Copy TS snippet)
    // is field-keyed, because that is the only spelling a Turbine query accepts.
    assert.deepEqual(saved.where, { createdAt: { gt: '2026-01-01' } });

    // And what comes back is a clause the pane can address: THE defect was that
    // this list came back empty-handed, because `createdAt` matched no column
    // and the next save dropped it.
    assert.equal(reloaded.where.length, 1, 'the where clause survived the reload');
    assert.equal(reloaded.where[0]?.column, 'created_at', 'resolved back to the database column name');
    assert.equal(reloaded.where[0]?.op, 'gt');
    assert.equal(reloaded.where[0]?.value, '2026-01-01');
    assert.equal(reloaded.limit, 25);
    assert.deepEqual(BuilderArgs.unresolvedColumns(reloaded, USERS, findTable), [], 'nothing left unresolved');
  });

  it('keeps orderBy, select and omit across save and reload', () => {
    const local = paneArgs({
      orderBy: { column: 'created_at', dir: 'desc' },
      select: ['id', 'email_address'],
      omit: [],
    });
    const { saved, reloaded } = roundTrip(local, USERS);
    assert.deepEqual(saved.orderBy, { createdAt: 'desc' });
    assert.deepEqual(saved.select, { id: true, emailAddress: true });
    // Rendering matches on the COLUMN name (the `<select>` options and the
    // chips are built from `column.name`), so a field name here renders as
    // "(none)" and as inactive chips while the query still sorts and projects.
    assert.deepEqual(reloaded.orderBy, { column: 'created_at', dir: 'desc' });
    assert.deepEqual(reloaded.select, ['id', 'email_address']);

    const omitLocal = paneArgs({ omit: ['created_at'] });
    const omitTrip = roundTrip(omitLocal, USERS);
    assert.deepEqual(omitTrip.saved.omit, { createdAt: true });
    assert.deepEqual(omitTrip.reloaded.omit, ['created_at']);
  });

  it('round-trips a nested with clause against the child table', () => {
    const child = paneArgs({
      where: [{ column: 'published_at', op: 'not', value: '2026-01-01', insensitive: false }],
      orderBy: { column: 'published_at', dir: 'asc' },
      limit: 5,
      select: ['author_id'],
    });
    const local = paneArgs({ with: [{ relation: 'posts', expanded: true, args: child }] });
    const { saved, reloaded } = roundTrip(local, USERS);

    const savedWith = (saved.with as Record<string, Record<string, unknown>>).posts ?? {};
    assert.deepEqual(savedWith.where, { publishedAt: { not: '2026-01-01' } });
    assert.deepEqual(savedWith.orderBy, { publishedAt: 'asc' });
    assert.deepEqual(savedWith.select, { authorId: true });

    const reloadedChild = reloaded.with[0];
    assert.equal(reloadedChild?.relation, 'posts');
    assert.equal(reloadedChild?.args.where[0]?.column, 'published_at');
    assert.deepEqual(reloadedChild?.args.orderBy, { column: 'published_at', dir: 'asc' });
    assert.deepEqual(reloadedChild?.args.select, ['author_id']);
    assert.deepEqual(BuilderArgs.unresolvedColumns(reloaded, USERS, findTable), []);
  });

  it('round-trips the combinators and the null operators', () => {
    for (const combinator of ['AND', 'OR', 'NOT']) {
      const local = paneArgs({
        combinator,
        where: [
          { column: 'created_at', op: 'isNull', value: '', insensitive: false },
          { column: 'email_address', op: 'contains', value: 'a@b', insensitive: true },
        ],
      });
      const { reloaded } = roundTrip(local, USERS);
      assert.equal(reloaded.combinator, combinator, `${combinator} preserved`);
      assert.deepEqual(
        reloaded.where.map((w) => [w.column, w.op, w.insensitive]),
        [
          ['created_at', 'isNull', false],
          ['email_address', 'contains', true],
        ],
        `${combinator} clauses preserved`,
      );
    }
  });

  it('round-trips an in / notIn list without turning it into an array literal', () => {
    const local = paneArgs({
      where: [{ column: 'id', op: 'in', value: '1, 2, 3', insensitive: false }],
    });
    const { saved, reloaded } = roundTrip(local, USERS);
    assert.deepEqual(saved.where, { id: { in: [1, 2, 3] } });
    // The pane's input is a comma-separated string, so hydrate has to hand one
    // back or the next save re-splits `String([1,2,3])` by luck.
    assert.equal(reloaded.where[0]?.value, '1,2,3');
  });

  it('still loads saved files written in the older column-keyed shape', () => {
    // `.turbine/studio-queries.json` files exist on disk from before the emit
    // side moved to field names. They must keep loading, not become the
    // unresolved-key case.
    const legacy = {
      where: { created_at: { gt: '2026-01-01' } },
      orderBy: { created_at: 'desc' },
      select: { id: true, email_address: true },
      with: { posts: { where: { published_at: null } } },
      limit: 10,
    };
    const issues: string[] = [];
    const reloaded = BuilderArgs.hydrate(legacy, USERS, findTable, issues);
    assert.deepEqual(issues, [], 'a legacy column-keyed file resolves cleanly');
    assert.equal(reloaded.where[0]?.column, 'created_at');
    assert.deepEqual(reloaded.orderBy, { column: 'created_at', dir: 'desc' });
    assert.deepEqual(reloaded.select, ['id', 'email_address']);
    assert.equal(reloaded.with[0]?.args.where[0]?.column, 'published_at');
    // Loading normalizes it: the next save writes the field-keyed form.
    assert.deepEqual(BuilderArgs.buildFindManyArgs(reloaded, USERS, findTable).where, {
      createdAt: { gt: '2026-01-01' },
    });
  });
});

describe('Studio saved queries: an unresolvable key is visible, never swallowed', () => {
  it('reports a where key that names no column, and keeps the clause', () => {
    const stale = { where: { deletedAt: { not: null } }, limit: 10 };
    const issues: string[] = [];
    const reloaded = BuilderArgs.hydrate(stale, USERS, findTable, issues);
    assert.equal(issues.length, 1, 'the load reported the unresolved key');
    assert.match(issues[0] ?? '', /deletedAt/);
    assert.match(issues[0] ?? '', /users/);
    // Kept as written, so the user can see and fix it. Dropping it is the
    // failure mode: the query would then run without the predicate.
    assert.equal(reloaded.where.length, 1);
    assert.equal(reloaded.where[0]?.column, 'deletedAt');

    const unresolved = BuilderArgs.unresolvedColumns(reloaded, USERS, findTable);
    assert.equal(unresolved.length, 1, 'validate() sees it, so Run and Save are refused');
    assert.equal(unresolved[0]?.kind, 'where');
    assert.match(BuilderArgs.describeUnresolved(unresolved[0] as Unresolved), /unknown column "deletedAt"/);
  });

  it('emits an unresolvable where key instead of quietly dropping the clause', () => {
    const local = paneArgs({
      where: [{ column: 'deleted_at', op: 'equals', value: 'x', insensitive: false }],
    });
    const where = BuilderArgs.assembleWhere(local, USERS);
    assert.deepEqual(where, { deleted_at: 'x' }, 'the clause reaches the args, where the server rejects it');
  });

  it('reports unresolved keys in orderBy, select, omit and nested relations', () => {
    const issues: string[] = [];
    const reloaded = BuilderArgs.hydrate(
      {
        orderBy: { goneAway: 'asc' },
        select: { nope: true },
        omit: { alsoNope: true },
        with: { posts: { where: { missingCol: 1 } }, ghosts: true },
      },
      USERS,
      findTable,
      issues,
    );
    assert.equal(issues.length, 5, issues.join(' | '));
    assert.ok(
      issues.some((m) => m.includes('goneAway')) &&
        issues.some((m) => m.includes('nope')) &&
        issues.some((m) => m.includes('alsoNope')) &&
        issues.some((m) => m.includes('posts.where') && m.includes('missingCol')) &&
        issues.some((m) => m.includes('ghosts')),
      issues.join(' | '),
    );
    const unresolved = BuilderArgs.unresolvedColumns(reloaded, USERS, findTable);
    assert.deepEqual(
      unresolved.map((u) => `${u.path.join('.')}:${u.kind}:${u.key}`).sort(),
      [':omit:alsoNope', ':orderBy:goneAway', ':select:nope', 'posts:where:missingCol'],
      'every one of them also blocks Run and Save',
    );
  });

  it('resolves the field spelling first, so a column named like another column field cannot shadow it', () => {
    const tricky: TableMeta = {
      name: 'tricky',
      columns: [
        { name: 'user_id', field: 'userId', tsType: 'number' },
        { name: 'userId', field: 'userid', tsType: 'number' },
      ],
      relations: [],
    };
    // `userId` is the FIELD of `user_id` and also the literal NAME of another
    // column. The saved form is field-keyed, so the field wins.
    assert.equal(BuilderArgs.columnName(tricky, 'userId'), 'user_id');
    assert.equal(BuilderArgs.columnName(tricky, 'userid'), 'userId');
    assert.equal(BuilderArgs.columnName(tricky, 'user_id'), 'user_id');
    assert.equal(BuilderArgs.columnName(tricky, 'absent'), null);
  });
});

// ---------------------------------------------------------------------------
// Two clauses on ONE column under AND
// ---------------------------------------------------------------------------

describe('studio builder: AND does not swallow a repeated column', () => {
  // `Object.assign({}, ...clauses)` merges by key, so the later clause on the
  // same column overwrote the earlier one. The pane showed two filters and the
  // query carried one, which is the same silent-narrowing class as the dropped
  // clauses this file was written for: no toast, no validation error, just
  // more rows than the builder said.
  const range = paneArgs({
    combinator: 'AND',
    where: [
      { column: 'id', op: 'gte', value: '18', insensitive: false },
      { column: 'id', op: 'lte', value: '65', insensitive: false },
    ],
  });

  it('emits both bounds instead of the last one', () => {
    const where = BuilderArgs.assembleWhere(range, USERS);
    assert.deepEqual(where, { AND: [{ id: { gte: 18 } }, { id: { lte: 65 } }] });
  });

  it('survives the save / load / save round trip', () => {
    const { saved, reloaded } = roundTrip(range, USERS);
    assert.deepEqual(saved.where, { AND: [{ id: { gte: 18 } }, { id: { lte: 65 } }] });
    assert.equal(reloaded.where.length, 2, 'both clauses must come back into the pane');
    assert.deepEqual(
      reloaded.where.map((c) => c.op),
      ['gte', 'lte'],
    );
  });

  it('three clauses on one column all survive', () => {
    const where = BuilderArgs.assembleWhere(
      paneArgs({
        combinator: 'AND',
        where: [
          { column: 'email_address', op: 'contains', value: 'a', insensitive: false },
          { column: 'email_address', op: 'endsWith', value: '.com', insensitive: false },
          { column: 'email_address', op: 'not', value: 'x@y.com', insensitive: false },
        ],
      }),
      USERS,
    ) as { AND: unknown[] };
    assert.equal(where.AND.length, 3);
  });

  it('distinct columns keep the flat shape, so nothing else moved', () => {
    const where = BuilderArgs.assembleWhere(
      paneArgs({
        combinator: 'AND',
        where: [
          { column: 'id', op: 'gte', value: '18', insensitive: false },
          { column: 'is_active', op: 'equals', value: 'true', insensitive: false },
        ],
      }),
      USERS,
    );
    assert.deepEqual(where, { id: { gte: 18 }, isActive: true });
  });
});
