/**
 * turbine-orm, the `planCacheMode` client option.
 *
 * PostgreSQL promotes a named prepared statement to a generic plan after five
 * executions, and a generic plan is planned blind to the bound values. On a
 * shared multi-tenant table that can lock a sparse tenant onto a plan chosen
 * for the average one. `planCacheMode` pins the backend's choice.
 *
 * The option is applied as a CONNECTION PARAMETER (`options=-c
 * plan_cache_mode=...`), not as a `SET` issued after checkout, so it is in
 * force for a connection's first statement and cannot race the caller's first
 * query. These tests assert what lands in the pool configuration; the live
 * behaviour (the plan cliff appearing without it and gone with it) is covered
 * by the integration suite.
 *
 * No database required: pg.Pool does not connect eagerly.
 *
 * Run: npx tsx --test src/test/plan-cache-mode.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type PgCompatPool, TurbineClient } from '../client.js';
import { postgresDialect } from '../dialect.js';
import { TurbineErrorCode, UnsupportedFeatureError, ValidationError } from '../errors.js';
import { resetWarnOnce } from '../query/warn-registry.js';
import type { SchemaMetadata } from '../schema.js';
import { mockColumn, mockTable } from './helpers.js';

const schema: SchemaMetadata = {
  tables: { events: mockTable('events', [mockColumn('id', 'id', 'int4')]) },
  enums: {},
};

const URL_PLAIN = 'postgresql://u:p@localhost:5432/db';

/** The pg.PoolConfig a client actually built, as pg.Pool records it. */
function poolConfig(db: TurbineClient): { options?: string; connectionString?: string } {
  return (db.pool as unknown as { options: { options?: string; connectionString?: string } }).options;
}

function externalPool(): PgCompatPool {
  return {
    query: async () => ({ rows: [], rowCount: 0 }),
    connect: async () => {
      throw new Error('not used');
    },
    end: async () => {},
    on: () => {},
  } as unknown as PgCompatPool;
}

describe('planCacheMode', () => {
  it('issues nothing when unset (byte-identical to not passing the option)', () => {
    const withOption = poolConfig(new TurbineClient({ connectionString: URL_PLAIN }, schema));
    assert.equal(withOption.options, undefined, 'no options startup parameter');
    assert.equal(withOption.connectionString, URL_PLAIN, 'connection string untouched');
    // Explicit undefined must behave exactly like omitting the key.
    const explicitUndefined = poolConfig(
      new TurbineClient({ connectionString: URL_PLAIN, planCacheMode: undefined }, schema),
    );
    assert.deepEqual({ ...explicitUndefined }, { ...withOption });
  });

  for (const mode of ['auto', 'force_custom_plan', 'force_generic_plan'] as const) {
    it(`sets the connection parameter for '${mode}'`, () => {
      const cfg = poolConfig(new TurbineClient({ connectionString: URL_PLAIN, planCacheMode: mode }, schema));
      assert.equal(cfg.options, `-c plan_cache_mode=${mode}`);
      assert.equal(cfg.connectionString, URL_PLAIN, 'connection string untouched when it carries no options');
    });
  }

  it('appends to a connection string that already carries its own options', () => {
    // pg lets values parsed out of the connection string override the explicit
    // `options` field, so setting the field alone would be silently discarded.
    const url = `${URL_PLAIN}?options=-c%20statement_timeout%3D7000`;
    const cfg = poolConfig(new TurbineClient({ connectionString: url, planCacheMode: 'force_custom_plan' }, schema));
    assert.equal(cfg.options, undefined, 'the field is not used when the URL owns options');
    const params = new URLSearchParams((cfg.connectionString as string).split('?')[1]);
    assert.equal(params.get('options'), '-c statement_timeout=7000 -c plan_cache_mode=force_custom_plan');
    assert.ok((cfg.connectionString as string).startsWith(`${URL_PLAIN}?`), 'userinfo and host untouched');
  });

  it('applies to owned read replicas as well as the primary', () => {
    const db = new TurbineClient(
      { connectionString: URL_PLAIN, replicas: [URL_PLAIN], planCacheMode: 'force_custom_plan' },
      schema,
    );
    const replicas = (db as unknown as { ownedReplicaPools: { options: { options?: string } }[] }).ownedReplicaPools;
    assert.equal(replicas[0]?.options.options, '-c plan_cache_mode=force_custom_plan');
  });

  it('refuses any value outside the closed enum', () => {
    // The GUC value cannot be a bind parameter, so the enum check IS the
    // injection boundary. Nothing here may reach the emitted statement.
    const rejected = [
      'force_custom',
      'AUTO',
      'auto; SET statement_timeout = 0',
      "auto'",
      '',
      0,
      true,
      ['auto'],
      { toString: () => 'auto' },
    ];
    for (const value of rejected) {
      assert.throws(
        () => new TurbineClient({ connectionString: URL_PLAIN, planCacheMode: value as never }, schema),
        (err: unknown) => {
          assert.ok(err instanceof ValidationError, `expected ValidationError for ${JSON.stringify(value)}`);
          assert.equal(err.code, TurbineErrorCode.VALIDATION);
          assert.match(err.message, /Invalid planCacheMode/);
          assert.match(err.message, /'auto', 'force_custom_plan', 'force_generic_plan'/);
          return true;
        },
      );
    }
  });

  it('throws E017 on an engine whose dialect cannot support it', () => {
    const sqliteish = { ...postgresDialect, name: 'sqlite', supportsPlanCacheMode: false };
    assert.throws(
      () =>
        new TurbineClient(
          { pool: externalPool(), dialect: sqliteish, planCacheMode: 'force_custom_plan' } as never,
          schema,
        ),
      (err: unknown) => {
        assert.ok(err instanceof UnsupportedFeatureError);
        assert.equal(err.code, TurbineErrorCode.UNSUPPORTED_FEATURE);
        assert.match(err.message, /planCacheMode/);
        assert.match(err.message, /"sqlite"/);
        return true;
      },
    );
  });

  it('treats an absent capability flag as unsupported', () => {
    const legacy = { ...postgresDialect, name: 'legacy-engine' } as Record<string, unknown>;
    legacy.supportsPlanCacheMode = undefined;
    assert.throws(
      () => new TurbineClient({ pool: externalPool(), dialect: legacy, planCacheMode: 'auto' } as never, schema),
      UnsupportedFeatureError,
    );
  });

  it('is a documented no-op on an external pool, with one warning', () => {
    resetWarnOnce();
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (msg: string) => warnings.push(msg);
    try {
      new TurbineClient({ pool: externalPool(), planCacheMode: 'force_custom_plan' }, schema);
      new TurbineClient({ pool: externalPool(), planCacheMode: 'force_custom_plan' }, schema);
    } finally {
      console.warn = original;
    }
    assert.equal(warnings.length, 1, 'warns once per mode, not per client');
    assert.match(warnings[0] ?? '', /planCacheMode: 'force_custom_plan' was not applied to the primary/);
    assert.match(warnings[0] ?? '', /external `pool`/);
    assert.doesNotMatch(warnings[0] ?? '', /read replica/, 'no replica clause when there are none');
  });

  it('does not claim it was ignored when owned replicas did get it', () => {
    // The replica pools are Turbine's own connections even when the primary is
    // external, so the option really is applied to them. A warning that said
    // the option "was ignored" would be false, and the read/write split is the
    // part worth surfacing.
    resetWarnOnce();
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (msg: string) => warnings.push(msg);
    let db: TurbineClient;
    try {
      db = new TurbineClient(
        { pool: externalPool(), replicas: [URL_PLAIN], planCacheMode: 'force_generic_plan' },
        schema,
      );
    } finally {
      console.warn = original;
    }
    const replicas = (db as unknown as { ownedReplicaPools: { options: { options?: string } }[] }).ownedReplicaPools;
    assert.equal(replicas[0]?.options.options, '-c plan_cache_mode=force_generic_plan', 'applied to the replica');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? '', /not applied to the primary/);
    assert.match(warnings[0] ?? '', /1 Turbine-owned read replica pool/);
  });

  it('adds to PGOPTIONS instead of replacing it', () => {
    // pg reads `config.options` when truthy and `process.env.PGOPTIONS`
    // otherwise, so writing the field blind would drop a deployment's
    // PGOPTIONS entirely (its search_path, not merely a slower plan).
    const previous = process.env.PGOPTIONS;
    process.env.PGOPTIONS = '-c statement_timeout=9000';
    try {
      const cfg = poolConfig(new TurbineClient({ connectionString: URL_PLAIN, planCacheMode: 'auto' }, schema));
      assert.equal(cfg.options, '-c statement_timeout=9000 -c plan_cache_mode=auto');
      // Unset, the field stays absent so pg keeps reading PGOPTIONS itself.
      const untouched = poolConfig(new TurbineClient({ connectionString: URL_PLAIN }, schema));
      assert.equal(untouched.options, undefined);
    } finally {
      if (previous === undefined) delete process.env.PGOPTIONS;
      else process.env.PGOPTIONS = previous;
    }
  });

  it('validates before touching process-global parser state', () => {
    // A constructor that throws must leave the process as it found it: settling
    // the process-global utcTimestamps mode and THEN rejecting the config would
    // poison the next, valid, client with a phantom conflict.
    TurbineClient.resetUtcTimestampsForTests();
    assert.throws(
      () =>
        new TurbineClient(
          { connectionString: URL_PLAIN, utcTimestamps: false, planCacheMode: 'nope' as never },
          schema,
        ),
      ValidationError,
    );
    assert.doesNotThrow(() => new TurbineClient({ connectionString: URL_PLAIN, utcTimestamps: true }, schema));
  });

  it('is a recognised config key (no unknown-key warning)', () => {
    resetWarnOnce();
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (msg: string) => warnings.push(msg);
    try {
      new TurbineClient({ connectionString: URL_PLAIN, planCacheMode: 'auto' }, schema);
    } finally {
      console.warn = original;
    }
    assert.deepEqual(warnings, []);
  });
});
