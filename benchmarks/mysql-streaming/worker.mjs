import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  admittedRuntime,
  cases,
  canonical,
  checkRow,
  COLUMNS,
  expected,
  finalize,
  FLAGS,
  sink,
  SQL,
} from './oracle.mjs';
import { rootDriver } from './driver.mjs';
import { validateSample } from './validate.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
function treeHash(dir) {
  const h = createHash('sha256');
  function visit(p) {
    for (const e of readdirSync(p, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === 'results') continue;
      const next = join(p, e.name);
      if (e.isDirectory()) visit(next);
      else {
        h.update(next.slice(dir.length));
        h.update(readFileSync(next));
      }
    }
  }
  visit(dir);
  return h.digest('hex');
}
const [output, caseId] = process.argv.slice(2);
assert.ok(output, 'required report output');
const report = {
  format: 'mysql-streaming-sample-v1',
  status: 'running',
  cleanupErrors: [],
  commands: [],
  sessionIds: [],
  pauseCalls: 0,
  resumeCalls: 0,
  destroyCalls: 0,
  driverLeadMax: 0,
  batches: [],
  actualRows: 0,
  actualPayloadBytes: 0,
  delays: 0,
};
let admin, observer, native, caller, db, database, active, interrupted, sampler, originalPush;
async function serverCounters(conn) {
  const [rows] = await conn.query(
    "SHOW GLOBAL STATUS WHERE Variable_name IN ('Sort_rows','Sort_scan','Sort_range','Sort_merge_passes','Created_tmp_tables','Created_tmp_disk_tables','Com_stmt_prepare','Com_stmt_execute','Com_stmt_close','Bytes_sent')",
  );
  assert.equal(rows.length, 10);
  return Object.fromEntries(rows.map((r) => [r.Variable_name, Number(r.Value)]));
}
const interrupt = (name) => {
  interrupted = name;
  active?.abort(new Error(name));
};
const term = () => interrupt('SIGTERM'),
  int = () => interrupt('SIGINT');
process.on('SIGTERM', term);
process.on('SIGINT', int);
const fault = process.env.MYSQL_STREAM_FAULT;
try {
  admittedRuntime(process.version);
  assert.ok(
    process.env.MYSQL_STREAM_IDENTITY,
    'required native MySQL owned-service identity missing; no fallback/skip',
  );
  const identity = JSON.parse(readFileSync(process.env.MYSQL_STREAM_IDENTITY));
  assert.equal(identity.ownerUid, process.getuid());
  assert.equal(identity.status, 'ready');
  process.kill(identity.pid, 0);
  assert.ok(
    [undefined, 'materialize', 'effect', 'cancel', 'cleanup', 'finalize', 'signal'].includes(fault),
    'unknown fault',
  );
  const c = cases().find((c) => c.id === caseId);
  assert.ok(c, 'unknown workload case');
  report.config = c;
  const driver = rootDriver();
  assert.ok(process.env.MYSQL_STREAM_ARTIFACT, 'required inherited artifact fingerprint missing');
  report.provenance = {
    node: process.version,
    versions: process.versions,
    pid: process.pid,
    nodeSha256: sha(process.execPath),
    driverVersion: driver.identity.version,
    driverRoutes: driver.identity,
    driverIntegrity: driver.identity.integrity,
    driverSha256: treeHash(join(driver.driverRoot, 'lib')),
    sourceSha256: treeHash(join(root, 'src')),
    harnessSha256: treeHash(join(root, 'benchmarks/mysql-streaming')),
    lockSha256: sha(join(root, 'package-lock.json')),
    serverSha256: identity.binarySha256,
    sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    sourceStatus: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
    executed: 'source',
    inheritedArtifact: { sha256: sha(process.env.MYSQL_STREAM_ARTIFACT), exercised: false },
  };
  report.service = { data: identity.data, port: identity.port, pid: identity.pid, root: identity.root };
  const mysql = driver.mysql;
  const { turbineMysql } = await import('../../src/mysql.ts');
  const { defineSchema } = await import('../../src/schema-builder.ts');
  const { schemaDefToMetadata } = await import('../../src/schema-metadata.ts');
  const config = { ...FLAGS, host: '127.0.0.1', port: identity.port, user: 'root' };
  admin = await mysql.createConnection(config);
  const [facts] = await admin.query(
    'SELECT VERSION() AS version, @@sql_mode AS sqlMode, @@datadir AS datadir, @@port AS port, @@sort_buffer_size AS sortBufferSize, @@read_buffer_size AS readBufferSize, @@read_rnd_buffer_size AS readRndBufferSize, @@net_buffer_length AS netBufferLength, @@max_allowed_packet AS maxAllowedPacket, @@innodb_buffer_pool_size AS innodbBufferPoolSize',
  );
  report.server = { ...facts[0], mode: identity.mode };
  assert.equal(report.server.version, '8.4.0');
  assert.equal(report.server.port, identity.port);
  assert.equal(report.server.datadir, identity.data + '/');
  for (const m of ['ANSI_QUOTES', 'NO_BACKSLASH_ESCAPES'])
    assert.equal(report.server.sqlMode.split(',').includes(m), identity.mode !== 'default');
  database = `stream_${randomBytes(8).toString('hex')}`;
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
  report.database = database;
  observer = await mysql.createConnection({ ...config, database });
  await observer.query(
    'CREATE TABLE items(id INT PRIMARY KEY, enabled TINYINT(1), huge BIGINT, amount DECIMAL(30,9), prefs JSON, stamp DATETIME(3), bytes VARBINARY(8), label VARCHAR(64), payload MEDIUMTEXT)',
  );
  await observer.query('CREATE TABLE effects(id INT PRIMARY KEY, n INT NOT NULL)');
  await observer.query('INSERT INTO effects VALUES(1,0)');
  // Parameterized binary inserts, bounded fixture chunks, never text-escape payloads.
  for (let start = 1; start <= c.count; start += 100) {
    const values = [],
      tuples = [];
    for (let id = start; id <= Math.min(start + 99, c.count); id++) {
      const r = expected(id, c.payloadSize);
      values.push(
        r.id,
        r.enabled,
        r.huge,
        r.amount,
        JSON.stringify(r.prefs),
        r.stamp,
        r.bytes,
        r.label,
        r.payload,
      );
      tuples.push('(?,?,?,?,?,?,?,?,?)');
    }
    await observer.execute(`INSERT INTO items VALUES ${tuples.join(',')}`, values);
  }
  // Small, finite server work makes eventual socket-abort settlement observable.
  await observer.query(
    `CREATE VIEW slow_items AS SELECT id, enabled, huge, amount, prefs, stamp, bytes, label, IF(SLEEP(0.03)=0,payload,payload) AS payload FROM items WHERE id <= 8`,
  );
  const definitions = {
    id: { type: 'integer', primaryKey: true },
    enabled: { type: 'boolean' },
    huge: { type: 'bigint' },
    amount: { type: 'numeric' },
    prefs: { type: 'json' },
    stamp: { type: 'timestamp' },
    bytes: { type: 'bytea' },
    label: { type: 'text' },
    payload: { type: 'text' },
  };
  const schema = schemaDefToMetadata(
    defineSchema(Object.fromEntries(['items', 'slow_items', 'missing_items'].map((n) => [n, definitions]))),
  );
  const wires = [],
    connections = new Set();
  function remember(raw) {
    driver.assertRaw(raw);
    if (connections.has(raw)) return;
    connections.add(raw);
    report.sessionIds.push(raw.threadId);
    for (const method of ['query', 'execute']) {
      const original = raw[method];
      raw[method] = function (...args) {
        const command = original.apply(this, args);
        driver.assertCommand(command, method);
        const sql = typeof args[0] === 'string' ? args[0] : args[0].sql;
        const rec = {
          sql,
          method,
          commandClass: command.constructor.name,
          driverIdentityVerified: true,
          callback: typeof command.onResult === 'function',
          rows: 0,
          fields: 0,
          retainedRows: 0,
          ended: false,
          errors: [],
        };
        report.commands.push(rec);
        command.on('fields', () => rec.fields++);
        command.on('result', (row) => {
          if (row && 'id' in row) {
            rec.rows++;
            report.driverLeadMax = Math.max(report.driverLeadMax, rec.rows - report.actualRows);
          }
        });
        command.on('error', (e) => rec.errors.push(e.code ?? e.message));
        command.on('end', () => {
          rec.ended = true;
          rec.retainedRows = (command._rows ?? []).reduce((n, r) => n + (Array.isArray(r) ? r.length : 0), 0);
        });
        return command;
      };
    }
    for (const [method, key] of [
      ['pause', 'pauseCalls'],
      ['resume', 'resumeCalls'],
      ['destroy', 'destroyCalls'],
    ]) {
      const original = raw[method];
      raw[method] = function (...args) {
        report[key]++;
        return original.apply(this, args);
      };
    }
    wires.push({ raw, before: raw.stream.bytesRead });
  }
  const opts = {
    logger: {},
    warnOnUnlimited: false,
    diagnostics: { advice: false, cacheCheck: 'off' },
    connectionLimit: 1,
  };
  if (c.ownership === 'factory') {
    db = await turbineMysql({ ...config, database }, schema, opts);
    // MysqlPool's private driver is deliberately observed for this pinned evidence workload.
    native = db.pool.pool;
    assert.ok(native?.pool, 'factory native pool instrumentation seam');
    native.pool.on('connection', remember);
    for (const raw of native.pool._allConnections.toArray()) remember(raw);
  } else {
    native = mysql.createPool({ ...config, database });
    native.pool.on('connection', remember);
    if (c.ownership === 'caller-connection') {
      caller = await native.getConnection();
      remember(caller.connection);
      const facade = {
        query: caller.query.bind(caller),
        execute: caller.execute.bind(caller),
        getConnection: async () => ({
          query: caller.query.bind(caller),
          execute: caller.execute.bind(caller),
          connection: caller.connection,
          release() {},
        }),
        end: async () => {},
      };
      db = await turbineMysql(facade, schema, opts);
    } else db = await turbineMysql(native, schema, opts);
  }
  report.effectiveSqlMode = (await (caller ?? native).query('SELECT @@sql_mode AS m'))[0][0].m;
  report.route = {
    publicMethod:
      c.arm === 'turbine-rows'
        ? 'findManyStream'
        : c.arm === 'turbine-batches'
          ? 'findManyStreamBatches'
          : null,
    driver: 'mysql2',
    ownership: c.ownership,
    context: c.kind.startsWith('tx-') ? 'ambient-transaction' : 'standalone',
  };
  const abort = c.kind.endsWith('abort'),
    driverError = c.kind === 'driver-error',
    tx = c.kind.startsWith('tx-');
  const table = abort ? 'slow_items' : driverError ? 'missing_items' : 'items';
  const sql = `SELECT ${COLUMNS} FROM ${table} ORDER BY id ASC`;
  report.independentSql = sql;
  report.queryPlan = (await observer.query(`EXPLAIN FORMAT=JSON ${SQL}`))[0][0].EXPLAIN;
  report.statementBaseline = (
    await observer.query("SHOW GLOBAL STATUS LIKE 'Prepared_stmt_count'")
  )[0][0].Value;
  report.memory = { before: process.memoryUsage(), peakRss: process.memoryUsage().rss };
  sampler = setInterval(() => {
    report.memory.peakRss = Math.max(report.memory.peakRss, process.memoryUsage().rss);
  }, 2);
  report.serverCountersBefore = await serverCounters(observer);
  report.readable = { maxLength: 0, highWaterMarks: [], observedPushes: 0 };
  originalPush = Readable.prototype.push;
  Readable.prototype.push = function (chunk, ...args) {
    const value = originalPush.call(this, chunk, ...args);
    if (this.readableObjectMode && chunk && typeof chunk === 'object' && 'id' in chunk) {
      report.readable.observedPushes++;
      report.readable.maxLength = Math.max(report.readable.maxLength, this.readableLength);
      if (!report.readable.highWaterMarks.includes(this.readableHighWaterMark))
        report.readable.highWaterMarks.push(this.readableHighWaterMark);
    }
    return value;
  };
  const s = sink();
  report.delayMs = c.cadence === 'slow' ? 2 : 0;
  report.requestedBatchSize = c.batchSize;
  let rawCheckout;
  async function* rawStream(conn, controller) {
    const command = conn.connection.query(sql);
    let settled = false;
    const done = new Promise((r) => {
      command.once('end', () => {
        settled = true;
        r();
      });
      command.once('error', () => {
        settled = true;
        r();
      });
    });
    const readable = command.stream({ highWaterMark: 1 });
    const cancel = () => {
      conn.connection.destroy();
      readable.destroy(controller.signal.reason);
    };
    controller.signal.addEventListener('abort', cancel, { once: true });
    try {
      let batch = [];
      for await (const row of readable.iterator({ destroyOnReturn: false })) {
        batch.push(row);
        if (batch.length === c.batchSize) {
          yield batch;
          batch = [];
        }
      }
      if (batch.length) yield batch;
    } finally {
      controller.signal.removeEventListener('abort', cancel);
      readable.destroy();
      // mysql2 native stream return may leave paused wire rows. Explicitly drain on early return.
      if (!controller.signal.aborted && !settled) {
        conn.connection.resume();
        await done;
      }
    }
  }
  async function waitRunning() {
    for (let i = 0; i < 200; i++) {
      const [rows] = await observer.query('SHOW PROCESSLIST');
      if (rows.some((r) => report.sessionIds.includes(r.Id) && r.Info?.includes('slow_items'))) return true;
      await delay(2);
    }
    throw new Error('actual server mid-flight query not observed');
  }
  const marker = new Error('intentional outer rollback'),
    reason = new Error('intentional mid-flight abort');
  async function consume(client, rawConn) {
    const controller = new AbortController();
    active = controller;

    const args = {
      select: Object.fromEntries(COLUMNS.split(', ').map((k) => [k, true])),
      orderBy: { id: 'asc' },
      batchSize: c.batchSize,
      signal: controller.signal,
      idleTimeoutMs: 0,
    };
    let stream;
    if (c.arm === 'materialized-reference' || fault === 'materialize') {
      const rows = (await rawConn.query(sql))[0];
      stream = (async function* () {
        for (let i = 0, n = c.arm === 'turbine-rows' ? 1 : c.batchSize; i < rows.length; i += n)
          yield rows.slice(i, i + n);
      })();
    } else if (c.arm === 'raw-stream') stream = rawStream(rawConn, controller);
    else
      stream = client
        .table(table)
        [c.arm === 'turbine-rows' ? 'findManyStream' : 'findManyStreamBatches'](args);
    try {
      if (abort) {
        const pending = stream.next().then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        const observedRunning = await waitRunning();
        const began = performance.now();
        if (fault === 'signal') {
          process.kill(process.pid, 'SIGTERM');
          await delay(5);
        }
        if (fault !== 'cancel' && fault !== 'signal') controller.abort(reason);
        const answer = await pending;
        report.cancellation = {
          requested: controller.signal.aborted,
          observedRunning,
          reasonMatched: answer.error === reason,
          serverKillAcknowledged: false,
          clientSettleMs: performance.now() - began,
        };
        if (answer.error) assert.equal(answer.error, reason); // Omission is caught by report validator.
      } else {
        for (;;) {
          if (interrupted) throw new Error(interrupted);
          const next = await stream.next();
          if (next.done) break;
          const rows = Array.isArray(next.value) ? next.value : [next.value];
          const before = report.actualPayloadBytes;
          for (const row of rows) {
            const checked = checkRow(
              row,
              ++report.actualRows,
              c.payloadSize,
              c.arm === 'raw-stream' || c.arm === 'materialized-reference' || fault === 'materialize',
            );
            s.add(checked);
            report.actualPayloadBytes += Buffer.byteLength(canonical(checked));
          }
          report.batches.push({ rows: rows.length, payloadBytes: report.actualPayloadBytes - before });
          if (report.delayMs && (report.actualRows % c.batchSize === 0 || report.actualRows === c.count)) {
            await delay(report.delayMs);
            report.delays++;
          }
          if (['early', 'tx-success', 'tx-rollback'].includes(c.kind)) break;
        }
      }
    } catch (e) {
      if (!driverError) throw e;
      report.expectedError = `${e.code ?? ''} ${e.message}`;
      assert.match(report.expectedError, /ER_NO_SUCH_TABLE|doesn't exist/);
    } finally {
      const began = performance.now();
      await stream.return();
      report.returnMs = performance.now() - began;
      active = null;
    }
    if (driverError) assert.ok(report.expectedError, 'driver error must be observed');
    if (abort) {
      report.cancellation.residual = [];
      for (let i = 0; i < 1000; i++) {
        const [rows] = await observer.query('SHOW PROCESSLIST');
        const remaining = rows.filter(
          (r) => report.sessionIds.includes(r.Id) && r.Info?.includes('slow_items'),
        ).length;
        if (i < 4 || !remaining) report.cancellation.residual.push({ ms: performance.now(), remaining });
        if (!remaining) {
          report.cancellation.remaining = 0;
          report.cancellation.residualPolls = i + 1;
          break;
        }
        await delay(2);
      }
      assert.equal(
        report.cancellation.remaining,
        0,
        'bounded residual server work settles; socket abort is not KILL',
      );
    }
  }
  async function insideTransaction(conn) {
    const own = (await conn.query('SELECT CONNECTION_ID() AS id, n FROM effects WHERE id=1'))[0][0];
    const external = (await observer.query('SELECT n FROM effects WHERE id=1'))[0][0].n;
    assert.equal(own.n, 7);
    assert.equal(external, 0);
    report.transactionContext = { connectionId: own.id, ownEffect: own.n, observerBeforeCommit: external };
  }
  const began = performance.now();
  try {
    if (c.arm === 'raw-stream' || c.arm === 'materialized-reference' || fault === 'materialize') {
      rawCheckout = caller ?? (await native.getConnection());
      if (tx) {
        await rawCheckout.beginTransaction();
        await rawCheckout.execute('UPDATE effects SET n=? WHERE id=?', [7, 1]);
        await insideTransaction(rawCheckout);
      }
      try {
        await consume(db, rawCheckout);
        if (tx && ((c.kind === 'tx-rollback' && fault !== 'effect') || abort)) throw marker;
        if (tx) await rawCheckout.commit();
      } catch (e) {
        if (tx && !abort) await rawCheckout.rollback();
        if (e !== marker) throw e;
      }
    } else if (tx) {
      try {
        await db.$transaction(async (t) => {
          await t.rawUnsafe('UPDATE effects SET n=$1 WHERE id=$2', 7, 1);
          await insideTransaction(caller);
          await consume(t, caller);
          if (!abort) {
            const [rows] = await caller.query('SELECT CONNECTION_ID() AS id, n FROM effects WHERE id=1');
            report.sameCallerConnection = rows[0].id === caller.connection.threadId;
            assert.equal(rows[0].n, 7);
          }
          if (c.kind === 'tx-rollback' && fault !== 'effect') throw marker;
        });
      } catch (e) {
        if (e !== marker && !abort) throw e;
        if (abort) report.transactionAbortError = e.message;
      }
    } else await consume(db, caller ?? native);
  } finally {
    report.elapsedMs = performance.now() - began;
    if (rawCheckout && rawCheckout !== caller) rawCheckout.release();
  }
  if (tx && c.arm === 'raw-stream' && !abort)
    report.sameCallerConnection =
      (await caller.query('SELECT CONNECTION_ID() AS id'))[0][0].id === caller.connection.threadId;
  report.result = s.finish();
  const selectedCommand = report.commands.find((q) =>
    /\bFROM\s+`?(items|slow_items|missing_items)`?\b/i.test(q.sql),
  );
  report.termination = {
    action: abort
      ? 'socket-abort'
      : driverError
        ? 'driver-error'
        : ['early', 'tx-success', 'tx-rollback'].includes(c.kind)
          ? 'early-return'
          : 'complete',
    wireRows: selectedCommand.rows,
    commandEnded: selectedCommand.ended,
    destroyed: report.destroyCalls > 0,
    drained: !abort && !driverError && selectedCommand.rows === c.count && selectedCommand.ended,
  };
  report.effect = (await observer.query('SELECT n FROM effects WHERE id=1'))[0][0].n;
  report.wireBytes = wires.reduce((n, w) => n + w.raw.stream.bytesRead - w.before, 0);
  report.memory.after = process.memoryUsage();
  report.memory.peakRss = Math.max(report.memory.peakRss, report.memory.after.rss);
  report.memory.maxRSSKiB = process.resourceUsage().maxRSS;
  report.serverCountersAfter = await serverCounters(observer);
  report.serverCounterDelta = Object.fromEntries(
    Object.entries(report.serverCountersAfter).map(([k, v]) => [k, v - report.serverCountersBefore[k]]),
  );
  report.serverProcessRssKiB = Number(
    /^VmRSS:\s+(\d+)/m.exec(readFileSync(`/proc/${identity.pid}/status`, 'utf8'))?.[1],
  );
  report.statementAfter = (await observer.query("SHOW GLOBAL STATUS LIKE 'Prepared_stmt_count'"))[0][0].Value;
  if (interrupted) throw new Error(interrupted);
} catch (e) {
  report.failure = String(e.stack ?? e);
} finally {
  clearInterval(sampler);
  if (originalPush) Readable.prototype.push = originalPush;
  await finalize(
    report,
    [
      async () => {
        await db?.disconnect();
        if (native) {
          if (report.config.ownership === 'factory') {
            assert.equal(native.pool._closed, true);
            await assert.rejects(() => native.getConnection(), /closed/);
          } else if (caller && !report.config.kind.endsWith('abort')) {
            assert.equal((await caller.query('SELECT 73 AS n'))[0][0].n, 73);
            caller.release();
          } else if (caller) {
            await assert.rejects(() => caller.query('SELECT 73 AS n'), /closed|state/i);
            assert.equal((await native.query('SELECT 73 AS n'))[0][0].n, 73);
          } else if (!caller) assert.equal((await native.query('SELECT 73 AS n'))[0][0].n, 73);
          report.ownershipVerified = true;
        }
      },
      async () => {
        if (report.config?.ownership !== 'factory') {
          caller?.release();
          await native?.end();
        }
      },
      async () => {
        if (admin && report.sessionIds.length) {
          for (let i = 0; i < 1000; i++) {
            const [rows] = await admin.query('SHOW PROCESSLIST');
            if (!rows.some((r) => report.sessionIds.includes(r.Id))) {
              report.applicationSessionsClosed = true;
              break;
            }
            await delay(2);
          }
          assert.equal(report.applicationSessionsClosed, true);
        }
      },
      async () => {
        await observer?.end();
      },
      async () => {
        if (database && admin) {
          await admin.query(`DROP DATABASE \`${database}\``);
          const [rows] = await admin.execute(
            'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?',
            [database],
          );
          assert.equal(rows.length, 0);
          report.databaseRemoved = true;
        }
      },
      async () => {
        await admin?.end();
      },
      async () => {
        if (fault === 'cleanup') report.applicationSessionsClosed = false;
        if (fault === 'finalize') throw new Error('forced finalization fault after actual cleanup');
      },
    ],
    output,
  );
  if (interrupted) {
    report.status = 'failed';
    report.cleanupErrors.push(`interrupted after cleanup: ${interrupted}`);
  }
  if (report.status === 'passed')
    try {
      validateSample(report);
    } catch (e) {
      report.failure = String(e.stack ?? e);
      report.status = 'failed';
    }
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  process.off('SIGTERM', term);
  process.off('SIGINT', int);
  if (interrupted) {
    process.kill(process.pid, interrupted);
  } else if (report.status !== 'passed') {
    console.error(report.failure ?? report.cleanupErrors.join('\n'));
    process.exitCode = 1;
  }
}
