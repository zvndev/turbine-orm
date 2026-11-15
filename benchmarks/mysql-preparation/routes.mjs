import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { MysqlPool, turbineMysql } from '../../src/mysql.ts';
import { defineSchema } from '../../src/schema-builder.ts';
import { schemaDefToMetadata } from '../../src/schema-metadata.ts';
import { CAPACITY, checkEffect, checkRows, FLAGS } from './oracle.mjs';
import { require } from './provenance.mjs';

const mysql = require('mysql2/promise');
const toPositional = require('named-placeholders')();
export const schema = schemaDefToMetadata(
  defineSchema({
    items: {
      id: { type: 'integer', primaryKey: true },
      enabled: { type: 'boolean' },
      huge: { type: 'bigint' },
      amount: { type: 'numeric' },
      payload: { type: 'json' },
      nullable: { type: 'text', nullable: true },
      stamp: { type: 'timestamp' },
      bytes: { type: 'bytea' },
      label: { type: 'text' },
    },
  }),
);
export const UPDATE = 'UPDATE effects SET n = :p1 WHERE id = :p2';
export const EFFECT = 'SELECT n FROM effects WHERE id = :p1';
export async function serverCount(observer) {
  const [rows] = await observer.query("SHOW GLOBAL STATUS LIKE 'Prepared_stmt_count'");
  return Number(rows[0].Value);
}
export async function sessionCounters(conn) {
  const [rows] = await conn.query(
    "SHOW SESSION STATUS WHERE Variable_name IN ('Com_stmt_prepare','Com_stmt_execute','Com_stmt_close','Com_stmt_reprepare')",
  );
  const result = Object.fromEntries(rows.map((r) => [r.Variable_name, Number(r.Value)]));
  assert.equal(Object.keys(result).length, 4, 'native protocol counters required');
  return result;
}
export function difference(after, before) {
  return Object.fromEntries(Object.keys(after).map((k) => [k, after[k] - (before[k] ?? 0)]));
}
export async function createRoute(config, shape, arm) {
  const start = performance.now();
  const connections = new Set(),
    prepared = new Map(),
    checkoutSamples = [],
    wire = [];
  let target,
    closed = false,
    db,
    sql;
  const remember = (raw) => {
    connections.add(raw);
    for (const method of ['query', 'execute']) {
      const original = raw[method];
      raw[method] = function (...args) {
        if (wire.length === 64) wire.shift();
        wire.push({ method, sql: typeof args[0] === 'string' ? args[0] : args[0]?.sql });
        return original.apply(this, args);
      };
    }
  };
  try {
    if (shape === 'connection') {
      target = await mysql.createConnection({ ...config, ...FLAGS });
      remember(target.connection);
    } else {
      target = mysql.createPool({ ...config, ...FLAGS });
      target.pool.on('connection', remember);
      const get = target.pool.getConnection.bind(target.pool);
      target.pool.getConnection = (callback) => {
        const began = performance.now();
        return get((error, conn) => {
          checkoutSamples.push({ ms: performance.now() - began, id: conn?.threadId ?? null, failed: !!error });
          callback(error, conn);
        });
      };
      // Separate physical initialization from timed lazy pool checkout.
      const first = await target.getConnection(),
        second = await target.getConnection();
      first.release();
      second.release();
    }
    const facade =
      shape === 'pool'
        ? target
        : {
            query: target.query.bind(target),
            execute: target.execute.bind(target),
            getConnection: async () => ({
              query: target.query.bind(target),
              execute: target.execute.bind(target),
              release() {},
              connection: target.connection,
            }),
            end: async () => {},
          };
    const shim = new MysqlPool(facade);
    db = await turbineMysql(shim, schema, {
      logger: {},
      warnOnUnlimited: false,
      diagnostics: { advice: false, cacheCheck: 'off' },
    });
    sql = db.items.buildFindMany({ where: { id: 1 }, limit: 1 }).sql;
    assert.match(sql, /:p1/);
    assert.match(sql, /LIMIT 1/);
    const initMs = performance.now() - start;
    async function native(sql, values = [], runner = target) {
      const binding = Object.fromEntries(values.map((v, i) => [`p${i + 1}`, v]));
      if (!values.length) return (await runner.query(sql))[0];
      if (arm === 'text' || arm === 'text-control') return (await runner.query(sql, binding))[0];
      if (arm !== 'prepared') return (await runner.execute(sql, binding))[0];
      const conn = shape === 'pool' && runner === target ? await target.getConnection() : runner;
      const raw = conn.connection;
      try {
        let entries = prepared.get(raw);
        if (!entries) {
          entries = new Map();
          prepared.set(raw, entries);
        }
        const [positional, args] = toPositional(sql, binding);
        let statement = entries.get(positional);
        if (!statement) {
          if (entries.size === CAPACITY) {
            const first = entries.keys().next().value;
            conn.unprepare(first);
            entries.delete(first);
          }
          statement = await conn.prepare(positional);
          entries.set(positional, statement);
        }
        const result = (await statement.execute(args))[0];
        return result;
      } finally {
        if (conn !== runner) conn.release();
      }
    }
    async function query(sql, values = [], runner) {
      if (arm.startsWith('turbine')) return (await (runner ?? shim).query(sql, values)).rows;
      return native(sql, values, runner);
    }
    return {
      arm,
      shape,
      target,
      shim,
      db,
      connections,
      prepared,
      checkoutSamples,
      wire,
      sql,
      initMs,
      query,
      async run(name, id, n, fault) {
        if (closed) throw new Error('Harness route is closed');
        if (name === 'read') {
          const rows =
            arm === 'turbine-orm' ? await db.items.findMany({ where: { id }, limit: 1 }) : await query(sql, [id]);
          if (fault === 'effect') rows[0].huge = 'rounded';
          // Verification is outside each measured operation in run.mjs.
          return () => checkRows(rows, id, arm.startsWith('turbine'));
        }
        const marker = new Error('intentional rollback');
        let observed;
        if (arm === 'turbine-orm') {
          await assert.rejects(
            db.$transaction(async (tx) => {
              await tx.rawUnsafe('UPDATE effects SET n = $1 WHERE id = $2', n, 1);
              observed = await tx.rawUnsafe('SELECT n FROM effects WHERE id = $1', 1);
              throw marker;
            }),
            (e) => e === marker,
          );
        } else {
          const conn = arm === 'turbine-shim' ? null : shape === 'pool' ? await target.getConnection() : target;
          const runner = arm === 'turbine-shim' ? await shim.connect() : conn;
          try {
            await (arm === 'turbine-shim'
              ? runner.query('START TRANSACTION')
              : native('START TRANSACTION', [], runner));
            await query(UPDATE, [n, 1], runner);
            observed = await query(EFFECT, [1], runner);
          } finally {
            try {
              await (arm === 'turbine-shim' ? runner.query('ROLLBACK') : native('ROLLBACK', [], runner));
            } finally {
              if (arm === 'turbine-shim') runner.release();
              else if (shape === 'pool') conn.release();
            }
          }
        }
        return () => checkEffect(observed, fault === 'effect' ? n + 1 : n);
      },
      async counters() {
        const totals = { Com_stmt_prepare: 0, Com_stmt_execute: 0, Com_stmt_close: 0, Com_stmt_reprepare: 0 };
        for (const conn of connections) {
          const one = await sessionCounters(conn.promise());
          for (const key of Object.keys(totals)) totals[key] += one[key];
        }
        return totals;
      },
      occupancy() {
        const driver = [...connections].map((c) => ({ id: c.threadId, size: c._statements.size }));
        const js = [...prepared.values()].reduce((n, m) => n + m.size, 0);
        assert.ok(
          driver.every((d) => d.size <= CAPACITY),
          'driver statement cache capacity',
        );
        assert.ok(js <= CAPACITY * FLAGS.connectionLimit, 'JS statement cache capacity');
        assert.ok(connections.size <= (shape === 'pool' ? FLAGS.connectionLimit : 1));
        return { driver, js, connections: connections.size };
      },
      async drain() {
        for (const conn of connections) await conn.promise().query('SELECT 1');
      },
      async clear() {
        for (const conn of connections) {
          // Statement cache is per physical connection; COM_STMT_CLOSE is drained by SELECT.
          for (const stmt of [...conn._statements.values()]) conn.unprepare(stmt.query);
          await conn.promise().query('SELECT 1');
        }
        prepared.clear();
      },
      async close() {
        if (closed) return;
        closed = true;
        try {
          await db.disconnect();
        } finally {
          prepared.clear();
          await target.end();
        }
      },
    };
  } catch (error) {
    try {
      await db?.disconnect();
    } finally {
      await target?.end();
    }
    throw error;
  }
}
