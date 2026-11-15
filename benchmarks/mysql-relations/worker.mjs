import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { loadavg } from 'node:os';
import { fixture, fixtureNames, windows, oracle, queryArgs, ddl } from './fixture.mjs';
import { exact, hash, fileHash, assertValues, assertOrder, assertRoute, assertProtocol } from './proof.mjs';

assert.ok(process.send && process.env.MYSQL_RELATIONS_SOCKET, 'worker requires owned-service supervisor');
const root = process.cwd();
const require = createRequire(resolve(root, 'package.json'));
const driverPath = require.resolve('mysql2/promise');
const driverRoot = dirname(require.resolve('mysql2/package.json'));
const driver = require('mysql2/promise');
const driverManifest = require('mysql2/package.json');
const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json')));
assert.equal(driverManifest.version, lock.packages['node_modules/mysql2'].version, 'actual root-lock driver version');
const { turbineMysql, introspectMysqlWith } = await import(pathToFileURL(resolve(root, 'src/mysql.ts')));
const flags = { namedPlaceholders: true, supportBigNumbers: true, bigNumberStrings: false, dateStrings: false, timezone: 'Z',
  connectionLimit: 1, user: 'root', socketPath: process.env.MYSQL_RELATIONS_SOCKET, database: 'relations', connectTimeout: 2000 };
const pool = driver.createPool(flags);
let activeRoute, activeProtocol;
const backends = new Set();
pool.on('connection', (conn) => {
  backends.add(conn.threadId);
  const writePacket = conn.writePacket;
  conn.writePacket = function (packet) {
    if (activeProtocol && conn.sequenceId === 0) {
      const record = { opcode: packet.buffer[4], commandClass: conn._command.constructor.name,
        packetBytes: packet.length(), threadId: conn.threadId, completed: false };
      activeProtocol.push(record);
      conn._command.once('end', () => { record.completed = true; });
    }
    return writePacket.call(this, packet);
  };
  for (const method of ['query', 'execute']) {
    const original = conn[method];
    conn[method] = function (...args) {
      const command = original.apply(this, args);
      if (!activeRoute) return command;
      const record = { method, sql: typeof args[0] === 'string' ? args[0] : args[0].sql,
        threadId: conn.threadId, commandClass: command.constructor.name, callback: typeof command.onResult === 'function', ended: false };
      activeRoute.push(record);
      command.once('end', () => {
        const sets = command._rows.filter(Array.isArray);
        record.materializedRows = sets.reduce((sum, rows) => sum + rows.length, 0);
        record.nativeRows = record.materializedRows;
        record.decodedBytes = Buffer.byteLength(exact(sets));
        record.nativeResultHash = hash(exact(sets));
        record.ended = true;
      });
      return command;
    };
  }
});

async function execute(sql, params = {}) { return (await pool.execute(sql, params))[0]; }
async function storedFixture(name) {
  return { name, parents: await execute('SELECT id, weight, label FROM parents ORDER BY id'),
    children: await execute('SELECT id, parent_id AS parentId, weight, amount, big, doc, binary_value AS binaryValue, day, stamp, payload FROM children ORDER BY id'),
    leaves: await execute('SELECT id, child_id AS childId, weight, label FROM leaves ORDER BY id'),
    profiles: await execute('SELECT id, parent_id AS parentId, note FROM profiles ORDER BY id') };
}
async function seed(input) {
  for (const t of ['leaves', 'profiles', 'children', 'parents']) await pool.query(`DROP TABLE IF EXISTS ${t}`);
  for (const sql of ddl) await pool.query(sql);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const p of input.parents) await conn.execute('INSERT INTO parents VALUES (?, ?, ?)', [p.id, p.weight, p.label]);
    for (const c of input.children) await conn.execute('INSERT INTO children VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [c.id, c.parentId, c.weight, c.amount, c.big, JSON.stringify(c.doc), c.binaryValue, c.day, c.stamp, c.payload]);
    for (const l of input.leaves) await conn.execute('INSERT INTO leaves VALUES (?, ?, ?, ?)', [l.id, l.childId, l.weight, l.label]);
    for (const p of input.profiles) await conn.execute('INSERT INTO profiles VALUES (?, ?, ?)', [p.id, p.parentId, p.note]);
    await conn.commit();
  } catch (error) { await conn.rollback(); throw error; }
  finally { conn.release(); }
}

async function raw(window, legacy) {
  const c = await pool.getConnection();
  try {
    await c.query('START TRANSACTION');
    const parents = (await c.execute('SELECT id, weight, label FROM parents WHERE id >= ? ORDER BY weight ASC, id DESC LIMIT ? OFFSET ?', [1, window.limit, window.offset]))[0];
    assert.ok(parents.length, 'raw parent prerequisite');
    const pkeys = parents.map((p) => p.id), placeholders = pkeys.map(() => '?').join(',');
    const children = (await c.execute(`SELECT id, parent_id AS parentId, weight, amount, big, doc, binary_value AS binaryValue, day, stamp, payload FROM children WHERE parent_id IN (${placeholders}) ORDER BY weight ASC, id DESC`, pkeys))[0];
    const selected = parents.flatMap((p) => children.filter((r) => r.parentId === p.id).slice(window.childOffset, window.childOffset + window.childLimit));
    const keys = selected.map((r) => r.id);
    assert.ok(keys.length, 'raw children prerequisite');
    const leaves = (await c.execute(`SELECT id, child_id AS childId, weight, label FROM leaves WHERE child_id IN (${keys.map(() => '?').join(',')}) ORDER BY id DESC`, keys))[0];
    const profiles = (await c.execute(`SELECT id, parent_id AS parentId, note FROM profiles WHERE parent_id IN (${placeholders})`, pkeys))[0];
    const result = parents.map((p) => {
      const matches = profiles.filter((r) => r.parentId === p.id);
      return { ...p, children: selected.filter((r) => r.parentId === p.id).map((r) => ({ ...r, leaves: leaves.filter((l) => l.childId === r.id).slice(1, 2) })),
        profiles: legacy ? matches : matches[0] ?? null };
    });
    await c.commit();
    return result;
  } catch (error) { await c.rollback(); throw error; }
  finally { c.release(); }
}

function relationNames(schema) {
  const find = (from, to) => {
    const matches = Object.entries(schema.tables[from].relations).filter(([, r]) => r.to === to);
    assert.equal(matches.length, 1, `exact relation ${from}->${to}`);
    return matches[0][0];
  };
  return { children: find('parents', 'children'), leaves: find('children', 'leaves'), profiles: find('parents', 'profiles') };
}
function normalizeResult(result, names) {
  return result.map((p) => {
    const { [names.children]: children, [names.profiles]: profiles, ...base } = p;
    return { ...base, children: children.map((c) => {
      const { [names.leaves]: leaves, ...rest } = c;
      return { ...rest, leaves };
    }), profiles };
  });
}

async function measured(run) {
  const conn = await pool.getConnection();
  const stream = conn.connection.stream;
  conn.release();
  const wireBefore = { read: stream.bytesRead, written: stream.bytesWritten };
  const memoryBefore = process.memoryUsage(), usageBefore = process.resourceUsage(), cpuBefore = process.cpuUsage();
  const route = [], protocol = []; activeRoute = route; activeProtocol = protocol;
  const start = performance.now();
  let value;
  try { value = await run(); } finally { activeRoute = undefined; activeProtocol = undefined; }
  const elapsedMs = performance.now() - start;
  const cpu = process.cpuUsage(cpuBefore), memoryAfter = process.memoryUsage(), usageAfter = process.resourceUsage();
  return { value, route, protocol, costs: { elapsedMs, cpuMicroseconds: cpu, memoryBefore, memoryAfter,
    maxRssKiBProcessLifetime: usageAfter.maxRSS,
    voluntaryContextSwitches: usageAfter.voluntaryContextSwitches - usageBefore.voluntaryContextSwitches,
    involuntaryContextSwitches: usageAfter.involuntaryContextSwitches - usageBefore.involuntaryContextSwitches,
    socketBytesRead: stream.bytesRead - wireBefore.read, socketBytesWritten: stream.bytesWritten - wireBefore.written,
    logicalStatements: route.length, protocolRequestResponses: protocol.length, nativePrepareExchanges: protocol.filter((p) => p.opcode === 22).length } };
}

const proof = { cases: [], effects: [], refusals: [], clientCleanup: false, backends: [], driver: { version: driverManifest.version, path: driverPath,
  entrySha256: fileHash(driverPath), querySha256: fileHash(resolve(driverRoot, 'lib/commands/query.js')),
  connectionSha256: fileHash(resolve(driverRoot, 'lib/base/connection.js')),
  executeSha256: fileHash(resolve(driverRoot, 'lib/commands/execute.js')), lockIntegrity: lock.packages['node_modules/mysql2'].integrity },
  settings: flags, runtime: { version: process.version, executable: process.execPath, sha256: fileHash(process.execPath), versions: process.versions },
  noise: { loadBefore: loadavg(), policy: 'shared machine, sequential alternating arm order; no speed claims' } };
try {
  const server = (await execute('SELECT VERSION() AS version, @@sql_mode AS mode, CONNECTION_ID() AS backend'))[0];
  assert.equal(server.version, '8.4.0', 'exact native MySQL version');
  assert.equal(server.mode.includes('NO_BACKSLASH_ESCAPES'), process.env.MYSQL_RELATIONS_MODE === 'no-backslash', 'actual SQL mode differs');
  proof.server = server;
  for (const name of fixtureNames) {
    const input = fixture(name, Number(process.env.MYSQL_RELATIONS_SCALE));
    await seed(input);
    const effect = { fixture: name, expected: hash(exact(input)), before: hash(exact(await storedFixture(name))) };
    assert.equal(effect.before, effect.expected, 'stored fixture differs from source input');
    const exec = (sql, values) => execute(sql, Object.fromEntries(values.map((v, i) => [`p${i + 1}`, v])));
    for (const legacy of [false, true]) {
      const schema = await introspectMysqlWith(exec, 'relations', { legacyToManyUniques: legacy, logger: {} });
      const names = relationNames(schema);
      assert.equal(schema.tables.parents.relations[names.profiles].type, legacy ? 'hasMany' : 'hasOne', 'unique FK object/legacy array prerequisite');
      const db = await turbineMysql(pool, schema, { logger: {}, diagnostics: { mode: 'production' } });
      try {
        // Unsupported encoding must refuse before native execution. Never time it as a successful arm.
        const route = []; activeRoute = route;
        try {
          await assert.rejects(db.table('parents').findMany({ ...queryArgs(windows(input)[0], 'join', names), jsonEncoding: 'positional' }),
            (e) => e.code === 'TURBINE_E017', 'unsupported positional encoding must refuse');
        } finally { activeRoute = undefined; }
        assert.equal(route.length, 0, 'unsupported read reached native driver');
        proof.refusals.push({ fixture: name, legacy, feature: 'positional JSON', code: 'TURBINE_E017', nativeCommands: 0, timed: false });
        process.send({ stage: 'prerequisites-passed', fixture: name, legacy });
        for (const window of windows(input)) {
          const expected = oracle(input, window, legacy);
          for (let repetition = 0; repetition < Number(process.env.MYSQL_RELATIONS_REPETITIONS); repetition++) {
            const arms = repetition % 2 ? ['flatten', 'batched', 'join', 'raw'] : ['raw', 'join', 'batched', 'flatten'];
            for (const arm of arms) {
              const args = queryArgs(window, arm === 'raw' ? 'join' : arm, names);
              assertOrder(args, names);
              const sample = await measured(() => arm === 'raw' ? raw(window, legacy) : db.$transaction(async (tx) =>
                normalizeResult(await tx.table('parents').findMany(args), names)));
              const actual = sample.value;
              // Control insertion point: native prerequisites and measured transaction have completed.
              assertValues(actual, expected);
              assertRoute(sample.route, arm, legacy);
              assertProtocol(sample.protocol, sample.route.length);
              proof.cases.push({ fixture: name, window, legacy, arm, repetition, inputHash: hash(exact(input)),
                oracleHash: hash(exact(expected)), resultHash: hash(exact(actual)), outputParents: actual.length,
                outputChildren: actual.reduce((n, p) => n + p.children.length, 0), outputBytes: Buffer.byteLength(exact(actual)),
                route: sample.route, protocol: sample.protocol, costs: sample.costs,
                actualPlan: arm === 'flatten' ? (legacy ? 'JSON join fallback: unique FK explicitly legacy to-many' : 'profiles LEFT JOIN with children/leaves JSON') : arm,
                exactBoundaryExample: actual.flatMap((p) => p.children).slice(0, 3).map((c) => ({ id: c.id, amount: c.amount, big: c.big,
                  doc: c.doc, binaryHex: c.binaryValue.toString('hex'), day: c.day.toISOString(), stamp: c.stamp.toISOString() })) });
            }
          }
        }
      } finally { await db.disconnect(); }
    }
    effect.after = hash(exact(await storedFixture(name)));
    assert.equal(effect.after, effect.expected, 'read workload mutated stored fixture');
    proof.effects.push(effect);
  }
} finally {
  await pool.end();
  proof.clientCleanup = true;
  proof.backends = [...backends];
  proof.noise.loadAfter = loadavg();
}
assert.equal(proof.cases.length, 64 * Number(process.env.MYSQL_RELATIONS_REPETITIONS), 'native workload case matrix incomplete');
assert.equal(proof.refusals.length, 8, 'unsupported refusal matrix incomplete');
process.send({ stage: 'complete', proof });
