import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { adminUrl, drizzleArm, openEngine } from './engines.mjs';
import { distribution } from './metrics.mjs';
import { assertMysqlRoute } from './mysql-native.mjs';
import { engineRun, harnessFingerprint } from './run.mjs';
import { assertPgRoute } from './pg-native.mjs';
import { summarize } from './summarize.mjs';
import { SCENARIOS, validateCampaign, validateRun } from './validate.mjs';
import { pins, verifyPins } from './verify-pins.mjs';
import { BATCH_SIZE, checkRows, digest, ENGINES, EXPECTED, EXPECTED_DRAIN, FIXTURE, positiveInteger, requiredEngines, ROW_COUNT, scratchName, SEMANTICS } from './workload.mjs';

function schemaFixture() {
  const sample = { round: 0, wallMs: 1, userCpuUs: 2, systemCpuUs: 0, rssBeforeBytes: 100, rssAfterBytes: 100, observedPeakRssBytes: 100 };
  const distributions = Object.fromEntries(Object.entries(sample).filter(([key]) => key !== 'round').map(([key, value]) => [key, distribution([value])]));
  return {
    schemaVersion: 1, semantics: SEMANTICS, status: 'complete', runId: randomUUID(), performanceClaimsAllowed: false,
    rounds: 1, warmup: 1, fixtureRows: ROW_COUNT, batchSize: BATCH_SIZE,
    source: { gitHead: 'a'.repeat(40), contentSha256: 'b'.repeat(64) }, harnessSha256: 'c'.repeat(64),
    installed: Object.fromEntries(Object.entries(pins.selection).map(([name, pin]) => [name, pin.version])), runtime: { node: process.version, v8: process.versions.v8, openssl: process.versions.openssl, sourcePg: '8.22.0' },
    engines: ENGINES.map((engine) => engine !== 'sqlite' ? { engine, status: 'unavailable', reason: 'Explicit synthetic schema-validation fixture; no server evidence' } : {
      engine, status: 'complete', settings: { journalMode: 'wal', synchronous: 2, foreignKeys: 1 }, pool: { max: 1, sharedPhysicalPoolAcrossArms: true, concurrency: 1 }, serverVersion: 'schema-fixture-only', cleanup: 'complete',
      correctness: { exactRows: true, everyArmRollback: true, everyMeasuredEffect: true },
      controls: { wrongCellAndOrderRejected: true, wrongEffectRejected: true, nativeRoutes: {
        raw: { iteratorOpens: 1, steppedRows: ROW_COUNT }, 'turbine-source': { iteratorOpens: 1, steppedRows: ROW_COUNT },
      }, before: { samplesMs: [1], distribution: distribution([1]) }, after: { samplesMs: [1], distribution: distribution([1]) },
        probeMedianRatio: 1, noiseFlag: false },
      scenarios: SCENARIOS.map((id) => ({ id, consumption: id === 'native' ? 'native-bounded-drain' : 'materialized',
        arms: ['raw', 'turbine-source', 'drizzle-stable', 'drizzle-candidate'].map((name) => id === 'native' && name.startsWith('drizzle-') ? {
          name, status: 'unavailable', reason: 'Native consumption unavailable for this adapter',
        } : ({
          name, status: 'complete', adapter: 'synthetic schema fixture',
          ...(id === 'native' ? { transport: 'Synthetic bounded native transaction/consumption fixture' } : {}),
          samples: [structuredClone(sample)], distributions: structuredClone(distributions),
        })),
      })),
    }),
  };
}

function mysqlFixture() {
  const run = schemaFixture();
  const engine = structuredClone(run.engines[0]);
  engine.engine = 'mysql';
  engine.settings = { isolation: 'REPEATABLE-READ', flush_log: 1, charset: 'utf8mb4', collation: 'utf8mb4_bin', sql_mode: '', autocommit: 1, log_bin: 1 };
  engine.serverVersion = '8.4.0-synthetic-schema-fixture';
  engine.controls.nativeRoutes = Object.fromEntries(['raw', 'turbine-source'].map((name) => [name, {
    driver: 'mysql2', physicalConnections: 1, statements: ['START TRANSACTION', 'SELECT id, label, value, note FROM evidence_items ORDER BY id ASC', 'COMMIT'], pauseCalls: 1, resumeCalls: 1,
    commands: [{ sql: 'SELECT id, label, value, note FROM evidence_items ORDER BY id ASC', method: 'query', commandClass: 'Query',
      callback: false, fieldsEvents: 1, rowEvents: ROW_COUNT, retainedRowsAtEnd: 0, ended: true }],
  }]));
  run.engines[2] = engine;
  return run;
}

describe('comparative evidence refusal boundaries', () => {
  it('verifies exact manifest, lock integrity and installed package versions', () => {
    assert.equal(Object.keys(verifyPins()).length, 6);
  });
  it('pins setup images by the exact registry manifest digests', () => {
    const services = JSON.parse(readFileSync(new URL('./services.json', import.meta.url)));
    const compose = readFileSync(new URL('./compose.yaml', import.meta.url), 'utf8');
    assert.equal(Object.keys(services.images).length, 2);
    for (const image of Object.values(services.images)) {
      assert.match(image.image, /@sha256:[a-f0-9]{64}$/);
      assert.ok(compose.includes(`image: ${image.image}`));
    }
  });
  it('builds parameterized MySQL and SQL Server adapter queries without claiming server execution', async () => {
    const native = { query() { throw new Error('Build-only probe must not execute'); }, request() { throw new Error('Build-only probe must not execute'); } };
    for (const [engine, aliases] of [['mysql', ['drizzle-stable', 'drizzle-candidate']], ['mssql', ['drizzle-candidate']]]) {
      for (const alias of aliases) {
        const arm = await drizzleArm({ engine, native }, alias);
        const page = arm.page().toSQL();
        assert.match(page.sql, /evidence_items/);
        assert.deepEqual(page.params, [16, 80]);
        assert.deepEqual(arm.point(7).toSQL().params, [8]);
      }
    }
  });
  it('passes the shared MySQL client to both pinned Drizzle versions rather than a config-shaped impostor', async () => {
    for (const alias of ['drizzle-stable', 'drizzle-candidate']) {
      let calls = 0;
      const native = { async query(_options, params) {
        calls++;
        assert.deepEqual(params, [16, 80]);
        return [EXPECTED.page.map((row) => Object.values(row)), []];
      } };
      const arm = await drizzleArm({ engine: 'mysql', native }, alias);
      checkRows(alias, await arm.page(), EXPECTED.page);
      assert.equal(calls, 1, 'Actual supplied driver client must execute');
    }
  });
  it('rejects malformed rounds, requirements and non-disposable database names', () => {
    for (const value of ['0', '-1', '2oops', 'NaN', 'Infinity', '1.5']) assert.throws(() => positiveInteger(value, 'rounds'));
    assert.equal(positiveInteger('2', 'rounds'), 2);
    for (const value of ['postgres', 'sqlite,sqlite', 'mysql,']) assert.throws(() => requiredEngines(value));
    assert.deepEqual(requiredEngines('sqlite,postgresql'), ['sqlite', 'postgresql']);
    for (const value of ['postgres', 'turbine_evidence_old', 'turbine_evidence_1234567890123456;DROP DATABASE app']) assert.throws(() => scratchName(value));
    assert.equal(scratchName('turbine_evidence_0123456789abcdef'), 'turbine_evidence_0123456789abcdef');
  });
  it('requires explicit disposable loopback endpoints and rejects mixed engine URLs', () => {
    assert.match(adminUrl('mysql', {}).unavailable, /unset/);
    assert.throws(() => adminUrl('mysql', { EVIDENCE_MYSQL_ADMIN_URL: 'mysql://user@localhost/mysql' }), /DISPOSABLE/);
    for (const url of ['postgresql://user@localhost/postgres', 'mysql://user@remote/mysql', 'mysql://user@127.0.0.1/mysql?socket=other']) {
      assert.throws(() => adminUrl('mysql', { EVIDENCE_DISPOSABLE: '1', EVIDENCE_MYSQL_ADMIN_URL: url }));
    }
    assert.equal(adminUrl('mysql', { EVIDENCE_DISPOSABLE: '1', EVIDENCE_MYSQL_ADMIN_URL: 'mysql://user@127.0.0.1/mysql' }).url.hostname, '127.0.0.1');
  });
  it('rejects same counts with wrong values, nulls, keys, ordering and unsafe ids', () => {
    checkRows('positive', [...EXPECTED.page], EXPECTED.page);
    for (const replacement of [{ ...EXPECTED.page[0], label: 'wrong' }, { ...EXPECTED.page[0], note: null }, { ...EXPECTED.page[0], extra: 1 }, { ...EXPECTED.page[0], id: Number.MAX_SAFE_INTEGER + 1 }]) {
      assert.throws(() => checkRows('negative', [replacement, ...EXPECTED.page.slice(1)], EXPECTED.page));
    }
    assert.throws(() => checkRows('negative', [...EXPECTED.page].reverse(), EXPECTED.page));
  });
  it('native drain checks every cell and sequence, not just count', () => {
    for (const mutate of [(_row, index) => index === 100 ? { ...FIXTURE[index], label: 'wrong' } : FIXTURE[index], (_row, index) => FIXTURE[FIXTURE.length - 1 - index]]) {
      const sink = digest();
      FIXTURE.forEach((row, index) => sink.row(mutate(row, index)));
      assert.equal(sink.finish().count, EXPECTED_DRAIN.count);
      const another = digest();
      FIXTURE.forEach((row, index) => another.row(mutate(row, index)));
      assert.notEqual(another.finish().sha256, EXPECTED_DRAIN.sha256);
    }
    assert.notDeepEqual({ count: ROW_COUNT }, EXPECTED_DRAIN);
  });
  it('requires real callbackless MySQL commands, bounded driver retention, backpressure and transaction completion', () => {
    validateRun(mysqlFixture(), ['mysql']);
    const route = mysqlFixture().engines[2].controls.nativeRoutes.raw;
    const mutations = [
      (r) => { r.driver = 'invented'; }, (r) => { r.physicalConnections = 2; },
      (r) => { r.pauseCalls = 0; }, (r) => { r.resumeCalls = 0; },
      (r) => { r.statements = ['COMMIT']; }, (r) => { r.statements = ['START TRANSACTION']; },
      (r) => { r.commands = []; }, (r) => { r.commands.push(structuredClone(r.commands[0])); },
      (r) => { r.statements.reverse(); },
      (r) => { r.commands[0].method = 'materialized'; },
      (r) => { r.commands[0].callback = true; }, (r) => { r.commands[0].retainedRowsAtEnd = ROW_COUNT; },
      (r) => { r.commands[0].rowEvents--; }, (r) => { r.commands[0].ended = false; },
      (r) => { r.commands[0].commandClass = 'Array'; }, (r) => { r.commands[0].fieldsEvents = 2; },
      (r) => { r.commands[0].sql += ' LIMIT 2048'; },
    ];
    for (const mutate of mutations) {
      const negative = structuredClone(route); mutate(negative);
      assert.throws(() => assertMysqlRoute(negative));
      const run = mysqlFixture(); run.engines[2].controls.nativeRoutes.raw = negative;
      assert.throws(() => validateRun(run));
    }
    for (const mutate of [
      (run) => { run.engines[2].scenarios[3].arms[0] = { name: 'raw', status: 'unavailable', reason: 'Silently omit the required native MySQL arm' }; },
      (run) => { run.engines[2].pool.sharedPhysicalPoolAcrossArms = false; },
      (run) => { run.engines[2].pool.concurrency = 2; },
      (run) => { run.semantics = 'cross-engine-exact-effects-v1'; },
    ]) { const run = mysqlFixture(); mutate(run); assert.throws(() => validateRun(run)); }
  });
  it('rejects materialized, oversized and decorative PostgreSQL cursor routes', () => {
    const commands = [
      { sql: 'BEGIN', rows: 0, tags: ['BEGIN'] },
      { sql: 'DECLARE evidence_cursor NO SCROLL CURSOR FOR SELECT id, label, value, note FROM evidence_items ORDER BY id ASC', rows: 0, tags: ['DECLARE CURSOR'] },
      ...Array.from({ length: ROW_COUNT / BATCH_SIZE }, () => ({ sql: `FETCH ${BATCH_SIZE} FROM evidence_cursor`, rows: BATCH_SIZE, tags: [`FETCH ${BATCH_SIZE}`] })),
      { sql: `FETCH ${BATCH_SIZE} FROM evidence_cursor`, rows: 0, tags: ['FETCH 0'] },
      { sql: 'CLOSE evidence_cursor', rows: 0, tags: ['CLOSE CURSOR'] },
      { sql: 'COMMIT', rows: 0, tags: ['COMMIT'] },
    ];
    const route = { driver: 'pg', commands, statements: commands.map(c => c.sql) };
    assertPgRoute(route);
    for (const mutate of [
      r => { r.commands[2].sql = 'FETCH ALL FROM evidence_cursor'; },
      r => { r.commands[2].sql = 'FETCH 2048 FROM evidence_cursor'; },
      r => { r.commands[2].rows = ROW_COUNT; },
      r => { r.commands.splice(3, 0, { sql: 'SELECT * FROM evidence_items', rows: ROW_COUNT, tags: ['SELECT 2048'] }); },
      r => { r.commands.reverse(); }, r => { r.commands[2].tags = []; },
      r => { r.commands[2].rows--; }, r => { r.commands.pop(); },
    ]) {
      const bad = structuredClone(route); mutate(bad); bad.statements = bad.commands.map(c => c.sql);
      assert.throws(() => assertPgRoute(bad));
      const run = schemaFixture(); const pg = structuredClone(run.engines[0]); pg.engine = 'postgresql';
      pg.settings = { isolation:'read committed', synchronous_commit:'on', fsync:'on', timezone:'UTC' };
      pg.controls.nativeRoutes = { raw:bad, 'turbine-source':route }; run.engines[1] = pg;
      assert.throws(() => validateRun(run));
    }
  });
  it('fingerprints the executable oracle and root build/dependency configuration', () => {
    const dir = mkdtempSync(join(tmpdir(), 'evidence-fingerprint-'));
    try {
      mkdirSync(join(dir,'benchmarks/evidence'),{recursive:true});
      writeFileSync(join(dir,'benchmarks/evidence/run.mjs'),'// fixture executable');
      writeFileSync(join(dir,'benchmarks/equivalence.ts'),readFileSync(new URL('../equivalence.ts',import.meta.url)));
      for (const name of ['package.json','package-lock.json','tsconfig.json','tsconfig.cjs.json']) writeFileSync(join(dir,name),'{}');
      const original = harnessFingerprint(dir);
      const oracle = join(dir,'benchmarks/equivalence.ts');
      writeFileSync(oracle,readFileSync(oracle,'utf8')+'\n// changed oracle');
      assert.notEqual(harnessFingerprint(dir),original);
      const changed = harnessFingerprint(dir); writeFileSync(join(dir,'package-lock.json'),'{"changed":true}');
      assert.notEqual(harnessFingerprint(dir),changed);
    } finally { rmSync(dir,{recursive:true,force:true}); }
  });
  it('cleans allocated MySQL data and saves identity on missing binary and initialization failure', () => {
    for (const kind of ['missing','initialization']) {
      const dir = mkdtempSync(join(tmpdir(),'evidence-early-failure-'));
      try {
        const bin = join(dir,'bin'); mkdirSync(bin);
        if (kind === 'initialization') writeFileSync(join(bin,'mysqld'), `#!/usr/bin/env node\nconst fs=require('node:fs'); if(process.argv.includes('--version')){console.log('fixture');process.exit(0)} const data=process.argv.find(x=>x.startsWith('--datadir=')).slice(10); fs.writeFileSync(data+'/partial','owned');process.exit(2);\n`,{mode:0o700});
        const result = spawnSync(process.execPath,[fileURLToPath(new URL('./with-mysql.mjs',import.meta.url)),join(dir,'result.json')],{encoding:'utf8',timeout:15000,env:{...process.env,TMPDIR:dir,EVIDENCE_MYSQL_BIN:bin}});
        assert.notEqual(result.status,0,result.stdout+result.stderr);
        const roots = readdirSync(dir).filter(name=>name.startsWith('turbine-evidence-mysql-')); assert.equal(roots.length,1);
        const identity = JSON.parse(readFileSync(join(dir,roots[0],'identity.json')));
        assert.equal(identity.dataRemoved,true); assert.equal(identity.stopped,true); assert.ok(identity.failure);
        assert.equal(existsSync(identity.data),false);
        if (kind === 'initialization') assert.equal(identity.initializationExit.code,2);
      } finally { rmSync(dir,{recursive:true,force:true}); }
    }
  });
  it('refuses invalid, incomplete, skipped-required, mispinned and fabricated distributions', () => {
    validateRun(schemaFixture());
    const mutations = [
      (run) => { delete run.runtime; }, (run) => { run.runtime = {}; },
      (run) => { run.runtime.node = ''; }, (run) => { delete run.runtime.sourcePg; },
      (run) => { delete run.engines[0].settings; }, (run) => { run.engines[0].settings = {}; },
      (run) => { run.engines[0].settings.journalMode = null; },
      (run) => { run.status = 'invalid'; }, (run) => { run.semantics = 'exact-ordered-v1'; },
      (run) => { run.rounds = 0; }, (run) => { run.performanceClaimsAllowed = true; },
      (run) => { run.engines.pop(); }, (run) => { run.engines[0].scenarios.pop(); },
      (run) => { run.engines[0].scenarios[0].arms.pop(); },
      (run) => { run.engines[0].scenarios[0].arms[0].samples[0].wallMs = NaN; },
      (run) => { run.engines[0].scenarios[0].arms[0].distributions.wallMs.median = 999; },
      (run) => { run.installed['drizzle-candidate'] = '0.0.0'; },
      (run) => { run.engines[0].correctness.everyMeasuredEffect = false; },
      (run) => { run.engines[0].cleanup = 'pending'; },
      (run) => { run.engines[0].controls.wrongEffectRejected = false; },
      (run) => { run.engines[0].controls.before.distribution.median = 0; },
      (run) => { run.engines[0].controls.noiseFlag = true; },
      (run) => { delete run.engines[0].controls.nativeRoutes.raw; },
      (run) => { run.engines[0].scenarios[0].arms[0] = { name: 'raw', status: 'unavailable', reason: 'Pretend this supported arm was not available' }; },
    ];
    for (const mutate of mutations) { const run = schemaFixture(); mutate(run); assert.throws(() => validateRun(run)); }
    assert.throws(() => validateRun(schemaFixture(), ['mysql']), /Required engine mysql/);
  });
  it('refuses pooling campaigns across versions, runtimes, sources, transports or duplicate processes', () => {
    const first = schemaFixture();
    const second = structuredClone(first); second.runId = randomUUID();
    const third = structuredClone(first); third.runId = randomUUID();
    assert.equal(validateCampaign([first, second, third]).status, 'compatible');
    const manifest = summarize([first, second, third], ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)]);
    assert.equal(manifest.performanceClaimsAllowed, false);
    assert.equal(manifest.runs.length, 3);
    assert.throws(() => validateCampaign([first, second]), /at least three/);
    assert.throws(() => validateCampaign([first, second, second]), /Duplicate/);
    for (const mutate of [
      (run) => { run.runtime.node = 'v0.0.0'; },
      (run) => { run.source.contentSha256 = 'd'.repeat(64); },
      (run) => { run.engines[0].serverVersion = 'other'; },
      (run) => { run.engines[0].scenarios[0].arms[0].adapter = 'other transport'; },
      (run) => { run.engines[0].scenarios[3].arms[0].transport = 'different transaction or consumption'; },
    ]) { const run = structuredClone(third); mutate(run); assert.throws(() => validateCampaign([first, second, run])); }
  });
  it('CLI records a required-service failure as invalid and refuses to reuse a successful output path', () => {
    const directory = mkdtempSync(join(tmpdir(), 'turbine-evidence-guard-'));
    const output = join(directory, 'result.json');
    const invoke = () => spawnSync(process.execPath, ['--import', fileURLToPath(new URL('./node_modules/tsx/dist/loader.mjs', import.meta.url)),
      fileURLToPath(new URL('./run.mjs', import.meta.url)), output], {
      encoding: 'utf8', env: { ...process.env, EVIDENCE_ROUNDS: '1', EVIDENCE_WARMUP: '1', EVIDENCE_REQUIRE_ENGINES: 'mysql',
        EVIDENCE_PG_ADMIN_URL: '', EVIDENCE_MYSQL_ADMIN_URL: '', EVIDENCE_MSSQL_ADMIN_URL: '' },
    });
    try {
      const missing = invoke();
      assert.equal(missing.status, 1, missing.stderr);
      assert.match(missing.stderr, /Required mysql unavailable/);
      const invalid = JSON.parse(readFileSync(output));
      assert.equal(invalid.status, 'invalid');
      assert.throws(() => validateRun(invalid), /Invalid or interrupted/);
      writeFileSync(output, 'previous-result-sentinel');
      const reused = invoke();
      assert.equal(reused.status, 1);
      assert.match(reused.stderr, /EEXIST/);
      assert.equal(readFileSync(output, 'utf8'), 'previous-result-sentinel');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

describe('live SQLite evidence and negative controls', () => {
  it('checks actual commits, rollbacks, every timed effect and native rows; closes borrowed handles', async () => {
    const context = await openEngine('sqlite');
    assert.ok(!context.unavailable, 'This dedicated evidence suite requires Node >=24.10');
    const result = await engineRun(context, { rounds: 2, warmup: 1 });
    assert.equal(result.status, 'complete');
    assert.equal(result.correctness.everyMeasuredEffect, true);
    assert.equal(result.scenarios[0].arms.filter((arm) => arm.status === 'complete').length, 4);
    assert.equal(result.scenarios[3].arms.filter((arm) => arm.status === 'complete').length, 2);
    assert.throws(() => context.native.prepare('SELECT 1'), /closed|not open/i);
  });
  it('refuses the same measured callback when one returned cell changes and cleans up', async () => {
    const context = await openEngine('sqlite');
    const page = context.arms[0].page;
    context.arms[0].page = async () => (await page()).map((row, index) => index ? row : { ...row, label: 'corrupt' });
    await assert.rejects(() => engineRun(context, { rounds: 1, warmup: 1 }), /exact result mismatch/);
    assert.throws(() => context.native.prepare('SELECT 1'), /closed|not open/i);
  });
  it('refuses corruption introduced only after preflight and warmup, during an actual timed repetition', async () => {
    const context = await openEngine('sqlite');
    const page = context.arms[0].page;
    let calls = 0;
    context.arms[0].page = async () => {
      const result = await page();
      return ++calls === 4 ? result.map((row, index) => index ? row : { ...row, label: 'late corruption' }) : result;
    };
    await assert.rejects(() => engineRun(context, { rounds: 1, warmup: 1 }), /raw page round 0/);
    assert.equal(calls, 4);
    assert.throws(() => context.native.prepare('SELECT 1'), /closed|not open/i);
  });
  it('refuses plausible write returns when the real committed effect changes a different row', async () => {
    const context = await openEngine('sqlite');
    const transaction = context.arms[0].transaction;
    context.arms[0].transaction = async (rollback) => {
      if (rollback) return transaction(true);
      await context.rawTransaction((query) => query('UPDATE evidence_items SET value=value+1 WHERE id=3'));
      return structuredClone(EXPECTED.transaction);
    };
    await assert.rejects(() => engineRun(context, { rounds: 1, warmup: 1 }), /commit actual effects/);
  });
  it('refuses a native arm that returns the correct count without observing the cells', async () => {
    const context = await openEngine('sqlite');
    context.arms[0].native = async () => ({ count: ROW_COUNT });
    await assert.rejects(() => engineRun(context, { rounds: 1, warmup: 1 }), /native route|every streamed cell/);
  });
});
