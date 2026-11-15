import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConnectionError, TimeoutError, UnsupportedFeatureError, ValidationError } from '../errors.js';
import { assertStatelessSql } from '../neon-http/sql.js';
import { NEON_HTTP_CAPABILITIES, type NeonHttpSql, turbineNeonHttp } from '../neon-http.js';
import type { PgCompatQueryResult } from '../pg-types.js';
import type { DeferredQuery } from '../query/deferred.js';
import { neonHttpSchema } from './fixtures/neon-http/schema.js';

function fixture() {
  const sent: { text: string; params: unknown[]; options: unknown }[] = [];
  const batches: unknown[] = [];
  let result: PgCompatQueryResult = { rows: [{ id: 7, tenant_id: 4, display_name: 'Ada' }], rowCount: 1 };
  let failure: unknown;
  const sql: NeonHttpSql = {
    query(text, params = [], options) {
      const handle = { text, params, options };
      return {
        // biome-ignore lint/suspicious/noThenProperty: model the driver's deliberately lazy query thenable
        then(resolve, reject) {
          sent.push(handle);
          return (failure ? Promise.reject(failure) : Promise.resolve(result)).then(resolve, reject);
        },
      };
    },
    transaction(queries, options) {
      batches.push({ queries, options });
      // A protocol fixture, not a native transaction or database effect.
      return failure ? Promise.reject(failure) : Promise.resolve(queries.map(() => result));
    },
  };
  return {
    sql,
    sent,
    batches,
    setResult: (r: PgCompatQueryResult) => {
      result = r;
    },
    setFailure: (e: unknown) => {
      failure = e;
    },
  };
}

describe('Neon HTTP single-statement facade (protocol fixture)', () => {
  it('publishes concrete immutable transport capabilities', () => {
    assert.equal(NEON_HTTP_CAPABILITIES.nativeAtomicBatch, true);
    assert.equal(NEON_HTTP_CAPABILITIES.interactiveTransactions, false);
    assert.equal(NEON_HTTP_CAPABILITIES.listen, false);
    assert.ok(Object.isFrozen(NEON_HTTP_CAPABILITIES));
  });

  it('uses typed SQL, positional values, aliases and global filters', async () => {
    const f = fixture();
    const db = turbineNeonHttp(f.sql, neonHttpSchema(), { globalFilters: { accounts: { tenantId: 4 } } });
    const rows = await db
      .table<{ id: number; tenantId: number; displayName: string }>('accounts')
      .findMany({ where: { displayName: 'Ada' }, limit: 2 });
    assert.deepEqual(rows, [{ id: 7, tenantId: 4, displayName: 'Ada' }]);
    assert.equal(f.sent.length, 1);
    assert.deepEqual(f.sent[0]!.params, ['Ada', 4, 2]);
    assert.match(f.sent[0]!.text, /"display_name" = \$1/);
    assert.doesNotMatch(f.sent[0]!.text, /Ada/);
    assert.equal(db.table('accounts'), db.table('accounts'));
  });

  it('decodes ordered nested relations through the existing parser and filters child SQL', async () => {
    const f = fixture();
    f.setResult({
      rows: [
        {
          id: 7,
          tenant_id: 4,
          display_name: 'Ada',
          posts: [
            { id: 2, account_id: 7, tenant_id: 4, title: 'B' },
            { id: 1, account_id: 7, tenant_id: 4, title: 'A' },
          ],
        },
      ],
      rowCount: 1,
    });
    const db = turbineNeonHttp(f.sql, neonHttpSchema(), {
      jsonEncoding: 'object',
      globalFilters: { accounts: { tenantId: 4 }, posts: { tenantId: 4 } },
    });
    const rows = await db.table('accounts').findMany({ with: { posts: { orderBy: { id: 'desc' } } }, limit: 1 });
    assert.deepEqual(rows, [
      {
        id: 7,
        tenantId: 4,
        displayName: 'Ada',
        posts: [
          { id: 2, accountId: 7, tenantId: 4, title: 'B' },
          { id: 1, accountId: 7, tenantId: 4, title: 'A' },
        ],
      },
    ]);
    assert.match(f.sent[0]!.text, /ORDER BY .*"id" DESC/);
    assert.ok(f.sent[0]!.params.filter((v) => v === 4).length >= 2);
  });

  it('keeps current positional bindings when cached query shapes repeat', async () => {
    const f = fixture();
    const db = turbineNeonHttp(f.sql, neonHttpSchema(), { diagnostics: { cacheCheck: 'every-hit' } });
    const table = db.table('accounts');
    await table.findMany({ where: { id: 7 }, limit: 1 });
    await table.findMany({ where: { id: 8 }, limit: 2 });
    assert.equal(f.sent.length, 2);
    assert.equal(f.sent[0]!.text, f.sent[1]!.text);
    assert.deepEqual(
      f.sent.map((request) => request.params),
      [
        [7, 1],
        [8, 2],
      ],
    );
    assert.equal(table.cacheStats().hits, 1);
  });

  it('returns exact mutation effects using native rowCount', async () => {
    const f = fixture();
    f.setResult({ rows: [], rowCount: 3 });
    const db = turbineNeonHttp(f.sql, neonHttpSchema());
    assert.deepEqual(
      await db.table('accounts').updateMany({ where: { tenantId: 4 }, data: { displayName: 'changed' } }),
      { count: 3 },
    );
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0]!.text, /^UPDATE /);
  });

  it('builds without executing and submits one native batch in input order', async () => {
    const f = fixture();
    const db = turbineNeonHttp(f.sql, neonHttpSchema());
    const a = db.table('accounts').buildFindMany({ where: { id: 7 } });
    const b = db.table('accounts').buildFindFirst({ where: { id: 7 } });
    assert.deepEqual(f.sent, []);
    assert.deepEqual(await db.batch([a, b], { isolationLevel: 'Serializable', readOnly: true }), [
      [{ id: 7, tenantId: 4, displayName: 'Ada' }],
      { id: 7, tenantId: 4, displayName: 'Ada' },
    ]);
    assert.equal(f.batches.length, 1);
    assert.deepEqual(f.sent, [], 'batch lazy handles were not awaited independently');
    assert.deepEqual(await db.batch([]), []);
    assert.equal(f.batches.length, 1);
  });

  it('keeps admitted batch transforms and count when the caller mutates its array in flight', async () => {
    for (const mutation of ['replace', 'append', 'clear']) {
      const f = fixture();
      const db = turbineNeonHttp(f.sql, neonHttpSchema());
      const other = turbineNeonHttp(f.sql, neonHttpSchema());
      let finish!: () => void;
      f.sql.transaction = () =>
        new Promise((resolve) => {
          finish = () => resolve([{ rows: [], rowCount: 1 }]);
        });
      const queries: DeferredQuery<unknown>[] = [
        db.table('accounts').buildUpdateMany({ data: { displayName: 'B' }, where: { id: 7 } }),
      ];
      const pending = db.batch(queries);
      const foreign = other.table('accounts').buildFindMany();
      if (mutation === 'replace') queries[0] = foreign;
      else if (mutation === 'append') queries.push(foreign);
      else queries.length = 0;
      finish();
      assert.deepEqual(await pending, [{ count: 1 }]);
      await db.disconnect();
      await other.disconnect();
    }
  });

  it('rejects a foreign deferred or promise before any native handle or transaction', () => {
    const f = fixture();
    const db = turbineNeonHttp(f.sql, neonHttpSchema());
    const q = db.table('accounts').buildCount();
    const other = turbineNeonHttp(f.sql, neonHttpSchema());
    assert.throws(() => db.batch([q, other.table('accounts').buildCount()]), ValidationError);
    assert.throws(() => db.batch([q, Promise.resolve([])] as unknown as DeferredQuery<unknown>[]), ValidationError);
    assert.ok(Object.isFrozen(q));
    assert.ok(Object.isFrozen(q.params));
    assert.equal(f.sent.length + f.batches.length, 0);
  });

  it('rejects interactive callbacks before invoking them, including the transaction alias', () => {
    const f = fixture();
    const db = turbineNeonHttp(f.sql, neonHttpSchema());
    let invoked = 0;
    const callback = () => {
      invoked++;
      throw new Error('callback ran');
    };
    assert.throws(() => db.transaction(callback), UnsupportedFeatureError);
    assert.throws(() => db.$transaction(callback as unknown as []), UnsupportedFeatureError);
    assert.throws(() => db.batch(callback as unknown as []), UnsupportedFeatureError);
    assert.equal(invoked, 0);
    assert.equal(f.sent.length + f.batches.length, 0);
  });

  it('refuses pinned APIs and locks before any SQL or handler call', async () => {
    const f = fixture();
    const db = turbineNeonHttp(f.sql, neonHttpSchema());
    const handler = () => {
      throw new Error('handler ran');
    };
    for (const invoke of [
      () => db.connect(),
      () => db.pipeline([]),
      () => db.$listen('events', handler),
      () => db.$notify('events', 'payload'),
      () => db.table('accounts').findManyStream(),
      () => db.table('accounts').findManyStreamBatches(),
      () => db.table('accounts').explain(),
    ]) {
      assert.throws(invoke, UnsupportedFeatureError);
    }
    await assert.rejects(db.table('accounts').findMany({ lock: 'update' }), UnsupportedFeatureError);
    assert.throws(() => db.table('accounts').buildFindMany({ lock: 'share' }), UnsupportedFeatureError);
    assert.equal(f.sent.length + f.batches.length, 0);
  });

  it('refuses nested writes, lookup upserts and multi-request relation loading without effects', async () => {
    const f = fixture();
    const db = turbineNeonHttp(f.sql, neonHttpSchema());
    await assert.rejects(
      db.table('accounts').create({ data: { id: 1, posts: { create: { title: 'A' } } } }),
      /nested|relation/i,
    );
    await assert.rejects(
      db.table('accounts').upsert({ where: { id: 1 }, create: { id: 1 }, update: {} }),
      /upsert|single/i,
    );
    await assert.rejects(db.table('accounts').findMany({ relationLoadStrategy: 'batched' }), UnsupportedFeatureError);
    assert.equal(f.sent.length + f.batches.length, 0);
  });

  it('refuses invalid global-filter configuration during construction', () => {
    const f = fixture();
    assert.throws(
      () => turbineNeonHttp(f.sql, neonHttpSchema(), { globalFilters: { typo: { tenantId: 4 } } }),
      ValidationError,
    );
    assert.throws(
      () => turbineNeonHttp(f.sql, neonHttpSchema(), { globalFilters: { accounts: { typo: 4 } } }),
      ValidationError,
    );
    assert.throws(
      () => turbineNeonHttp(f.sql, neonHttpSchema(), { preparedStatements: true } as never),
      ValidationError,
    );
    assert.equal(f.sent.length, 0);
  });

  it('preserves native driver errors and parameter identity without added diagnostics', async () => {
    const f = fixture();
    const error = Object.assign(new Error('native failure'), { code: '23505' });
    f.setFailure(error);
    const db = turbineNeonHttp(f.sql, neonHttpSchema());
    const value = { secret: 'bound value' };
    await assert.rejects(db.rawUnsafe('SELECT $1::jsonb', [value]), (e) => e === error);
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0]!.params[0], value);
    assert.doesNotMatch(f.sent[0]!.text, /bound value/);
    const q = db.table('accounts').buildCount();
    await assert.rejects(db.batch([q]), (e) => e === error);
    assert.equal(f.batches.length, 1);
  });

  it('validates signal and batch options without constructing a native request', () => {
    const f = fixture();
    const db = turbineNeonHttp(f.sql, neonHttpSchema());
    assert.throws(() => turbineNeonHttp(f.sql, neonHttpSchema(), { signal: {} as AbortSignal }), ValidationError);
    assert.throws(() => db.rawUnsafe('SELECT 1', [], { signal: {} as AbortSignal }), ValidationError);
    assert.throws(() => db.batch([], { isolationLevel: 'invalid' } as never), ValidationError);
    assert.throws(() => db.batch([], { readOnly: 'yes' } as never), ValidationError);
    assert.throws(() => db.batch([], { timeoutMs: -1 }), ValidationError);
    assert.equal(f.sent.length + f.batches.length, 0);
  });

  it('checks cancellation before native query construction', async () => {
    const f = fixture();
    const controller = new AbortController();
    const reason = { cancellation: 'reason' };
    controller.abort(reason);
    const db = turbineNeonHttp(f.sql, neonHttpSchema());
    await assert.rejects(db.rawUnsafe('SELECT 1', [], { signal: controller.signal }), (e) => e === reason);
    await assert.rejects(db.batch([], { signal: controller.signal }), (e) => e === reason);
    assert.equal(f.sent.length + f.batches.length, 0);
  });

  it('aborts active delivery and seals captured accessors without ending the caller driver', async () => {
    let signal: AbortSignal | undefined;
    let started!: () => void;
    const ready = new Promise<void>((r) => {
      started = r;
    });
    const sql: NeonHttpSql = {
      query(_sql, _params, options) {
        signal = options?.fetchOptions?.signal;
        started();
        return new Promise(() => {});
      },
      transaction() {
        throw new Error('unexpected batch');
      },
    };
    const db = turbineNeonHttp(sql, neonHttpSchema());
    const table = db.table('accounts');
    const pending = table.findMany({ limit: 1 });
    const rejected = assert.rejects(pending, ConnectionError);
    await ready;
    await db.disconnect();
    await rejected;
    assert.equal(signal!.aborted, true);
    await assert.rejects(table.findMany({ limit: 1 }), ConnectionError);
    assert.throws(() => table.buildCount(), ConnectionError);
    assert.throws(() => db.rawUnsafe('SELECT 1'), ConnectionError);
    await db.disconnect();
    assert.equal(typeof sql.query, 'function');
  });

  it('reports timeout with unknown database outcome', async () => {
    const f = fixture();
    f.sql.query = () => new Promise(() => {});
    const db = turbineNeonHttp(f.sql, neonHttpSchema());
    await assert.rejects(
      db.rawUnsafe('SELECT 1', [], { timeoutMs: 1 }),
      (e) => e instanceof TimeoutError && e.outcome === 'unknown',
    );
    assert.throws(() => db.rawUnsafe('SELECT 1', [], { timeoutMs: -1 }), ValidationError);
  });
});

describe('Neon HTTP conservative raw SQL boundary', () => {
  it('refuses known session operations and multiple statements without SQL in diagnostics', () => {
    for (const sql of [
      'LISTEN secret_channel',
      'SET search_path = secret_schema',
      'BEGIN',
      'SELECT 1; COMMIT',
      'SELECT pg_advisory_lock(1)',
      'SELECT pg_catalog."pg_advisory_lock"(1)',
      'SELECT set_config($1, $2, false)',
      'SELECT pg_notify($1, $2)',
      'SELECT * FROM accounts FOR UPDATE',
      'SELECT 1; DELETE FROM accounts',
      'DECLARE cursor1 CURSOR FOR SELECT 1',
      'COPY accounts TO STDOUT',
    ]) {
      assert.throws(
        () => assertStatelessSql(sql),
        (e) => e instanceof UnsupportedFeatureError && !e.message.includes('secret_'),
      );
    }
  });
  it('allows tokens inside comments, literals, dollar quotes and safe quoted identifiers', () => {
    for (const sql of [
      "SELECT 'COMMIT; LISTEN secret'",
      'SELECT $$pg_advisory_lock(1);$$',
      '/* outer /* inner */ */ SELECT $1; -- end',
      'SELECT "listen" FROM "accounts"',
      'SELECT "for" AS "update" FROM "accounts"',
      "SELECT E'a\\';ROLLBACK'",
      'WITH t AS (SELECT $1) SELECT * FROM t',
    ])
      assert.doesNotThrow(() => assertStatelessSql(sql));
  });
});
