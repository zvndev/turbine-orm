import assert from 'node:assert/strict';
import { require } from './provenance.mjs';
import { MysqlPool, turbineMysql } from '../../src/mysql.ts';
import { ARMS, CAPACITY, checkEffect, checkRows, FLAGS, SHAPES } from './oracle.mjs';
import { createRoute, difference, schema, serverCount } from './routes.mjs';

const mysql = require('mysql2/promise');

export async function controls(config, observer, mode, fault, results = []) {
  const baseline = await serverCount(observer);
  for (const shape of SHAPES)
    for (const arm of ARMS) {
      const route = await createRoute(config, shape, arm);
      const record = (control, detail = {}) => results.push({ shape, arm, control, passed: true, ...detail });
      try {
        for (const id of [1, 4, 2, 3, 1]) (await route.run('read', id, 0))();
        record('precision-json-null-booleans-dates-unicode-buffer-parameter-changes');
        for (const n of [7, 9, 1]) {
          (await route.run('rollback', 1, n))();
          checkEffect((await observer.query('SELECT n FROM effects WHERE id=1'))[0], 0);
        }
        record('rollback-independent-observer');
        const beforeFailedPrepare = route.occupancy();
        await assert.rejects(route.query('SELECT missing_column FROM items WHERE id=:p1', [1]));
        assert.deepEqual(route.occupancy(), beforeFailedPrepare, 'failed preparation is not cached');
        await assert.rejects(route.query('INSERT INTO effects VALUES(:p1,:p2)', [1, 8]));
        await route.query('INSERT INTO effects VALUES(:p1,:p2)', [2, 17]);
        checkEffect((await observer.query('SELECT n FROM effects WHERE id=2'))[0], 17);
        await observer.query('DELETE FROM effects WHERE id=2');
        assert.equal((await observer.query('SELECT n FROM effects WHERE id=2'))[0].length, 0);
        (await route.run('read', 2, 0))();
        record('failed-prepare-and-failed-execute-reuse');
        await observer.query('CREATE TABLE changing(id INT PRIMARY KEY)');
        try {
          await observer.query('INSERT INTO changing VALUES(1)');
          assert.deepEqual({ ...(await route.query('SELECT * FROM changing WHERE id=:p1', [1]))[0] }, { id: 1 });
          await observer.query('ALTER TABLE changing ADD COLUMN added INT DEFAULT 7');
          assert.deepEqual(
            { ...(await route.query('SELECT * FROM changing WHERE id=:p1', [1]))[0] },
            { id: 1, added: 7 },
          );
          await observer.query('DROP TABLE changing');
          await assert.rejects(route.query('SELECT * FROM changing WHERE id=:p1', [1]));
          await observer.query('CREATE TABLE changing(id VARCHAR(10) PRIMARY KEY, label VARCHAR(10))');
          await observer.query("INSERT INTO changing VALUES(1,'changed')");
          assert.deepEqual(
            { ...(await route.query('SELECT * FROM changing WHERE id=:p1', [1]))[0] },
            { id: '1', label: 'changed' },
          );
          record('schema-change-drop-recreate-and-reuse');
        } finally {
          await observer.query('DROP TABLE IF EXISTS changing');
        }
        await observer.query(
          'CREATE TABLE bindings(id INT PRIMARY KEY, huge BIGINT, amount DECIMAL(30,9), payload JSON, optional_value TEXT, enabled TINYINT(1), stamp DATETIME(3), label TEXT, bytes VARBINARY(20))',
        );
        try {
          const unsafeText = mode === 'ansi-no-backslash' && arm.startsWith('text');
          for (let id = 1; id <= 2; id++) {
            const values = [
              id,
              '9007199254740993',
              '123456789012345678901.123456789',
              unsafeText ? null : JSON.stringify({ x: [null, true, '雪😀', '\\"'] }),
              null,
              id % 2,
              new Date('2024-02-03T12:34:56.789Z'),
              unsafeText ? '雪' : `雪😀 quote' slash\\`,
              Buffer.from([0, 255, 39, 92]),
            ];
            await route.query('INSERT INTO bindings VALUES(:p1,:p2,:p3,:p4,:p5,:p6,:p7,:p8,:p9)', values);
            const [rows] = await observer.query('SELECT * FROM bindings WHERE id=?', [id]);
            const actual = { ...rows[0] };
            assert.deepEqual(actual, {
              id,
              huge: values[1],
              amount: values[2],
              payload: values[3] === null ? null : JSON.parse(values[3]),
              optional_value: null,
              enabled: id % 2,
              stamp: values[6],
              label: values[7],
              bytes: values[8],
            });
          }
          record('binding-effects-independent-observer', { restrictedTextEscaping: unsafeText });
          if (unsafeText) {
            const input = `quote' slash\\ 雪😀`;
            let observed, error;
            try {
              observed = (await route.query('SELECT :p1 AS v', [input]))[0].v;
            } catch (failure) {
              error = { code: failure.code, errno: failure.errno };
            }
            assert.ok(error || observed !== input, 'expected pinned text-escaping incompatibility was not reproduced');
            results.push({
              shape,
              arm,
              control: 'text-escaping-no-backslash',
              status: 'unsupported',
              input,
              observed,
              error,
              reason:
                'mysql2 text formatting uses backslash escaping; arbitrary quoted/backslash string bindings are excluded in this mode.',
            });
          }
        } finally {
          await observer.query('DROP TABLE IF EXISTS bindings');
        }
        await route.clear();
        const before = await route.counters();
        const memory = [];
        for (let i = 0; i < CAPACITY * 8; i++) {
          const rows = await route.query(`SELECT :p1 AS n /* shape ${i} */`, [i]);
          checkEffect(rows, i);
          const serverBeforeDrain = await serverCount(observer);
          await route.drain();
          const occupancy = route.occupancy(),
            server = await serverCount(observer);
          const driver = occupancy.driver.reduce((n, d) => n + d.size, 0);
          assert.ok(
            serverBeforeDrain >= baseline + driver && serverBeforeDrain <= baseline + driver + occupancy.connections,
            'bounded pending COM_STMT_CLOSE occupancy',
          );
          assert.equal(
            server - baseline,
            driver,
            'server and driver occupancy match on owned server after protocol drain',
          );
          assert.ok(server <= baseline + CAPACITY * (shape === 'pool' ? FLAGS.connectionLimit : 1));
          memory.push({ i, ...process.memoryUsage(), occupancy, server, serverBeforeDrain });
        }
        const delta = difference(await route.counters(), before);
        if (!arm.startsWith('text')) {
          assert.equal(
            delta.Com_stmt_prepare - delta.Com_stmt_reprepare,
            CAPACITY * 8,
            `${shape}/${arm} churn prepares: ${JSON.stringify(delta)}`,
          );
          assert.ok(delta.Com_stmt_close > 0);
        } else assert.equal(delta.Com_stmt_prepare, 0);
        if (fault === 'bounds')
          assert.ok(route.occupancy().js > CAPACITY * FLAGS.connectionLimit, 'forced bounds fault');
        record('bounded-churn-driver-js-server', { delta, memory, occupancy: route.occupancy() });
        await route.clear();
        assert.equal(await serverCount(observer), baseline);
      } finally {
        await route.close();
      }
      assert.equal(await serverCount(observer), baseline, 'route statements cleaned after close');
      await assert.rejects(route.run('read', 1, 0), /closed/);
      await assert.rejects(route.target.query('SELECT 1'));
      record('closed-route-and-native-handle');
    }
  // Explicit stale prepared handle: close through unprepare, drain, reject old handle,
  // then create a fresh handle with the same SQL. Never reuse across physical sessions.
  const conn = await mysql.createConnection({ ...config, ...FLAGS });
  try {
    const stmt = await conn.prepare('SELECT ? AS n');
    checkEffect((await stmt.execute([1]))[0], 1);
    conn.unprepare('SELECT ? AS n');
    await conn.query('SELECT 1');
    await assert.rejects(stmt.execute([2]), (e) => e.errno === 1243);
    checkEffect((await conn.execute('SELECT ? AS n', [3]))[0], 3);
    results.push({ control: 'closed-statement-rejects-and-fresh-reuse', passed: true });
  } finally {
    await conn.end();
  }
  const pool = mysql.createPool({ ...config, ...FLAGS, connectionLimit: 1 });
  const shim = new MysqlPool(pool);
  let client, raw;
  try {
    client = await shim.connect();
    let settled = false;
    const waiting = shim.query('SELECT :p1 AS n', [9]).then((r) => {
      settled = true;
      return r;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, 'pool checkout ownership');
    assert.equal(pool.pool._connectionQueue.length, 1, 'waiting query is actually queued behind the owned checkout');
    checkEffect((await client.query('SELECT :p1 AS n', [7])).rows, 7);
    client.release();
    client.release();
    checkEffect((await waiting).rows, 9);
    assert.equal(pool.pool._connectionQueue.length, 0);
    await assert.rejects(client.query('SELECT 1'), /released/);
    raw = await pool.getConnection();
    const id = raw.connection.threadId;
    raw.release();
    const borrowed = await turbineMysql(pool, schema, { logger: {}, warnOnUnlimited: false });
    await borrowed.disconnect();
    checkEffect((await pool.query('SELECT 8 AS n'))[0], 8);
    results.push({ control: 'pool-checkout-released-handle-and-borrowed-ownership', id, passed: true });
  } finally {
    client?.release();
    await pool.end();
  }
  // Owned factory intentionally adds NO_BACKSLASH_ESCAPES: only certify ownership here,
  // not a comparison against injected pools which preserve the server startup mode.
  const pair = mysql.createPool({ ...config, ...FLAGS, connectionLimit: 2 });
  let first, second;
  try {
    first = await pair.getConnection();
    second = await pair.getConnection();
    assert.notEqual(first.connection.threadId, second.connection.threadId);
    const a = await first.prepare('SELECT ? AS n'),
      b = await second.prepare('SELECT ? AS n');
    assert.notEqual(a.statement._connection, b.statement._connection);
    checkEffect((await a.execute([11]))[0], 11);
    checkEffect((await b.execute([22]))[0], 22);
    first.release();
    first = null;
    checkEffect((await b.execute([33]))[0], 33);
    results.push({ control: 'physical-session-prepared-ownership', passed: true });
  } finally {
    first?.release();
    second?.release();
    await pair.end();
  }
  const owned = await turbineMysql(config, schema, { logger: {}, connectionLimit: 1 });
  try {
    checkRows(await owned.items.findMany({ where: { id: 1 }, limit: 1 }), 1, true);
  } finally {
    await owned.disconnect();
  }
  await assert.rejects(owned.items.findMany({ where: { id: 1 }, limit: 1 }));
  results.push({ control: 'owned-factory-close', passed: true });
  assert.equal(await serverCount(observer), baseline);
  return results;
}
