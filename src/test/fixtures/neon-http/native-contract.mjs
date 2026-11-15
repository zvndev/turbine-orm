import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { assertLoopback, localBridge } from './native-bridge.mjs';

function table(name, fields, relations = {}) {
  const columns = fields.map(([field, pgType]) => ({
    name: field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
    field,
    pgType,
    nullable: false,
    hasDefault: false,
    isPrimaryKey: field === 'id',
    isUnique: field === 'id',
  }));
  return {
    name,
    columns,
    relations,
    indexes: [],
    primaryKey: ['id'],
    uniqueColumns: [['id']],
    columnMap: Object.fromEntries(columns.map((c) => [c.field, c.name])),
    reverseColumnMap: Object.fromEntries(columns.map((c) => [c.name, c.field])),
    allColumns: columns.map((c) => c.name),
    dateColumns: new Set(),
    pgTypes: Object.fromEntries(columns.map((c) => [c.name, c.pgType])),
    dialectTypes: Object.fromEntries(columns.map((c) => [c.name, c.pgType])),
  };
}

// Identical native assertions for source and actual installed ESM/CJS consumers.
export async function nativeContract({ turbineNeonHttp, neon, neonConfig, pg, test, scope }) {
  const url = process.env.NEON_HTTP_NATIVE_URL;
  assert.ok(url, 'NEON_HTTP_NATIVE_URL required; protocol fixtures are not native evidence');
  assertLoopback(url);
  const admin = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  await admin.connect();
  const bridge = await localBridge(pg, url).catch(async (error) => {
    await admin.end();
    throw error;
  });
  const originalFetch = globalThis.fetch;
  const originalConfig = Object.getOwnPropertyDescriptors(neonConfig);
  const routes = [];
  globalThis.fetch = (endpoint, init) => {
    routes.push(String(endpoint));
    return originalFetch(bridge.endpoint, init);
  };
  const suffix = `${process.pid}_${Date.now()}`;
  const accounts = `http_accounts_${suffix}`;
  const posts = `http_posts_${suffix}`;
  const settings = `http_settings_${suffix}`;
  const schema = {
    enums: {},
    tables: {
      [accounts]: table(
        accounts,
        [
          ['id', 'int4'],
          ['tenantId', 'int4'],
          ['displayName', 'text'],
        ],
        {
          posts: {
            type: 'hasMany',
            name: 'posts',
            from: accounts,
            to: posts,
            foreignKey: 'account_id',
            referenceKey: 'id',
          },
        },
      ),
      [posts]: table(
        posts,
        [
          ['id', 'int4'],
          ['accountId', 'int4'],
          ['tenantId', 'int4'],
          ['title', 'text'],
        ],
        {
          account: {
            type: 'belongsTo',
            name: 'account',
            from: posts,
            to: accounts,
            foreignKey: 'account_id',
            referenceKey: 'id',
          },
        },
      ),
      [settings]: table(settings, [
        ['id', 'int4'],
        ['level', 'text'],
        ['readOnly', 'text'],
        ['deferrable', 'text'],
      ]),
    },
  };
  const sql = neon(url);
  const options = { globalFilters: { [accounts]: { tenantId: 4 }, [posts]: { tenantId: 4 } } };
  const db = turbineNeonHttp(sql, schema, options);
  const objectDb = turbineNeonHttp(sql, schema, { ...options, jsonEncoding: 'object' });
  const at = db.table(accounts);
  const report = {
    scope,
    runtime: process.version,
    pid: process.pid,
    pgid: Number(readFileSync(`/proc/${process.pid}/stat`, 'utf8').split(') ')[1].split(' ')[2]),
    evidence: 'local HTTP-to-PG bridge; no hosted/official proxy certification',
    cases: [],
    failures: [],
  };
  const check = (name, fn) =>
    test(name, async () => {
      try {
        await fn();
        report.cases.push(name);
      } catch (error) {
        report.failures.push({ name, error: error.stack });
        throw error;
      }
    });
  const snapshot = async () =>
    (await admin.query(`SELECT id,tenant_id,display_name FROM "${accounts}" ORDER BY id`)).rows;
  let release;
  try {
    report.serverVersion = (await admin.query('SHOW server_version')).rows[0].server_version;
    if (process.env.NEON_HTTP_EXPECT_PG) assert.equal(report.serverVersion, process.env.NEON_HTTP_EXPECT_PG);
    await admin.query(
      `CREATE TABLE "${accounts}" (id integer PRIMARY KEY, tenant_id integer NOT NULL, display_name text NOT NULL)`,
    );
    await admin.query(
      `CREATE TABLE "${posts}" (id integer PRIMARY KEY, account_id integer REFERENCES "${accounts}"(id), tenant_id integer NOT NULL, title text NOT NULL)`,
    );
    await admin.query(
      `CREATE VIEW "${settings}" AS SELECT pg_backend_pid() AS id, current_setting('transaction_isolation') AS level, current_setting('transaction_read_only') AS read_only, current_setting('transaction_deferrable') AS deferrable`,
    );
    await admin.query(`INSERT INTO "${accounts}" VALUES (7,4,'Ada'),(8,5,'Hidden')`);
    await admin.query(`INSERT INTO "${posts}" VALUES (1,7,4,'A'),(2,7,4,'B'),(3,7,5,'Hidden'),(4,8,4,'Orphan')`);

    await check('actual network bindings and independent native write effects', async () => {
      const value = "bound ' value; DROP TABLE innocent; --";
      assert.deepEqual(await at.create({ data: { id: 9, tenantId: 4, displayName: value } }), {
        id: 9,
        tenantId: 4,
        displayName: value,
      });
      const native = (await snapshot()).find((row) => row.id === 9);
      assert.ok(native, 'independent native write effect missing');
      assert.equal(native.display_name, value, 'independent native effect must match actual bound value');
      const request = bridge.requests.at(-1);
      assert.ok(request.queries[0].params.includes(value));
      assert.ok(!request.queries[0].query.includes(value));
      assert.equal(routes.length, bridge.requests.length);
      assert.ok(routes.every((route) => route.startsWith('https://')));
    });

    await check('join and positional JSON decoding with parent and child global filters', async () => {
      assert.deepEqual(
        await at.findMany({ where: { id: 7 }, with: { posts: { orderBy: { id: 'desc' } } }, limit: 10 }),
        [
          {
            id: 7,
            tenantId: 4,
            displayName: 'Ada',
            posts: [
              { id: 2, accountId: 7, tenantId: 4, title: 'B' },
              { id: 1, accountId: 7, tenantId: 4, title: 'A' },
            ],
          },
        ],
      );
      const request = bridge.requests.at(-1);
      assert.match(request.queries[0].query, /json_build_array/);
      assert.ok(request.queries[0].params.filter((value) => value === '4').length >= 2);
      assert.equal(await at.count({ where: { id: 8 } }), 0);
      assert.equal((await snapshot()).find((row) => row.id === 8).display_name, 'Hidden');
    });

    await check('object JSON and actual flattened to-one join decoding', async () => {
      assert.deepEqual(
        await objectDb.table(posts).findMany({
          where: { id: { in: [1, 4] } },
          with: { account: true },
          orderBy: { id: 'asc' },
          limit: 10,
          relationLoadStrategy: 'flatten',
        }),
        [
          { id: 1, accountId: 7, tenantId: 4, title: 'A', account: { id: 7, tenantId: 4, displayName: 'Ada' } },
          { id: 4, accountId: 8, tenantId: 4, title: 'Orphan', account: null },
        ],
      );
      assert.match(bridge.requests.at(-1).queries[0].query, /LEFT JOIN/);
      assert.deepEqual(
        await objectDb
          .table(accounts)
          .findMany({ where: { id: 7 }, with: { posts: { orderBy: { id: 'asc' } } }, limit: 1 }),
        [
          {
            id: 7,
            tenantId: 4,
            displayName: 'Ada',
            posts: [
              { id: 1, accountId: 7, tenantId: 4, title: 'A' },
              { id: 2, accountId: 7, tenantId: 4, title: 'B' },
            ],
          },
        ],
      );
    });

    await check('native OIDs text values and bigint numeric date JSON array binary readings', async () => {
      const text =
        'SELECT $1::int8 AS big, $2::numeric AS decimal, $3::date AS day, $4::timestamptz AS instant, $5::jsonb AS json, $6::int[] AS array, $7::bytea AS bytes, $8::boolean AS flag';
      const params = [
        '9007199254740993',
        '123.4500',
        '2024-02-29',
        '2024-02-29T12:34:56.123Z',
        { nested: "it's real", nil: null },
        [3, 1, null],
        Buffer.from([0, 255, 39]),
        true,
      ];
      assert.deepEqual(await db.rawUnsafe(text, params), [
        {
          big: '9007199254740993',
          decimal: '123.4500',
          day: new Date('2024-02-29T00:00:00Z'),
          instant: new Date('2024-02-29T12:34:56.123Z'),
          json: params[4],
          array: params[5],
          bytes: params[6],
          flag: true,
        },
      ]);
      const wire = bridge.requests.at(-1);
      assert.deepEqual(
        wire.results[0].fields.map((field) => field.dataTypeID),
        [20, 1700, 1082, 1184, 3802, 1007, 17, 16],
      );
      assert.ok(wire.results[0].rows[0].every((value) => typeof value === 'string'));
      assert.deepEqual(wire.queries[0].params, [
        '9007199254740993',
        '123.4500',
        '2024-02-29',
        '2024-02-29T12:34:56.123Z',
        JSON.stringify(params[4]),
        '{"3","1",NULL}',
        '\\x00ff27',
        'true',
      ]);
    });

    await check('one pinned native transaction preserves batch ordering and commits effects', async () => {
      const before = bridge.requests.length;
      const results = await db.$transaction(
        [
          db.table(settings).buildFindMany({ limit: 1 }),
          at.buildUpdateMany({ where: { id: 7 }, data: { displayName: 'Committed' } }),
          at.buildFindMany({ where: { id: 7 }, limit: 1 }),
          db.table(settings).buildFindMany({ limit: 1 }),
        ],
        { isolationLevel: 'RepeatableRead', readOnly: false, deferrable: false },
      );
      assert.equal(bridge.requests.length, before + 1);
      assert.deepEqual(results[1], { count: 1 });
      assert.deepEqual(results[2], [{ id: 7, tenantId: 4, displayName: 'Committed' }]);
      assert.deepEqual(results[0], results[3]);
      assert.deepEqual(results[0], [
        { id: bridge.requests.at(-1).backendPid, level: 'repeatable read', readOnly: 'off', deferrable: 'off' },
      ]);
      assert.equal((await snapshot()).find((row) => row.id === 7).display_name, 'Committed');
      assert.equal(bridge.requests.at(-1).outcome, 'committed');
    });

    await check('middle failure rolls back first write and prevents third write with native errors', async () => {
      const before = await snapshot();
      const count = bridge.requests.length;
      await assert.rejects(
        db.batch([
          at.buildUpdateMany({ where: { id: 7 }, data: { displayName: 'Must roll back' } }),
          at.buildCreate({ data: { id: 9, tenantId: 4, displayName: 'Duplicate' } }),
          at.buildUpdateMany({ where: { id: 9 }, data: { displayName: 'Must never execute' } }),
        ]),
        (error) => error.code === '23505' && error.table === accounts && typeof error.constraint === 'string',
      );
      assert.equal(bridge.requests.length, count + 1);
      assert.equal(bridge.requests.at(-1).results.length, 1);
      assert.equal(bridge.requests.at(-1).outcome, 'rolled-back');
      assert.deepEqual(await snapshot(), before);
    });

    await check('native serializable read-only deferrable options and write refusal', async () => {
      const [rows] = await db.batch([db.table(settings).buildFindMany({ limit: 1 })], {
        isolationLevel: 'Serializable',
        readOnly: true,
        deferrable: true,
      });
      assert.deepEqual(rows, [
        { id: bridge.requests.at(-1).backendPid, level: 'serializable', readOnly: 'on', deferrable: 'on' },
      ]);
      const before = await snapshot();
      await assert.rejects(
        db.batch([at.buildUpdateMany({ where: { id: 7 }, data: { displayName: 'Read-only write' } })], {
          readOnly: true,
        }),
        (error) => error.code === '25006',
      );
      assert.deepEqual(await snapshot(), before);
    });

    await check('empty and invalid batches refuse without HTTP requests', async () => {
      const before = routes.length;
      assert.deepEqual(await db.batch([]), []);
      const query = at.buildFindMany({ limit: 1 });
      const foreign = objectDb.table(accounts).buildFindMany({ limit: 1 });
      for (const invoke of [
        () => db.batch([query, foreign]),
        () => db.batch([query, Promise.resolve([])]),
        () => db.batch([query], { isolationLevel: 'bogus' }),
        () => db.batch([query], { readOnly: 'yes' }),
      ])
        assert.throws(invoke);
      assert.equal(routes.length, before);
    });

    await check('batch keeps admitted transforms when the caller replaces an entry after native commit', async () => {
      let committed;
      const executed = new Promise((resolve) => {
        committed = resolve;
      });
      const held = new Promise((resolve) => {
        release = resolve;
      });
      bridge.onExecuted = async () => {
        committed();
        await held;
      };
      const queries = [at.buildUpdateMany({ where: { id: 7 }, data: { displayName: 'Batch snapshot' } })];
      const pending = db.batch(queries);
      await Promise.race([executed, pending]);
      assert.equal((await snapshot()).find((row) => row.id === 7).display_name, 'Batch snapshot');
      queries[0] = objectDb.table(accounts).buildFindMany({ limit: 1 });
      release();
      release = undefined;
      bridge.onExecuted = undefined;
      assert.deepEqual(await pending, [{ count: 1 }]);
      await bridge.drain();
    });

    await check('callbacks session listener stream rowlock and nested write refusal before effects', async () => {
      const before = routes.length;
      const nativeBefore = await snapshot();
      let invoked = 0;
      const callback = () => {
        invoked++;
        throw new Error('callback invoked');
      };
      for (const invoke of [
        () => db.transaction(callback),
        () => db.$transaction(callback),
        () => db.batch(callback),
        () => db.connect(),
        () => db.pipeline([]),
        () => db.$listen('events', callback),
        () => db.$notify('events', 'payload'),
        () => at.findManyStream(),
        () => at.findManyStreamBatches(),
        () => at.explain(),
        () => at.buildFindMany({ lock: 'share' }),
        () => db.rawUnsafe('BEGIN'),
        () => db.rawUnsafe("SET application_name='unsafe'"),
        () => db.rawUnsafe('SELECT pg_advisory_lock(1)'),
        () => db.rawUnsafe('LISTEN events'),
      ])
        assert.throws(invoke);
      await assert.rejects(at.findMany({ lock: 'update' }));
      await assert.rejects(
        at.create({ data: { id: 10, tenantId: 4, displayName: 'Nested', posts: { create: { title: 'Forbidden' } } } }),
      );
      await assert.rejects(at.upsert({ where: { id: 7 }, create: { id: 7 }, update: {} }));
      for (const strategy of ['batched', 'auto']) await assert.rejects(at.findMany({ relationLoadStrategy: strategy }));
      assert.equal(invoked, 0);
      assert.equal(routes.length, before);
      assert.deepEqual(await snapshot(), nativeBefore);
    });

    await check('abort before request preserves exact reason and has no native effects', async () => {
      const before = routes.length;
      const controller = new AbortController();
      const reason = { cancelled: 'before' };
      controller.abort(reason);
      const scoped = turbineNeonHttp(sql, schema, { ...options, signal: controller.signal });
      assert.throws(
        () => scoped.table(accounts),
        (error) => error === reason,
      );
      await assert.rejects(
        db.execute(at.buildUpdateMany({ where: { id: 7 }, data: { displayName: 'Aborted' } }), {
          signal: controller.signal,
        }),
        (error) => error === reason,
      );
      await assert.rejects(db.batch([at.buildCount()], { signal: controller.signal }), (error) => error === reason);
      await scoped.disconnect();
      assert.equal(routes.length, before);
    });

    await check('abort during actual native query makes one request and no retry claim', async () => {
      const controller = new AbortController();
      const reason = { cancelled: 'during' };
      const marker = `http_sleep_${suffix}`;
      const before = routes.length;
      const pending = db.rawUnsafe(`SELECT pg_sleep(0.4) AS slept /* ${marker} */`, [], { signal: controller.signal });
      const checked = assert.rejects(pending, (error) => error === reason);
      void checked.catch(() => {});
      let observed = false;
      for (let i = 0; i < 200; i++) {
        const result = await admin.query(
          "SELECT pid FROM pg_stat_activity WHERE state='active' AND query LIKE $1 AND pid<>pg_backend_pid()",
          [`%${marker}%`],
        );
        if (result.rowCount) {
          observed = true;
          break;
        }
        await delay(5);
      }
      assert.ok(observed, 'Must observe actual query executing in PostgreSQL before abort');
      controller.abort(reason);
      await checked;
      await bridge.drain();
      assert.equal(routes.length, before + 1);
    });

    await check('timeout after actual commit reports unknown outcome without retrying', async () => {
      let committed;
      const executed = new Promise((resolve) => {
        committed = resolve;
      });
      const held = new Promise((resolve) => {
        release = resolve;
      });
      bridge.onExecuted = async () => {
        committed();
        await held;
      };
      const before = routes.length;
      const pending = db.rawUnsafe(
        `UPDATE "${accounts}" SET display_name=$1 WHERE id=$2 RETURNING id`,
        ['Committed before delivery', 7],
        { timeoutMs: 1000 },
      );
      const checked = assert.rejects(pending, (error) => error.name === 'TimeoutError' && error.outcome === 'unknown');
      void checked.catch(() => {});
      await Promise.race([executed, pending]);
      assert.equal((await snapshot()).find((row) => row.id === 7).display_name, 'Committed before delivery');
      await checked;
      release();
      release = undefined;
      bridge.onExecuted = undefined;
      await bridge.drain();
      assert.equal(routes.length, before + 1);
    });

    await check('disconnect seals captured handles and restores caller ownership', async () => {
      const query = at.buildCount();
      await db.disconnect();
      const before = routes.length;
      await assert.rejects(at.findMany({ limit: 1 }));
      assert.throws(() => db.execute(query));
      assert.equal(routes.length, before);
      assert.deepEqual(await sql.query('SELECT 1 AS one'), [{ one: 1 }]);
      assert.deepEqual(Object.getOwnPropertyDescriptors(neonConfig), originalConfig);
    });
  } finally {
    // Restore routing even if a later cleanup check fails.
    globalThis.fetch = originalFetch;
    release?.();
    bridge.onExecuted = undefined;
    await db.disconnect();
    await objectDb.disconnect();
    await bridge.close();
    await admin.query(`DROP VIEW IF EXISTS "${settings}"`);
    await admin.query(`DROP TABLE IF EXISTS "${posts}"`);
    await admin.query(`DROP TABLE IF EXISTS "${accounts}"`);
    report.remainingObjects = (
      await admin.query('SELECT relname FROM pg_class WHERE relname=ANY($1)', [[settings, posts, accounts]])
    ).rows;
    assert.deepEqual(report.remainingObjects, []);
    await admin.end();
    report.bridge = {
      endpoint: bridge.endpoint,
      port: bridge.port,
      closed: bridge.closed,
      portClosed: bridge.portClosed,
      requests: bridge.requests,
    };
    report.fetchRestored = globalThis.fetch === originalFetch;
    report.configUnchanged = true;
    if (process.env.NEON_HTTP_NATIVE_REPORT)
      writeFileSync(process.env.NEON_HTTP_NATIVE_REPORT, JSON.stringify(report, null, 2));
  }
  assert.equal(report.failures.length, 0, 'Native acceptance cases failed');
  return report;
}
