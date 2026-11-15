import assert from 'node:assert/strict';
import { BATCH_SIZE, digest, ROW_COUNT } from './workload.mjs';

// The promise pool is shared with every other arm. Only the checked-out
// connection's callback API can deliver rows without collecting result arrays.
export async function rawMysqlDrain(pool, sample) {
  const client = await pool.getConnection();
  let complete = false;
  try {
    await client.beginTransaction();
    const sink = digest();
    let count = 0;
    const command = client.connection.query('SELECT id, label, value, note FROM evidence_items ORDER BY id ASC');
    for await (const row of command.stream({ highWaterMark: 1 })) {
      sink.row(row);
      if (++count % BATCH_SIZE === 0) sample();
    }
    await client.commit();
    complete = true;
    return sink.finish();
  } finally {
    // A partially consumed wire result cannot be returned to the shared pool.
    if (complete) client.release();
    else client.destroy();
  }
}

export function assertMysqlRoute(route) {
  assert.equal(route.driver, 'mysql2', 'Wrong native driver');
  assert.equal(route.physicalConnections, 1, 'Native drain changed physical connection');
  assert.ok(route.pauseCalls > 0 && route.resumeCalls > 0, 'Native route must exercise driver backpressure');
  assert.ok(route.statements.some((sql) => /^\s*(BEGIN|START TRANSACTION)\s*$/i.test(sql)), 'Native route missing BEGIN');
  assert.ok(route.statements.some((sql) => /^\s*COMMIT\s*$/i.test(sql)), 'Native route missing COMMIT');
  const selects = route.commands.filter((command) => /^\s*SELECT\b/i.test(command.sql) && !/\bLIMIT\b/i.test(command.sql));
  assert.equal(selects.length, 1, 'Native route must execute exactly one unbounded SELECT');
  const command = selects[0];
  const begin = route.statements.findIndex((sql) => /^\s*(BEGIN|START TRANSACTION)\s*$/i.test(sql));
  const select = route.statements.indexOf(command.sql);
  const commit = route.statements.findIndex((sql) => /^\s*COMMIT\s*$/i.test(sql));
  assert.ok(begin < select && select < commit, 'Native SELECT must run inside its transaction');
  assert.ok(['query', 'execute'].includes(command.method), 'Wrong native command method');
  assert.match(command.sql, /\bFROM\s+`?evidence_items`?\b/i, 'Wrong native table');
  assert.ok(['Query', 'Execute'].includes(command.commandClass), 'Not an actual mysql2 command');
  assert.equal(command.callback, false, 'Native route used a materializing result callback');
  assert.equal(command.fieldsEvents, 1, 'Native route must observe one real row result set');
  assert.equal(command.rowEvents, ROW_COUNT, 'Native route must observe every driver result event');
  assert.equal(command.retainedRowsAtEnd, 0, 'Native route retained a materialized driver row array');
  assert.equal(command.ended, true, 'Native driver command did not finish');
}

/** Untimed observation of the pinned driver's actual commands, independent of
 * the consumer digest. Restore the exact methods even when the arm fails. */
export async function auditMysqlNative(context, arm) {
  const client = await context.native.getConnection();
  const connection = client.connection;
  const threadId = connection.threadId;
  const originals = Object.fromEntries(['query', 'execute', 'pause', 'resume'].map((key) => [key, connection[key]]));
  const route = { driver: 'mysql2', physicalConnections: 1, statements: [], commands: [], pauseCalls: 0, resumeCalls: 0 };
  for (const key of ['query', 'execute']) {
    connection[key] = function (...args) {
      const command = originals[key].apply(this, args);
      const sql = typeof args[0] === 'string' ? args[0] : args[0].sql;
      route.statements.push(sql);
      const record = { sql, method: key, commandClass: command.constructor.name, callback: typeof command.onResult === 'function',
        fieldsEvents: 0, rowEvents: 0, retainedRowsAtEnd: null, ended: false };
      route.commands.push(record);
      command.on('fields', () => { record.fieldsEvents++; });
      command.on('result', () => { record.rowEvents++; });
      command.once('end', () => {
        // mysql2 keeps one array per result set even for callbackless commands;
        // its contents must stay empty. This is intentionally version-pinned.
        record.retainedRowsAtEnd = command._rows.reduce((sum, rows) => sum + (Array.isArray(rows) ? rows.length : 1), 0);
        record.ended = true;
      });
      return command;
    };
  }
  for (const key of ['pause', 'resume']) connection[key] = function (...args) {
    route[`${key}Calls`]++;
    return originals[key].apply(this, args);
  };
  // Releasing the one connection lets both raw and Turbine use it normally.
  client.release();
  const getConnection = context.native.getConnection;
  context.native.getConnection = async function (...args) {
    const acquired = await getConnection.apply(this, args);
    if (acquired.connection !== connection || acquired.connection.threadId !== threadId) route.physicalConnections++;
    return acquired;
  };
  let value;
  try { value = await arm.native(0, () => {}); }
  finally {
    context.native.getConnection = getConnection;
    for (const [key, original] of Object.entries(originals)) connection[key] = original;
  }
  assertMysqlRoute(route);
  return { value, route };
}
