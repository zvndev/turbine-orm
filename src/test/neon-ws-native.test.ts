import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { TurbineClient } from '../client.js';
import type { NeonWsDriver } from '../neon-ws/transport.js';
import type { NeonWsClient, NeonWsOptions, NeonWsPool } from '../neon-ws.js';
import { turbineNeonWs, withNeonWs } from '../neon-ws.js';
import importOptionalPeer from '../optional-peer-import.cjs';
import type { QueryInterface } from '../query/index.js';
import type { SchemaMetadata } from '../schema.js';
import { startNative } from './fixtures/neon-ws-native.js';
import { mockTable } from './helpers.js';

const pgRoot = process.env.TURBINE_NEON_WS_PG_ROOT;
const hasNative = Boolean(pgRoot || process.env.TURBINE_NEON_WS_PG_SERVICE_URL);
if (!hasNative && process.env.TURBINE_REQUIRE_NEON_WS === '1') {
  throw new Error(
    'Required Neon WebSocket native suite needs explicit TURBINE_NEON_WS_PG_ROOT (PostgreSQL18.6) or disposable TURBINE_NEON_WS_PG_SERVICE_URL, actual @neondatabase/serverless and ws',
  );
}

const schema: SchemaMetadata = {
  tables: {
    neon_ws_items: mockTable('neon_ws_items', [
      { name: 'id', field: 'id', pgType: 'int4' },
      { name: 'label', field: 'label', pgType: 'text' },
    ]),
  },
  enums: {},
};
interface Item {
  id: number;
  label: string;
}
class TypedClient extends TurbineClient {
  declare readonly neonWsItems: QueryInterface<Item>;
}
const options: NeonWsOptions = { sessionMode: 'persistent', lifetime: 'persistent', warnOnUnlimited: false };

/** Bound deadlines are failure detection, not performance measurements. */
async function deadline<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 4000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe('actual Neon driver + disposable native PostgreSQL over local WebSocket byte relay', {
  skip: !hasNative,
  concurrency: false,
}, () => {
  let native: Awaited<ReturnType<typeof startNative>>;
  let driver: NeonWsDriver & { neonConfig: Record<string, unknown> };
  const clients: TurbineClient[] = [];
  async function owned(extra: Partial<NeonWsOptions> = {}) {
    const db = await turbineNeonWs<TypedClient>({ connection: native.connection, driver: native.driver }, schema, {
      ...options,
      ...extra,
    });
    clients.push(db);
    return db;
  }
  before(async () => {
    driver = (await importOptionalPeer('@neondatabase/serverless')) as typeof driver;
    native = await startNative(pgRoot ?? '');
    await native.admin.query('CREATE TABLE neon_ws_items (id integer PRIMARY KEY, label text NOT NULL)');
  });
  after(async () => {
    for (const db of clients) await db.disconnect();
    await native?.close();
  });
  it('typed factory preserves exact ordered reads, writes, parameters and per-query parsing', async () => {
    const db = await owned();
    await db.neonWsItems.create({ data: { id: 1, label: "O'Brien" } });
    await db.neonWsItems.create({ data: { id: 2, label: 'second' } });
    assert.deepEqual(await db.neonWsItems.findMany({ orderBy: { id: 'asc' } }), [
      { id: 1, label: "O'Brien" },
      { id: 2, label: 'second' },
    ]);
    const values = await db.rawQuery<{ small: number; large: string; stamp: Date }>(
      "SELECT 12::bigint AS small, 9007199254740993::bigint AS large, TIMESTAMP '2026-02-03 04:05:06' AS stamp",
    );
    assert.equal(values.rows[0]?.small, 12);
    assert.equal(values.rows[0]?.large, '9007199254740993');
    assert.equal(values.rows[0]?.stamp.toISOString(), '2026-02-03T04:05:06.000Z');
    await db.neonWsItems.update({ where: { id: 2 }, data: { label: 'updated' } });
    assert.deepEqual(await db.neonWsItems.findUnique({ where: { id: 2 } }), { id: 2, label: 'updated' });
  });
  it('pins a real backend across callback transactions and rolls back exact effects', async () => {
    const db = await owned();
    await db.$transaction(async (tx) => {
      const first = await tx.raw<{ pid: number }>`SELECT pg_backend_pid() AS pid`;
      await tx.table<Item>('neon_ws_items').create({ data: { id: 3, label: 'committed' } });
      assert.deepEqual(await tx.raw`SELECT pg_backend_pid() AS pid`, first);
    });
    await assert.rejects(
      db.$transaction(async (tx) => {
        await tx.table<Item>('neon_ws_items').create({ data: { id: 4, label: 'rollback' } });
        throw new Error('rollback marker');
      }),
      /rollback marker/,
    );
    assert.deepEqual(await db.neonWsItems.findMany({ where: { id: { in: [3, 4] } }, orderBy: { id: 'asc' } }), [
      { id: 3, label: 'committed' },
    ]);
    assert.deepEqual(
      await db.$transaction([
        db.neonWsItems.buildFindMany({ where: { id: 3 } }),
        db.neonWsItems.buildCount({ where: { id: 4 } }),
      ]),
      [[{ id: 3, label: 'committed' }], 0],
    );
  });
  it('Pool configuration remains local and ignores the global fetch optimization', async () => {
    const keys = ['wsProxy', 'pipelineConnect', 'useSecureWebSocket', 'webSocketConstructor'];
    const defaults = keys.map((key) => driver.neonConfig[key]);
    const oldFetch = driver.neonConfig.poolQueryViaFetch;
    driver.neonConfig.poolQueryViaFetch = true; // Isolated negative control, restored below.
    try {
      const db = await owned();
      assert.deepEqual(
        keys.map((key) => driver.neonConfig[key]),
        defaults,
      );
      assert.deepEqual(await db.raw`SELECT 7 AS n`, [{ n: 7 }]);
      const other = await turbineNeonWs(
        { connection: native.connection, driver: { ...native.driver, wsProxy: () => '127.0.0.1:1/v1' } },
        schema,
        options,
      );
      try {
        await assert.rejects(other.rawQuery('SELECT 1'));
      } finally {
        await other.disconnect();
      }
      assert.deepEqual(await db.raw`SELECT 8 AS n`, [{ n: 8 }]);
    } finally {
      driver.neonConfig.poolQueryViaFetch = oldFetch;
    }
  });
  it('delivers committed notifications in order and reconnects a lost backend', async () => {
    const db = await owned();
    const messages: string[] = [];
    const errors: Error[] = [];
    let reconnect!: () => void;
    const reconnected = new Promise<void>((resolve) => {
      reconnect = resolve;
    });
    let received!: () => void;
    let next = new Promise<void>((resolve) => {
      received = resolve;
    });
    const sub = await db.$listen(
      'neon_ws_events',
      (payload) => {
        messages.push(payload);
        received();
      },
      { reconnect: { initialDelayMs: 10, maxDelayMs: 30 }, onError: (err) => errors.push(err), onReconnect: reconnect },
    );
    try {
      const rolledBack = await native.admin.connect();
      try {
        await rolledBack.query('BEGIN');
        await rolledBack.query("SELECT pg_notify('neon_ws_events', 'rolled back')");
        await rolledBack.query('ROLLBACK');
      } finally {
        rolledBack.release();
      }
      await db.$notify('neon_ws_events', 'one');
      await deadline(next, 'first notification missing');
      next = new Promise<void>((resolve) => {
        received = resolve;
      });
      await db.$notify('neon_ws_events', 'two');
      await deadline(next, 'second notification missing');
      assert.deepEqual(messages, ['one', 'two']);
      const killed = await native.admin.query(
        "SELECT pg_terminate_backend(pid) AS killed FROM pg_stat_activity WHERE application_name = 'neon_ws_native' AND query = 'LISTEN \"neon_ws_events\"'",
      );
      assert.deepEqual(killed.rows, [{ killed: true }]);
      await deadline(reconnected, 'listener did not reconnect');
      assert.ok(errors.length >= 1);
      next = new Promise<void>((resolve) => {
        received = resolve;
      });
      await db.$notify('neon_ws_events', 'three');
      await deadline(next, 'post-reconnect notification missing');
      assert.deepEqual(messages, ['one', 'two', 'three']);
    } finally {
      await sub.unsubscribe();
      await sub.unsubscribe();
    }
  });
  it('refuses LISTEN without explicit session and persistent lifetime guarantees', async () => {
    for (const config of [{ sessionMode: 'transaction' as const }, { lifetime: 'invocation' as const }]) {
      const db = await owned(config);
      await assert.rejects(
        db.$listen('neon_ws_events', () => {}),
        /persistent backend session/,
      );
      await db.$transaction(async (tx) => {
        assert.deepEqual(await tx.raw`SELECT 9 AS n`, [{ n: 9 }]);
      });
    }
  });
  it('never ends caller-owned pools and releases only this binding’s checkouts', async () => {
    const pool = new driver.Pool(native.connection);
    const Base = driver.Client;
    pool.Client = class extends Base {
      constructor(config: unknown) {
        super(config);
        Object.assign(this.neonConfig, native.driver);
      }
    };
    try {
      const db = await turbineNeonWs({ pool: pool as NeonWsPool }, schema, options);
      assert.deepEqual(await db.raw`SELECT 10 AS n`, [{ n: 10 }]);
      await db.$listen('neon_ws_cleanup', () => {});
      await db.disconnect();
      await assert.rejects(db.rawQuery('SELECT 1'), /disconnected/);
      const external = await pool.connect();
      try {
        assert.deepEqual((await external.query('SELECT 11 AS n')).rows, [{ n: 11 }]);
      } finally {
        external.release();
      }
    } finally {
      await pool.end();
    }
  });
  it('uses a supplied connected Client exclusively, with pinned rollback and caller ownership', async () => {
    const client = new driver.Client(native.connection);
    Object.assign(client.neonConfig, native.driver);
    await client.connect();
    try {
      const db = await turbineNeonWs({ client: client as NeonWsClient }, schema, options);
      await db.transaction(async (tx) => {
        assert.deepEqual((await tx.query('SELECT 12 AS n')).rows, [{ n: 12 }]);
        await assert.rejects(db.rawQuery('SELECT 1'), /already leased/);
        await assert.rejects(db.disconnect(), /busy caller-owned/);
      });
      await assert.rejects(
        db.$listen('neon_ws_events', () => {}),
        /Pool with a dedicated/,
      );
      await assert.rejects(
        db.$transaction(async (tx) => {
          await tx.raw`INSERT INTO neon_ws_items VALUES (40, 'no')`;
          throw new Error('client rollback');
        }),
        /client rollback/,
      );
      assert.deepEqual((await client.query('SELECT id FROM neon_ws_items WHERE id=40')).rows, []);
      await db.disconnect();
      assert.deepEqual((await client.query('SELECT 13 AS n')).rows, [{ n: 13 }]);
    } finally {
      await client.end();
    }
  });
  it('aborts a real long-running query by destroying its pooled connection', async () => {
    const controller = new AbortController();
    const db = await owned({ signal: controller.signal });
    const pending = db.rawQuery('SELECT pg_sleep(20)');
    const rejected = assert.rejects(pending, /abort marker/);
    // Wait for a confirmed backend operation instead of timing the abort by assumption.
    await deadline(
      (async () => {
        for (let attempt = 0; attempt < 200; attempt++) {
          const running = await native.admin.query(
            "SELECT count(*)::integer AS n FROM pg_stat_activity WHERE application_name='neon_ws_native' AND query='SELECT pg_sleep(20)' AND state='active'",
          );
          if (running.rows[0].n === 1) return;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      })(),
      'query never reached PostgreSQL',
    );
    controller.abort(new Error('abort marker'));
    await deadline(rejected, 'aborted query did not reject');
    await db.disconnect();
    await assert.rejects(db.rawQuery('SELECT 1'), /abort marker/);
  });
  it('cleans up queued acquisition on abort and refuses an unconnected supplied Client', async () => {
    const unconnected = new driver.Client(native.connection);
    await assert.rejects(turbineNeonWs({ client: unconnected }, schema, options), /already be connected/);
    const controller = new AbortController();
    const db = await turbineNeonWs({ connection: { ...native.connection, max: 1 }, driver: native.driver }, schema, {
      ...options,
      signal: controller.signal,
    });
    const held = await db.pool.connect();
    const pending = db.rawQuery('SELECT 1');
    const rejected = assert.rejects(pending, /queued abort/);
    controller.abort(new Error('queued abort'));
    await deadline(rejected, 'queued acquisition did not abort');
    held.release();
    await deadline(db.disconnect(), 'owned pool did not close after queued abort');
  });
  it('invocation helper closes owned sessions on success and callback failure', async () => {
    for (const fail of [false, true]) {
      let escaped: TurbineClient | undefined;
      const result = withNeonWs(
        { connection: native.connection, driver: native.driver },
        schema,
        { sessionMode: 'persistent' },
        async (db) => {
          escaped = db;
          assert.deepEqual(await db.raw`SELECT 14 AS n`, [{ n: 14 }]);
          await assert.rejects(
            db.$listen('neon_ws_events', () => {}),
            /persistent lifetime/,
          );
          if (fail) throw new Error('invocation callback failed');
          return 14;
        },
      );
      if (fail) await assert.rejects(result, /invocation callback failed/);
      else assert.equal(await result, 14);
      assert.ok(escaped);
      await assert.rejects(escaped.rawQuery('SELECT 1'), /disconnected/);
    }
  });
  it('disconnect destroys an outstanding transaction lease and is idempotent', async () => {
    const db = await owned();
    let ready!: () => void;
    let proceed!: () => void;
    const began = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      proceed = resolve;
    });
    const transaction = db.$transaction(async (tx) => {
      await tx.raw`INSERT INTO neon_ws_items VALUES (50, 'discard')`;
      ready();
      await gate;
      await tx.raw`SELECT 1`;
    });
    const rejected = assert.rejects(transaction, /disconnected|connection|released/i);
    await began;
    const disconnected = await db.disconnect({ timeoutMs: 100 });
    assert.equal(disconnected.forcedConnections, 1);
    proceed();
    await rejected;
    await db.disconnect();
    assert.deepEqual((await native.admin.query('SELECT id FROM neon_ws_items WHERE id=50')).rows, []);
  });
  it('rejects fake or ambiguous sources rather than calling them Neon evidence', async () => {
    await assert.rejects(turbineNeonWs({ pool: {} } as never, schema, options), /actual @neondatabase/);
    await assert.rejects(
      turbineNeonWs({ connection: native.connection, pool: {} } as never, schema, options),
      /exactly one/,
    );
  });
});
