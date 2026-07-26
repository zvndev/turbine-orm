/**
 * turbine-orm/powdb, entity-links round (PowDB >= 0.19.1) build-only unit tests.
 *
 * Covers the link lane that does NOT need a live engine: the patch-aware
 * capability gates, `describe` link-row filtering, `schema links` -> relations
 * mapping, `emitLinks` DDL shapes + skips, scalar link-path query-generation
 * gating (no capability -> byte-identical PowQL; capability without a declared
 * link -> loader fallback), and the two 0.19.1 hard-error mappings. The live
 * end-to-end + parity assertions live in powdb.integration.test.ts.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TurbineErrorCode, UnsupportedFeatureError, ValidationError } from '../errors.js';
import {
  ALL_POWDB_CAPABILITIES,
  applyPowdbLinks,
  capabilitiesFromVersion,
  deriveDesiredLinks,
  introspectPowdbDatabase,
  type PowdbCapabilities,
  type PowdbExec,
  type PowdbPool,
  powdbLinkStatement,
  powqlSchemaDDL,
  requireCapability,
  wrapPowdbError,
} from '../powdb.js';
import { PowqlInterface } from '../powql.js';
import { resetWarnOnce, WARN_NS } from '../query/warn-registry.js';
import type { ColumnMetadata, RelationDef, SchemaMetadata, TableMetadata } from '../schema.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function col(
  name: string,
  field: string,
  tsType: string,
  pgType: string,
  opts: Partial<ColumnMetadata> = {},
): ColumnMetadata {
  return { name, field, pgType, tsType, nullable: false, hasDefault: false, isArray: false, pgArrayType: '', ...opts };
}

function table(name: string, columns: ColumnMetadata[], relations: Record<string, RelationDef> = {}): TableMetadata {
  const columnMap: Record<string, string> = {};
  const reverseColumnMap: Record<string, string> = {};
  for (const c of columns) {
    columnMap[c.field] = c.name;
    reverseColumnMap[c.name] = c.field;
  }
  return {
    name,
    columns,
    columnMap,
    reverseColumnMap,
    dateColumns: new Set(columns.filter((c) => c.tsType.startsWith('Date')).map((c) => c.name)),
    pgTypes: Object.fromEntries(columns.map((c) => [c.name, c.pgType])),
    allColumns: columns.map((c) => c.name),
    primaryKey: ['id'],
    uniqueColumns: [['id']],
    relations,
    indexes: [],
  };
}

// order (child) belongsTo account (parent); account carries a bigint `balance`
// column, a JSON nested block cannot carry it, so a `with: { account }` falls
// to a loader today and becomes a scalar link path when a link is declared.
const linkSchema: SchemaMetadata = {
  enums: {},
  tables: {
    account: table(
      'account',
      [
        col('id', 'id', 'string', 'text', { hasDefault: true }),
        col('name', 'name', 'string', 'text'),
        col('balance', 'balance', 'bigint', 'int8', { nullable: true }),
      ],
      {
        orders: {
          type: 'hasMany',
          name: 'orders',
          from: 'account',
          to: 'order',
          foreignKey: 'account_id',
          referenceKey: 'id',
        },
      },
    ),
    order: table(
      'order',
      [
        col('id', 'id', 'string', 'text', { hasDefault: true }),
        col('account_id', 'accountId', 'string', 'text'),
        col('total', 'total', 'number', 'int4', { nullable: true }),
      ],
      {
        account: {
          type: 'belongsTo',
          name: 'account',
          from: 'order',
          to: 'account',
          foreignKey: 'account_id',
          referenceKey: 'id',
        },
      },
    ),
  },
};

/** The declared to-one link matching order.account, as `schema links` returns it. */
const ACCOUNT_LINK = {
  owner: 'order',
  name: 'account',
  target: 'account',
  local_key: 'account_id',
  target_key: 'id',
  cardinality: 'to-one',
};

/** A mock pool that answers `schema links` with `links` and every other query with `nextRows`. */
function linkMockPool(caps: PowdbCapabilities, links: Record<string, unknown>[]) {
  const calls: { powql: string; params: unknown[] }[] = [];
  let nextRows: Record<string, unknown>[] = [];
  const pool = {
    capabilities: caps,
    retryStaleReads: false,
    query(powql: string, params: unknown[]) {
      calls.push({ powql, params });
      if (powql.trimStart() === 'schema links') return Promise.resolve({ rows: links, rowCount: links.length });
      return Promise.resolve({ rows: nextRows, rowCount: nextRows.length });
    },
  } as unknown as PowdbPool;
  return {
    pool,
    calls,
    reads: () => calls.filter((c) => c.powql.trimStart() !== 'schema links'),
    setRows: (r: Record<string, unknown>[]) => {
      nextRows = r;
    },
  };
}

const withLinkPaths: PowdbCapabilities = {
  ...ALL_POWDB_CAPABILITIES,
  engineVersion: '0.19.1',
  nestedProjections: true,
  entityLinks: true,
  linkIntrospection: true,
  linkPaths: true,
  nativeRaw: true,
};
const noLinkPaths: PowdbCapabilities = {
  ...ALL_POWDB_CAPABILITIES,
  engineVersion: '0.19.0',
  nestedProjections: true,
  entityLinks: true,
  linkIntrospection: false,
  linkPaths: false,
};

// ---------------------------------------------------------------------------
// 1. Patch-aware capability gates
// ---------------------------------------------------------------------------

describe('powdb links: patch-aware capability gates', () => {
  it('gates linkIntrospection + linkPaths at >= 0.19.1 (0.19.0 and 0.18.2 false)', () => {
    for (const key of ['linkIntrospection', 'linkPaths'] as const) {
      assert.equal(capabilitiesFromVersion('0.19.1')[key], true, `${key} on 0.19.1`);
      assert.equal(capabilitiesFromVersion('0.19.2')[key], true, `${key} on 0.19.2`);
      assert.equal(capabilitiesFromVersion('0.20.0')[key], true, `${key} on 0.20.0`);
      assert.equal(capabilitiesFromVersion('1.0.0')[key], true, `${key} on 1.0.0`);
      assert.equal(capabilitiesFromVersion('0.19.0')[key], false, `${key} on 0.19.0`);
      assert.equal(capabilitiesFromVersion('0.18.2')[key], false, `${key} on 0.18.2`);
      assert.equal(capabilitiesFromVersion('preview')[key], false, `${key} on non-semver`);
      assert.equal(capabilitiesFromVersion(null)[key], false, `${key} on null`);
    }
    // entityLinks stays at the minor floor 0.19 (0.19.0 already true).
    assert.equal(capabilitiesFromVersion('0.19.0').entityLinks, true);
  });

  it('the E017 hint names the 0.19.1 floor for both new lanes', () => {
    assert.throws(
      () => requireCapability(capabilitiesFromVersion('0.19.0'), 'linkPaths', 'scalar link paths'),
      /scalar link paths is unsupported.*Requires PowDB >= 0\.19\.1/s,
    );
    assert.throws(
      () => requireCapability(capabilitiesFromVersion('0.19.0'), 'linkIntrospection', 'link introspection'),
      /link introspection is unsupported.*Requires PowDB >= 0\.19\.1/s,
    );
  });

  it('ALL_POWDB_CAPABILITIES keeps both new lanes OFF (probe-only)', () => {
    assert.equal(ALL_POWDB_CAPABILITIES.linkIntrospection, false);
    assert.equal(ALL_POWDB_CAPABILITIES.linkPaths, false);
  });
});

// ---------------------------------------------------------------------------
// 2. describe link-row filtering
// ---------------------------------------------------------------------------

describe('powdb links: describe drops link rows from column parsing', () => {
  it('filters `type: "link"` rows so a linked database introspects clean columns', async () => {
    const exec: PowdbExec = async (powql) => {
      if (powql === 'schema') return { rows: [{ name: 'order', columns: 2 }] };
      // 2 real columns + an outgoing link row + an incoming link row.
      return {
        rows: [
          { column: 'id', type: 'str', nullable: 'false', index: 'unique' },
          { column: 'account_id', type: 'str', nullable: 'false', index: '' },
          { column: 'account', type: 'link', nullable: {}, index: '-> Account (to-one, account_id -> id)' },
          { column: 'Account.orders', type: 'link', nullable: {}, index: '<- Account (to-many, id -> account_id)' },
        ],
      };
    };
    const meta = await introspectPowdbDatabase(exec);
    const cols = meta.tables.order!.columns.map((c) => c.name);
    assert.deepEqual(cols, ['id', 'account_id']);
    assert.ok(!cols.includes('account'), 'the outgoing link row is not a column');
    assert.ok(!meta.tables.order!.dialectTypes || meta.tables.order!.columns.every((c) => c.dialectType !== 'link'));
  });
});

// ---------------------------------------------------------------------------
// 3. schema links -> relations
// ---------------------------------------------------------------------------

describe('powdb links: schema links populates relations', () => {
  const baseExec =
    (links: Record<string, unknown>[]): PowdbExec =>
    async (powql) => {
      if (powql === 'schema')
        return {
          rows: [
            { name: 'order', columns: 3 },
            { name: 'account', columns: 3 },
          ],
        };
      if (powql === 'schema links') return { rows: links };
      const t = powql.replace(/^describe\s+`?/, '').replace(/`?$/, '');
      if (t === 'order')
        return {
          rows: [
            { column: 'id', type: 'str', nullable: 'false', index: 'unique' },
            { column: 'account_id', type: 'str', nullable: 'false', index: '' },
            { column: 'total', type: 'int', nullable: 'true', index: '' },
          ],
        };
      return {
        rows: [
          { column: 'id', type: 'str', nullable: 'false', index: 'unique' },
          { column: 'name', type: 'str', nullable: 'false', index: '' },
          { column: 'balance', type: 'int', nullable: 'true', index: '' },
        ],
      };
    };

  it('without linkIntrospection, relations stay {} and `schema links` is never run', async () => {
    let listed = false;
    const exec: PowdbExec = async (powql) => {
      if (powql === 'schema links') listed = true;
      return baseExec([ACCOUNT_LINK])(powql);
    };
    const meta = await introspectPowdbDatabase(exec, { capabilities: noLinkPaths });
    assert.deepEqual(meta.tables.order!.relations, {});
    assert.deepEqual(meta.tables.account!.relations, {});
    assert.equal(listed, false, '`schema links` not issued without linkIntrospection');
  });

  it('maps a to-one link to belongsTo on the owner + reverse hasMany on the target', async () => {
    const meta = await introspectPowdbDatabase(baseExec([ACCOUNT_LINK]), { capabilities: withLinkPaths });
    // Forward: order.account belongsTo account (localKey = FK on owner, targetKey = PK on target).
    assert.deepEqual(meta.tables.order!.relations.account, {
      type: 'belongsTo',
      name: 'account',
      from: 'order',
      to: 'account',
      foreignKey: 'account_id',
      referenceKey: 'id',
    });
    // Reverse: account.orders hasMany order (pluralized owner name), keys swapped.
    assert.deepEqual(meta.tables.account!.relations.orders, {
      type: 'hasMany',
      name: 'orders',
      from: 'account',
      to: 'order',
      foreignKey: 'account_id',
      referenceKey: 'id',
    });
  });

  it('maps a to-many link to hasMany on the owner + reverse belongsTo on the target', async () => {
    const toMany = {
      owner: 'account',
      name: 'orders',
      target: 'order',
      local_key: 'id',
      target_key: 'account_id',
      cardinality: 'to-many',
    };
    const meta = await introspectPowdbDatabase(baseExec([toMany]), { capabilities: withLinkPaths });
    assert.deepEqual(meta.tables.account!.relations.orders, {
      type: 'hasMany',
      name: 'orders',
      from: 'account',
      to: 'order',
      foreignKey: 'account_id', // FK on the child (target)
      referenceKey: 'id', // referenced key on the owner
    });
    // Reverse belongsTo on order, singularized owner name `account`.
    assert.deepEqual(meta.tables.order!.relations.account, {
      type: 'belongsTo',
      name: 'account',
      from: 'order',
      to: 'account',
      foreignKey: 'account_id',
      referenceKey: 'id',
    });
  });

  it('camelCases the relation name and preserves snake key columns', async () => {
    const snakey = {
      owner: 'order',
      name: 'billing_account',
      target: 'account',
      local_key: 'account_id',
      target_key: 'id',
      cardinality: 'to-one',
    };
    const meta = await introspectPowdbDatabase(baseExec([snakey]), { capabilities: withLinkPaths });
    assert.ok(meta.tables.order!.relations.billingAccount, 'relation name camelCased');
    assert.equal(meta.tables.order!.relations.billingAccount!.foreignKey, 'account_id');
  });

  it('an empty catalog yields relations {} without error', async () => {
    const meta = await introspectPowdbDatabase(baseExec([]), { capabilities: withLinkPaths });
    assert.deepEqual(meta.tables.order!.relations, {});
    assert.deepEqual(meta.tables.account!.relations, {});
  });
});

// ---------------------------------------------------------------------------
// 4. emitLinks DDL
// ---------------------------------------------------------------------------

describe('powdb links: emitLinks DDL', () => {
  it('is OFF by default, no `link` statements', () => {
    const stmts = powqlSchemaDDL(linkSchema);
    assert.ok(!stmts.some((s) => s.startsWith('link ')));
  });

  it('emits one `link` per single-column relation (both directions round-trip)', () => {
    const stmts = powqlSchemaDDL(linkSchema, { emitLinks: true });
    // belongsTo order.account: link Owner=order . account -> account on account_id = id.
    // `order` is a PowQL keyword, so its type reference is backtick-quoted.
    assert.ok(stmts.includes('link `order`.account -> account on account_id = id'), stmts.join('\n'));
    // hasMany account.orders (owner=account): localKey = referenceKey (id), targetKey = FK (account_id).
    assert.ok(stmts.includes('link account.orders -> `order` on id = account_id'), stmts.join('\n'));
    // Links come after every type declaration.
    const firstLink = stmts.findIndex((s) => s.startsWith('link '));
    const lastType = stmts.map((s) => s.startsWith('type ')).lastIndexOf(true);
    assert.ok(firstLink > lastType, 'links appended after types');
  });

  it('skips composite-key relations and m2m junctions', () => {
    const s: SchemaMetadata = {
      enums: {},
      tables: {
        a: {
          ...table('a', [col('id', 'id', 'string', 'text')]),
          relations: {
            // composite FK
            b: { type: 'belongsTo', name: 'b', from: 'a', to: 'b', foreignKey: ['x', 'y'], referenceKey: ['p', 'q'] },
            // m2m
            cs: {
              type: 'manyToMany',
              name: 'cs',
              from: 'a',
              to: 'c',
              foreignKey: 'id',
              referenceKey: 'id',
              through: { table: 'ac', sourceKey: 'a_id', targetKey: 'c_id' },
            },
          },
        },
        b: table('b', [col('id', 'id', 'string', 'text')]),
        c: table('c', [col('id', 'id', 'string', 'text')]),
      },
    };
    const stmts = powqlSchemaDDL(s, { emitLinks: true });
    assert.ok(!stmts.some((st) => st.startsWith('link ')), 'no links for composite/m2m');
  });

  it('skips a relation whose name collides with a column, warning once', () => {
    resetWarnOnce(WARN_NS.powdbLinks);
    const s: SchemaMetadata = {
      enums: {},
      tables: {
        a: {
          ...table('a', [col('id', 'id', 'string', 'text'), col('owner', 'owner', 'string', 'text')]),
          relations: {
            // relation named `owner` collides with the `owner` column.
            owner: { type: 'belongsTo', name: 'owner', from: 'a', to: 'b', foreignKey: 'owner', referenceKey: 'id' },
          },
        },
        b: table('b', [col('id', 'id', 'string', 'text')]),
      },
    };
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (m?: unknown) => warnings.push(String(m));
    try {
      const stmts = powqlSchemaDDL(s, { emitLinks: true });
      assert.ok(!stmts.some((st) => st.startsWith('link ')), 'collided link skipped');
    } finally {
      console.warn = orig;
    }
    assert.equal(warnings.length, 1, 'warned exactly once');
    assert.match(warnings[0]!, /collides with a column/);
  });

  it('throws E017 when emitLinks is used but capabilities lack entityLinks', () => {
    assert.throws(
      () => powqlSchemaDDL(linkSchema, { emitLinks: true, capabilities: capabilitiesFromVersion('0.18.0') }),
      (e: unknown) =>
        e instanceof UnsupportedFeatureError &&
        (e as UnsupportedFeatureError).code === TurbineErrorCode.UNSUPPORTED_FEATURE,
    );
  });

  it('deriveDesiredLinks + powdbLinkStatement produce the same statement text', () => {
    const links = deriveDesiredLinks(linkSchema);
    const account = links.find((l) => l.owner === 'order' && l.name === 'account')!;
    assert.equal(powdbLinkStatement(account), 'link `order`.account -> account on account_id = id');
  });
});

// ---------------------------------------------------------------------------
// 5. applyPowdbLinks existence-check
// ---------------------------------------------------------------------------

describe('powdb links: applyPowdbLinks existence-check', () => {
  it('executes only the missing links; a second run is a no-op (idempotent)', async () => {
    resetWarnOnce(WARN_NS.powdbLinks);
    const declared: Record<string, unknown>[] = [];
    const executed: string[] = [];
    const exec: PowdbExec = async (powql) => {
      if (powql === 'schema links') return { rows: declared };
      // A `link ...` DDL: record it and add to the live catalog. Strip backtick
      // quoting first (a keyword type like `order` is emitted quoted).
      executed.push(powql);
      const m = /^link (\w+)\.(\w+) -> (\w+) on (\w+) = (\w+)$/.exec(powql.replace(/`/g, ''))!;
      declared.push({
        owner: m[1],
        name: m[2],
        target: m[3],
        local_key: m[4],
        target_key: m[5],
        cardinality: 'to-one',
      });
      return { rows: [] };
    };
    const first = await applyPowdbLinks(exec, linkSchema);
    assert.equal(first.length, 2, 'both links created on the first run');
    const second = await applyPowdbLinks(exec, linkSchema);
    assert.equal(second.length, 0, 'second run creates nothing');
    assert.equal(executed.length, 2, 'the DDL ran exactly twice total');
    void declared;
  });

  it('skips an identical existing link, and warns (never drops) on endpoint drift', async () => {
    resetWarnOnce(WARN_NS.powdbLinks);
    const declared = [
      { ...ACCOUNT_LINK }, // identical → silent skip
      {
        owner: 'account',
        name: 'orders',
        target: 'order',
        local_key: 'id',
        target_key: 'WRONG',
        cardinality: 'to-many',
      }, // drift
    ];
    const executed: string[] = [];
    const exec: PowdbExec = async (powql) => {
      if (powql === 'schema links') return { rows: declared };
      executed.push(powql);
      return { rows: [] };
    };
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (m?: unknown) => warnings.push(String(m));
    let out: string[];
    try {
      out = await applyPowdbLinks(exec, linkSchema);
    } finally {
      console.warn = orig;
    }
    assert.equal(out.length, 0, 'nothing executed, both links already declared');
    assert.equal(executed.length, 0);
    assert.equal(warnings.length, 1, 'exactly one drift warning');
    assert.match(warnings[0]!, /different\s+endpoints/);
  });
});

// ---------------------------------------------------------------------------
// 6. Scalar link-path query-generation gating
// ---------------------------------------------------------------------------

describe('powdb links: scalar link-path compilation gating', () => {
  it('without linkPaths, a bigint-child to-one `with` stays byte-identical (loader path)', async () => {
    const mock = linkMockPool(noLinkPaths, [ACCOUNT_LINK]);
    const qi = new PowqlInterface(mock.pool, 'order', linkSchema);
    mock.setRows([]);
    await qi.findMany({ where: { id: 'o1' }, with: { account: true } });
    // The parent query is the plain (unaliased) projection; NO `t0.account.` path,
    // NO `schema links` fetch.
    // `order` is a PowQL keyword, so the type reference is backtick-quoted; the
    // main read is the one that is not the `account` loader and not `schema links`.
    const parent = mock.reads().find((c) => !c.powql.startsWith('account'))!;
    assert.ok(!parent.powql.includes(' as t0'), 'parent stays unaliased');
    assert.ok(!parent.powql.includes('.account.'), 'no link path emitted');
    assert.ok(!mock.calls.some((c) => c.powql.trimStart() === 'schema links'), 'no snapshot fetch');
  });

  it('with linkPaths but NO declared link, falls back to the loader (no link path)', async () => {
    const mock = linkMockPool(withLinkPaths, []); // empty snapshot
    const qi = new PowqlInterface(mock.pool, 'order', linkSchema);
    mock.setRows([]);
    await qi.findMany({ where: { id: 'o1' }, with: { account: true } });
    const parent = mock.reads().find((c) => !c.powql.startsWith('account'))!;
    assert.ok(!parent.powql.includes('.account.'), 'no link path without a matching declaration');
    // The snapshot WAS consulted (a genuine candidate reached the matcher).
    assert.ok(
      mock.calls.some((c) => c.powql.trimStart() === 'schema links'),
      'snapshot consulted for the candidate',
    );
  });

  it('with linkPaths + a matching declared link, compiles alias-qualified scalar hops', async () => {
    const mock = linkMockPool(withLinkPaths, [ACCOUNT_LINK]);
    const qi = new PowqlInterface(mock.pool, 'order', linkSchema);
    mock.setRows([]);
    await qi.findMany({ where: { id: 'o1' }, with: { account: true } });
    const parent = mock.reads().find((c) => !c.powql.startsWith('account'))!;
    // `order` is a keyword → the type reference is backtick-quoted, then aliased.
    assert.ok(parent.powql.includes('`order` as t0'), 'parent aliased for the projection');
    // Every account column rides its own scalar hop, alias-qualified.
    assert.match(parent.powql, /t0\.account\.id/);
    assert.match(parent.powql, /t0\.account\.name/);
    assert.match(parent.powql, /t0\.account\.balance/);
    // No residual loader query for `account`.
    assert.equal(mock.reads().filter((c) => c.powql.startsWith('account')).length, 0);
  });

  it('reconstructs the child entity from the flat hops (bigint preserved, absent -> null)', async () => {
    const mock = linkMockPool(withLinkPaths, [ACCOUNT_LINK]);
    const qi = new PowqlInterface(mock.pool, 'order', linkSchema);
    // Two parents: one linked (native bigint balance), one with an absent account
    // (every hop Empty → null on the native wire).
    mock.setRows([
      { id: 'o1', account_id: 'a1', total: 5, l1_id: 'a1', l1_name: 'Acme', l1_balance: 9007199254740993n },
      { id: 'o2', account_id: null, total: 7, l1_id: null, l1_name: null, l1_balance: null },
    ]);
    const rows = (await qi.findMany({ with: { account: true } })) as Array<Record<string, unknown>>;
    // Linked row: the child is reconstructed; a bigint-typed column keeps its
    // native bigint value (same policy the loader's rowToEntity applies).
    assert.deepEqual(rows[0]!.account, { id: 'a1', name: 'Acme', balance: 9007199254740993n });
    // The synthetic hop keys are stripped off the parent.
    assert.ok(!('l1_id' in rows[0]!) && !('l1_balance' in rows[0]!));
    // Absent to-one → null (parity with the loader's `matches[0] ?? null`).
    assert.equal(rows[1]!.account, null);
  });
});

// ---------------------------------------------------------------------------
// 7. Error mapping (the two 0.19.1 hard errors)
// ---------------------------------------------------------------------------

describe('powdb links: 0.19.1 hard errors map to E003', () => {
  it('a bare-dotted-path parse error (aliasing hint) → ValidationError', () => {
    const msg =
      '`.user.name` is ambiguous in a projection: for a link path, alias the table and qualify the path (`Order as o { o.user.name }`); for separate fields, separate them with commas (`.user, .name`)';
    // Embedded shape (GenericFailure, message-only).
    const embedded = wrapPowdbError({ code: 'GenericFailure', message: msg });
    assert.ok(embedded instanceof ValidationError);
    assert.equal((embedded as ValidationError).code, TurbineErrorCode.VALIDATION);
    // Networked parse wire class also lands on E003.
    const networked = wrapPowdbError({ code: 'query_failed', message: 'query failed: parse error', wireErrorClass: 1 });
    assert.ok(networked instanceof ValidationError);
  });

  it('an aggregate-over-link rejection → ValidationError', () => {
    const msg = 'aggregates over a nested or link projection are not supported';
    const embedded = wrapPowdbError({ code: 'GenericFailure', message: msg });
    assert.ok(embedded instanceof ValidationError);
    assert.equal((embedded as ValidationError).code, TurbineErrorCode.VALIDATION);
    const networked = wrapPowdbError({ code: 'query_failed', message: msg, wireErrorClass: 2 });
    assert.ok(networked instanceof ValidationError);
  });
});
