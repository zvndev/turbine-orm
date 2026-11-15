import assert from 'node:assert/strict';
import { BATCH_SIZE, ROW_COUNT } from './workload.mjs';

/** Validate wire-observed rows and ordered commands, independently of the drain's return value. */
export function assertPgRoute(route) {
  assert.equal(route.driver, 'pg', 'Missing pg wire audit');
  assert.ok(Array.isArray(route.commands) && route.commands.length > 3, 'Missing PostgreSQL command results');
  assert.deepEqual(route.statements, route.commands.map((command) => command.sql));
  let cursor;
  let begun = false;
  let closed = false;
  let committed = false;
  let total = 0;
  let lastFetch;
  let probes = 0;
  for (const command of route.commands) {
    const { sql, rows, tags } = command;
    assert.ok(Number.isInteger(rows) && rows >= 0, 'Missing observed PostgreSQL row count');
    assert.ok(Array.isArray(tags) && tags.length > 0, 'Missing PostgreSQL command completion');
    assert.equal(committed, false, 'SQL after native COMMIT');
    if (/^SELECT "evidence_items"\.\* FROM "evidence_items" ORDER BY "id" ASC LIMIT \$1$/.test(sql)) {
      assert.equal(begun, false, 'Speculative read must precede the cursor transaction');
      assert.equal(++probes, 1, 'Repeated speculative materialization');
      assert.equal(rows, BATCH_SIZE + 1, 'Speculative read exceeded its documented bound');
      assert.deepEqual(tags, [`SELECT ${rows}`]);
    } else if (/^BEGIN(?:; SELECT set_config\('idle_in_transaction_session_timeout', CASE WHEN s\.setting::bigint > 0 AND s\.setting::bigint < \d+ THEN s\.setting ELSE '\d+' END, true\) FROM pg_settings s WHERE s\.name = 'idle_in_transaction_session_timeout')?$/.test(sql)) {
      assert.equal(begun, false, 'Multiple native transactions');
      assert.deepEqual(tags, sql === 'BEGIN' ? ['BEGIN'] : ['BEGIN', 'SELECT 1']);
      assert.equal(rows, sql === 'BEGIN' ? 0 : 1);
      begun = true;
    } else {
      const declaration = /^DECLARE ("[a-zA-Z0-9_]+"|[a-zA-Z0-9_]+) NO SCROLL CURSOR FOR SELECT (?:id, label, value, note|"evidence_items"\.\*) FROM (?:evidence_items|"evidence_items") ORDER BY (?:id|"id") ASC$/.exec(sql);
      const fetch = /^FETCH (\d+) FROM ("[a-zA-Z0-9_]+"|[a-zA-Z0-9_]+)$/.exec(sql);
      const close = /^CLOSE ("[a-zA-Z0-9_]+"|[a-zA-Z0-9_]+)$/.exec(sql);
      if (declaration) {
        assert.ok(begun && !cursor, 'DECLARE must follow BEGIN exactly once');
        cursor = declaration[1];
        assert.equal(rows, 0); assert.deepEqual(tags, ['DECLARE CURSOR']);
      } else if (fetch) {
        assert.ok(cursor && !closed, 'FETCH outside the open cursor');
        assert.equal(fetch[2], cursor, 'FETCH must use the declared cursor');
        assert.equal(Number(fetch[1]), BATCH_SIZE, 'Native FETCH must use the bounded batch size');
        assert.ok(rows <= BATCH_SIZE, 'Native FETCH materialized too many rows');
        assert.deepEqual(tags, [`FETCH ${rows}`]);
        assert.notEqual(lastFetch, 0, 'FETCH after exhausted cursor');
        lastFetch = rows; total += rows;
      } else if (close) {
        assert.ok(cursor && !closed, 'CLOSE outside the open cursor');
        assert.equal(close[1], cursor);
        assert.equal(lastFetch, 0, 'Cursor must be fully drained');
        assert.equal(total, ROW_COUNT, 'Every native row must arrive through bounded FETCH results');
        assert.equal(rows, 0); assert.deepEqual(tags, ['CLOSE CURSOR']); closed = true;
      } else if (sql === 'COMMIT') {
        assert.ok(closed, 'COMMIT must follow cursor CLOSE');
        assert.equal(rows, 0); assert.deepEqual(tags, ['COMMIT']); committed = true;
      } else assert.fail(`Unsupported PostgreSQL native audit statement: ${sql}`);
    }
  }
  assert.ok(begun && cursor && closed && committed, 'Incomplete native PostgreSQL cursor lifecycle');
}
