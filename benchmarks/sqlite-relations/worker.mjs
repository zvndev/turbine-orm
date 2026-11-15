import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { ARMS, CASES, fixture, checkSample, plain, digest, assertNativeRuntime } from './oracle.mjs';
import { setup, instrument, execute } from './workload.mjs';

const [modulePath, directory, roundsText, scaleText, delayText, fault] = process.argv.slice(2);
const result = { samples: [], failures: [], proof: {}, cleanup: { handles: [] } };
let db, client;
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
async function closeHandle() {
  if (!db) return;
  const handle = db; db = null;
  let closed = false, transactionClosed = false, failure;
  try {
    if (client) { await client.disconnect(); client = null; }
    if (handle.isTransaction) handle.exec('ROLLBACK');
    transactionClosed = !handle.isTransaction;
    if (fault !== 'lost-handle') handle.close();
    assert.throws(() => handle.prepare('SELECT 1'), /closed|not open/i, 'native handle closure proof');
    closed = true;
  } catch (e) { failure = e; }
  finally {
    // Recovery follows the assertion, so a leaked handle can never become a pass.
    if (!closed) { try { handle.close(); } catch {} }
    result.cleanup.handles.push({ closed, transactionClosed, recoveryClosed: !closed });
  }
  if (failure) throw failure;
}
try {
  assertNativeRuntime(process.version);
  const { DatabaseSync } = await import('node:sqlite');
  const api = await import(pathToFileURL(modulePath).href);
  const req = createRequire(modulePath);
  const pgEntry = req.resolve('pg'), pgPackage = req.resolve('pg/package.json');
  assert.ok(req.cache[pgEntry]?.loaded, 'actual pg module must be loaded');
  assert.equal(JSON.parse(readFileSync(pgPackage)).version, JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url))).packages['node_modules/pg'].version, 'actual driver matches root lock');
  result.proof.loadedPg = { entry: pgEntry, entrySha256: sha(pgEntry), version: JSON.parse(readFileSync(pgPackage)).version };
  for (const name of CASES) {
    const input = fixture(name, Number(scaleText));
    db = new DatabaseSync(`${directory}/${name}.sqlite`);
    setup(db, input);
    assert.equal(typeof db.isTransaction, 'boolean', 'native transaction observation prerequisite');
    const probe = db.prepare('SELECT sqlite_version() AS version, sqlite_source_id() AS sourceId');
    assert.equal(typeof probe.columns, 'function', 'native columns prerequisite');
    result.proof.sqlite = plain(probe.get());
    const iterator = probe.iterate(); assert.equal(typeof iterator.return, 'function'); iterator.return();
    const metadata = api.introspectSqliteDatabase(db);
    // Pin relation names locally; this does not change introspection behavior.
    const table = metadata.tables.parents;
    const rels = Object.values(table.relations);
    table.relations = { owner: rels.find(r => r.to === 'owners'), children: rels.find(r => r.to === 'children') };
    assert.ok(table.relations.owner && table.relations.children, 'real native relation metadata');
    client = api.turbineSqlite(db, metadata, { logger: {}, warnOnUnlimited: false, streamIdleTimeoutMs: 0, busyTimeoutMs: 250 });
    result.proof.settings = Object.fromEntries(['foreign_keys', 'journal_mode', 'synchronous', 'busy_timeout'].map(k =>
      [k, Object.values(db.prepare(`PRAGMA ${k}`).get())[0]]));
    const audit = instrument(db);
    result.proof.prerequisites = true;
    if (!result.proof.refusal) {
      audit.events = []; audit.enabled = true;
      await assert.rejects(client.table('parents').findMany({ with: { children: true }, relationLoadStrategy: 'join', jsonEncoding: 'positional' }), e => {
        assert.equal(e.code, 'TURBINE_E017');
        result.proof.refusal = { code: e.code, message: e.message, nativeReads: audit.events.filter(e => /^SELECT\b/i.test(e.sql)).length };
        return true;
      });
      audit.enabled = false;
    }
    if (name === CASES[0]) {
      process.send({ ready: true, pid: process.pid, prerequisites: result.proof.prerequisites });
      if (fault === 'hang') await new Promise(() => { setInterval(() => {}, 1000); });
      if (fault === 'self-signal') process.kill(process.pid, 'SIGTERM');
    }
    for (let round = 0; round < Number(roundsText); round++) for (const window of ['all', 'page']) {
      const order = round % 2 ? [...ARMS].reverse() : ARMS;
      for (const arm of order) {
        const sample = { name, round, order, ...await execute(db, client, audit, arm, window, Number(delayText), fault) };
        try { checkSample(sample, input); } catch (e) { result.rejectedSample = sample; throw e; }
        result.samples.push(sample);
      }
    }
    audit.enabled = false;
    assert.deepEqual(plain(db.prepare('SELECT id, rank, label, owner_id AS ownerId FROM parents ORDER BY id').all()), input.parents, 'independent parent effect oracle');
    assert.deepEqual(plain(db.prepare('SELECT id, parent_id AS parentId, rank, note, payload FROM children ORDER BY id').all()), input.children, 'independent child effect oracle');
    assert.deepEqual(plain(db.prepare('SELECT id, label FROM owners ORDER BY id').all()), input.owners, 'independent owner effect oracle');
    (result.proof.effects ??= []).push({ name, parents: input.parents.length, children: input.children.length, owners: input.owners.length, inputHash: digest(input), unchanged: true });
    await closeHandle();
  }
} catch (e) { result.failures.push({ name: e.name, message: e.message, stack: e.stack }); }
finally {
  try { await closeHandle(); } catch (e) { result.failures.push({ name: e.name, message: e.message, stack: e.stack }); }
  result.cleanup.handleClosed = result.cleanup.handles.length > 0 && result.cleanup.handles.every(h => h.closed);
  result.cleanup.transactionClosed = result.cleanup.handles.length > 0 && result.cleanup.handles.every(h => h.transactionClosed);
  process.send({ result }, () => process.disconnect());
  process.exitCode = result.failures.length ? 1 : 0;
}
