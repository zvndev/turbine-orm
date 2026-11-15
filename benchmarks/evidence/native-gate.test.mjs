import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gateConfig, nativeGate } from './native-gate.mjs';
import {
  assertEvidenceProvenance,
  assertServerVersion,
  assertTestEvents,
  REQUIRED_CASES,
} from './native-gate-policy.mjs';
import { execute, liveGroup } from './native-gate-child.mjs';
import { assertPgRoute } from './pg-native.mjs';
import { assertMysqlRoute } from './mysql-native.mjs';

const env = { EVIDENCE_DISPOSABLE: '1', EVIDENCE_PG_ADMIN_URL: 'postgresql://evidence@127.0.0.1:15432/postgres' };

it('binds effects to the pre-test harness, runtime and independently observed driver versions', () => {
  const baseline = {
    source: { contentSha256: 'source' },
    harnessSha256: 'before-tests',
    installed: { pg: 'pinned' },
    runtime: { node: process.version, v8: process.versions.v8, sourcePg: '1.2.3', sourceMysql2: '4.5.6' },
  };
  assert.doesNotThrow(() => assertEvidenceProvenance(baseline, structuredClone(baseline)));
  for (const key of ['node', 'v8', 'sourcePg', 'sourceMysql2']) {
    const altered = structuredClone(baseline);
    altered.runtime[key] = 'different';
    assert.throws(() => assertEvidenceProvenance(baseline, altered), /runtime provenance differs/);
    delete altered.runtime[key];
    assert.throws(() => assertEvidenceProvenance(baseline, altered), /runtime provenance differs/);
  }
  assert.throws(
    () => assertEvidenceProvenance(baseline, { ...baseline, harnessSha256: 'after-tests' }),
    /harness provenance/,
  );
  assert.throws(() => assertEvidenceProvenance(baseline, { ...baseline, installed: {} }), /dependency pins/);
});

for (const mode of ['timeout', 'signal'])
  it(`terminates resistant descendant workers after runner exit on ${mode}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'native-gate-worker-control-'));
    const commands = [];
    try {
      const file = join(root, 'parent.mjs');
      writeFileSync(
        file,
        `import {spawn} from 'node:child_process';
      const worker = spawn(process.execPath, ['-e', ${JSON.stringify("process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},100);")}], {stdio:['ignore','ignore','ignore','ipc']});
      worker.once('message', () => { ${mode === 'signal' ? "process.kill(process.ppid,'SIGTERM');" : ''} });
      setInterval(()=>{},100);
    `,
      );
      await assert.rejects(
        execute([file], process.env, join(root, 'stdout'), join(root, 'stderr'), commands, {
          timeoutMs: 1000,
          graceMs: 100,
        }),
        /interrupted or timed out/,
      );
      assert.equal(commands.length, 1);
      assert.equal(commands[0][mode === 'timeout' ? 'timedOut' : 'interrupted'], true);
      assert.equal(commands[0].workersStopped, true);
      assert.deepEqual(liveGroup(commands[0].processGroup), []);
    } finally {
      for (const record of commands)
        if (record.processGroup && liveGroup(record.processGroup).length) process.kill(-record.processGroup, 'SIGKILL');
      rmSync(root, { recursive: true, force: true });
    }
  });
function events(engine) {
  return [
    ...REQUIRED_CASES[engine].map((name) => ({ type: 'test:pass', name, kind: 'test', skip: false, todo: false })),
    {
      type: 'test:summary',
      success: true,
      counts: {
        tests: REQUIRED_CASES[engine].length,
        passed: REQUIRED_CASES[engine].length,
        failed: 0,
        cancelled: 0,
        skipped: 0,
        todo: 0,
      },
    },
  ];
}

it('requires explicit disposable service and a supported exact version before any connection', () => {
  const args = ['postgresql', '18.6', '/tmp/unused-native-gate.json'];
  assert.equal(gateConfig(args, env).engine, 'postgresql');
  for (const altered of [
    {},
    { ...env, EVIDENCE_DISPOSABLE: '0' },
    { ...env, EVIDENCE_PG_ADMIN_URL: '' },
    { ...env, EVIDENCE_PG_ADMIN_URL: 'mysql://root@127.0.0.1/mysql' },
    { ...env, EVIDENCE_PG_ADMIN_URL: 'postgresql://evidence@example.com/postgres' },
    { ...env, EVIDENCE_PG_ADMIN_URL: `${env.EVIDENCE_PG_ADMIN_URL}?sslmode=disable` },
  ])
    assert.throws(() => gateConfig(args, altered));
  assert.throws(() => gateConfig([...args, '--filter'], env));
});
it('refuses wrong patch, wrong major, vendor variants and absent version pins', () => {
  assertServerVersion('postgresql', '18.6', '18.6 (Debian build)');
  assertServerVersion('mysql', '8.4.0');
  for (const [engine, expected, actual] of [
    ['postgresql', '18.6', '17.6'],
    ['postgresql', '18.6', '18.7'],
    ['postgresql', '18', '18.6'],
    ['mysql', '8.4.0', '8.4.13'],
    ['mysql', '8.4', '8.4.0'],
    ['mysql', '8.4.0', '8.4.0-MariaDB'],
    ['mysql', undefined, '8.4.0'],
    ['mssql', '18.6', '18.6'],
  ]) {
    assert.throws(() => assertServerVersion(engine, expected, actual));
  }
});
it('requires exact native case identities, successful summary and no skipped cases', () => {
  for (const engine of ['postgresql', 'mysql']) {
    assert.equal(assertTestEvents(engine, events(engine)).passed, REQUIRED_CASES[engine].length);
    const mutate = (change) => {
      const altered = events(engine);
      change(altered);
      assert.throws(() => assertTestEvents(engine, altered));
    };
    mutate((e) => e.splice(0, 1));
    mutate((e) => {
      e[0].name = 'unrelated test';
    });
    mutate((e) => {
      e[0].skip = 'missing service';
    });
    mutate((e) => {
      e[0].todo = true;
    });
    mutate((e) => {
      e[0].type = 'test:fail';
    });
    mutate((e) => {
      e.at(-1).counts.cancelled = 1;
    });
    mutate((e) => {
      e.at(-1).counts.passed = 0;
    });
    mutate((e) => {
      e.at(-1).success = false;
    });
    mutate((e) => e.pop());
    mutate((e) => e.push(e.at(-1)));
    mutate((e) => e.unshift(e[0]));
  }
});
it('reads actual Node reporter events and rejects a skipped required test', () => {
  const root = mkdtempSync(join(tmpdir(), 'native-gate-reporter-'));
  try {
    const path = join(root, 'test.mjs');
    for (const skip of [false, true]) {
      writeFileSync(
        path,
        `import { it } from 'node:test'; it(${JSON.stringify(REQUIRED_CASES.postgresql[0])}, {skip:${skip}}, () => {});`,
      );
      const childEnv = { ...process.env };
      delete childEnv.NODE_TEST_CONTEXT;
      const run = spawnSync(
        process.execPath,
        ['--test', `--test-reporter=${fileURLToPath(new URL('./native-gate-reporter.mjs', import.meta.url))}`, path],
        { encoding: 'utf8', env: childEnv },
      );
      assert.equal(run.status, 0, run.stderr);
      const observed = run.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      if (skip) assert.throws(() => assertTestEvents('postgresql', observed), /skipped/);
      else assert.equal(assertTestEvents('postgresql', observed).passed, 1);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it('records invalid missing prerequisite and refuses report reuse without overwriting it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'native-gate-prerequisite-'));
  const path = join(root, 'gate.json');
  try {
    await assert.rejects(nativeGate(['postgresql', '18.6', path], {}), /invalid during prerequisites/);
    const report = JSON.parse(readFileSync(path));
    assert.equal(report.status, 'invalid');
    assert.equal(report.cleanup.scratch, 'not-checked');
    assert.deepEqual(report.commands, []);
    const before = readFileSync(path, 'utf8');
    await assert.rejects(nativeGate(['postgresql', '18.6', path], env), /EEXIST/);
    assert.equal(readFileSync(path, 'utf8'), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it('the existing route guards reject absent, wrong-driver and materialized observations', () => {
  // Explicit negative fixtures only; these do not count as native proof.
  for (const driver of [undefined, 'wrong-driver', 'mysql2', 'pg']) {
    assert.throws(() => assertPgRoute({ driver, statements: [], commands: [] }));
    assert.throws(() =>
      assertMysqlRoute({ driver, statements: [], commands: [], physicalConnections: 1, pauseCalls: 0, resumeCalls: 0 }),
    );
  }
});
it('container setup reuses the immutable MySQL pin and pins PG18.6 separately', () => {
  const config = JSON.parse(readFileSync(new URL('./native-gate-services.json', import.meta.url)));
  const existing = JSON.parse(readFileSync(new URL('./services.json', import.meta.url)));
  const script = readFileSync(new URL('./native-gate-container.mjs', import.meta.url), 'utf8');
  assert.match(config.postgresql.image, /^postgres@sha256:[a-f0-9]{64}$/);
  assert.equal(config.postgresql.expectedVersion, '18.6');
  assert.match(existing.images.mysql.image, /^mysql@sha256:[a-f0-9]{64}$/);
  assert.equal(config.mysql.reuse, 'services.json#images.mysql');
  assert.match(config.mysql.expectedVersion, /^8\.4\.\d+$/);
  assert.ok(script.includes('mysqlServices.images.mysql.image'));
  assert.ok(script.includes("'--tmpfs'"));
});
it('container command failure fixtures verify owned removal and never claim native execution', () => {
  const root = mkdtempSync(join(tmpdir(), 'native-gate-container-controls-'));
  try {
    const docker = join(root, 'docker');
    writeFileSync(
      docker,
      `#!${process.execPath}
import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';
const args=process.argv.slice(2), log=process.env.FIXTURE_LOG, state=process.env.FIXTURE_STATE;
appendFileSync(log,JSON.stringify(args)+'\\n');
if(args[0]==='pull') process.exit(process.env.FIXTURE_MODE==='pull-failure'?1:0);
if(args[0]==='run') {writeFileSync(state,args[args.indexOf('--name')+1]);process.exit(process.env.FIXTURE_MODE==='run-failure'?1:0);}
if(args[0]==='exec') process.exit(1);
if(args[0]==='inspect') {console.log('false');process.exit(0);}
if(args[0]==='rm') {if(process.env.FIXTURE_MODE==='cleanup-failure') process.exit(1);writeFileSync(state,'');process.exit(0);}
if(args[0]==='ps') {process.stdout.write(readFileSync(state,'utf8'));process.exit(0);}
process.exit(2);
`,
      { mode: 0o755 },
    );
    for (const mode of ['pull-failure', 'run-failure', 'readiness-failure', 'cleanup-failure']) {
      const report = join(root, `${mode}.json`),
        log = `${report}.calls`,
        state = `${report}.state`;
      const result = spawnSync(
        process.execPath,
        [fileURLToPath(new URL('./native-gate-container.mjs', import.meta.url)), 'postgresql', report],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${root}:${process.env.PATH}`,
            FIXTURE_MODE: mode,
            FIXTURE_LOG: log,
            FIXTURE_STATE: state,
          },
        },
      );
      assert.equal(result.status, 1, result.stderr);
      const identity = JSON.parse(readFileSync(`${report}.container.json`));
      assert.equal(identity.status, 'invalid');
      assert.equal(identity.cleanup.containerRemoved, ['run-failure', 'readiness-failure'].includes(mode));
      const calls = readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const removals = calls.filter((args) => args[0] === 'rm');
      assert.equal(removals.length, mode === 'pull-failure' ? 0 : 1);
      if (removals.length) assert.equal(removals[0].at(-1), identity.name);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
