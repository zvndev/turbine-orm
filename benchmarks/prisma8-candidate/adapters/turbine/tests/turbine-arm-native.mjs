import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { command } from '../../../../../tooling/optional-pg-transports/harness.mjs';
import { runWithShutdown } from '../../../../../tooling/optional-pg-transports/run.mjs';
import { readFixture } from '../../../dist/canonical/equivalence.js';
import {
  expectedWrite,
  prepareWrite,
  scratchQuery,
  verifyWrite,
} from '../../../dist/canonical/extended-equivalence.js';
import { catalog } from '../../../scripts/catalog.mjs';
import { comparators } from '../../../scripts/comparators.mjs';
import { execute } from '../../../scripts/execution.mjs';
import { drain, observe } from '../../../scripts/native.mjs';
import { startService } from '../../../scripts/service.mjs';
import { readJson, saveJson, sha256 } from '../archive.mjs';
import { verifyBundle } from '../verify.mjs';

const options = {};
for (let n = 2; n < process.argv.length; n += 2) options[process.argv[n].replace(/^--/, '')] = process.argv[n + 1];
assert.ok(options.bundle && options['service-plan'], '--bundle and --service-plan required');
const out = resolve(options.bundle);
const identity = verifyBundle(out);
const plan = readJson(options['service-plan']);
const candidate = resolve(import.meta.dirname, '../../..');
const report = {
  label: identity.label,
  artifact: identity.artifact,
  moduleSha256: identity.module.sha256,
  commands: [],
  services: [],
  controls: [],
};
const passed = (id, detail = {}) => report.controls.push({ id, status: 'passed', ...detail });

async function runControls(scope) {
  const service = await startService(plan, report, scope);
  await command(
    report,
    candidate,
    process.execPath,
    [join(candidate, 'dist/canonical/seed-neon.js')],
    {
      ...process.env,
      DATABASE_URL: service.url,
      USERS: '1000',
      POSTS_PER_USER: '10',
      COMMENTS_PER_POST: '5',
      WIDE_ROWS: '2000',
      TZ: 'UTC',
      NODE_PATH: '',
      NODE_OPTIONS: '',
    },
    { scope, timeoutMs: 60000 },
  );
  const oracle = new pg.Client({ connectionString: service.url });
  scope.registerStop(() => oracle.end());
  await oracle.connect();
  const fixture = await readFixture(oracle);
  const { createArm } = await import(pathToFileURL(join(out, 'turbine-arm.mjs')).href);
  const pool = new pg.Pool({ connectionString: service.url, max: 3 });
  scope.registerStop(() => pool.end());
  const trace = observe(pool);
  const clients = [];
  const clientQueries = [];
  pool.on('connect', (client) => {
    const query = client.query;
    clients.push(() => {
      client.query = query;
    });
    client.query = function (...args) {
      clientQueries.push({ pid: client.processID, text: typeof args[0] === 'string' ? args[0] : args[0]?.text });
      return query.apply(this, args);
    };
  });
  const arm = await createArm({ pool, runtime: process.version, driver: 'pg@8.22.0' });
  scope.registerStop(() => arm.close());
  assert.equal(arm.pool, pool);

  await assert.rejects(async () => createArm({ pool, runtime: process.version, driver: 'pg@8.23.1' }), /requires pg/);
  await assert.rejects(
    async () => createArm({ pool: {}, runtime: process.version, driver: 'pg@8.22.0' }),
    /actual loaded native pg.Pool/,
  );
  passed('wrong-driver-and-pool-refused');

  const pin = readJson(join(out, 'comparators.json'));
  pin.arms[0].module.sha256 = '0'.repeat(64);
  const badPin = join(plan.out, 'wrong-bundle.json');
  saveJson(badPin, pin);
  await assert.rejects(() => comparators(badPin, service.url, catalog(), {}, scope), /Comparator module changed/);
  passed('producer-rejects-wrong-bundle-hash');

  trace.length = 0;
  const receipt = await drain(arm.stream(), fixture.comments, 'Turbine BUFFERED full drain', scope);
  assert.equal(receipt.count, 50000);
  assert.ok(
    trace.some((v) => v.kind === 'execute'),
    'Native wire proof required',
  );
  assert.ok(!trace.some((v) => v.kind === 'execute' && v.rows > 0), 'Buffered arm unexpectedly used cursor fetches');
  assert.ok(
    trace.some((v) => v.kind === 'parse' && v.name),
    'Explicit prepared policy did not produce a named statement',
  );
  passed('buffered-full-drain-and-native-named-policy', { receipt, cursor: false });

  async function* truncated() {
    let count = 0;
    for await (const row of arm.stream()) if (++count < 50000) yield row;
  }
  await assert.rejects(
    () => drain(truncated(), fixture.comments, 'truncated Turbine control', scope),
    /full drain omitted rows/,
  );
  passed('producer-rejects-truncated-buffered-drain');

  const rows = await arm.runExtended('comments-5000');
  await assert.rejects(
    () => drain(rows.slice(1), fixture.comments.slice(0, 5000), 'omitted buffered row', scope),
    /exact result mismatch/,
  );
  passed('producer-rejects-truncated-result-values');

  await prepareWrite(oracle, 'update');
  const before = (await oracle.query(scratchQuery)).rows;
  const convincing = expectedWrite('update', before, 7).returning;
  await assert.rejects(
    () => verifyWrite(oracle, 'update', 'no-write control', before, 7, convincing),
    /actual write effect: exact result mismatch/,
  );
  await verifyWrite(oracle, 'update', 'actual typed update', before, 7, await arm.runExtended('update', 7));
  passed('producer-rejects-convincing-return-without-write');

  for (const id of ['create-many', 'update', 'upsert', 'delete']) {
    for (const i of [0, 3]) {
      await prepareWrite(oracle, id);
      const snapshot = (await oracle.query(scratchQuery)).rows;
      await verifyWrite(oracle, id, `typed ${id} iteration${i}`, snapshot, i, await arm.runExtended(id, i));
    }
  }
  passed('write-returning-and-independent-effects', { cases: 8 });

  let active = 0,
    peak = 0,
    calls = 0;
  const query = pool.query;
  pool.query = function (...args) {
    active++;
    calls++;
    peak = Math.max(peak, active);
    return query.apply(this, args).finally(() => {
      active--;
    });
  };
  try {
    await arm.dashboard('independent');
    assert.equal(calls, 5);
    assert.ok(peak > 1, 'Independent reads were serialized');
    passed('independent-promise-all', { calls, peakOutstanding: peak });
    calls = 0;
    peak = 0;
    trace.length = 0;
    await arm.dashboard('sequential');
    assert.equal(calls, 5);
    assert.equal(peak, 1);
    assert.ok(!trace.some((v) => /BEGIN|COMMIT/.test(v.text ?? '')));
    passed('sequential-autocommit', { calls, peakOutstanding: peak });
    calls = 0;
    trace.length = 0;
    clientQueries.length = 0;
    await arm.dashboard('transaction');
    assert.equal(calls, 0, 'Transaction used pool.query instead of its checked-out client');
    const texts = trace.map((v) => v.text ?? '').join('\n');
    assert.match(texts, /BEGIN/);
    assert.match(texts, /COMMIT/);
    assert.equal(trace.filter((v) => v.kind === 'execute').length, 5);
    assert.equal(new Set(clientQueries.map((q) => q.pid)).size, 1, 'Transaction crossed backend sessions');
    assert.ok(clientQueries.length >= 7, 'Five reads plus transaction controls required');
    passed('five-sequential-reads-in-pinned-transaction', {
      poolQueryCalls: calls,
      backendPids: [...new Set(clientQueries.map((q) => q.pid))],
    });
  } finally {
    pool.query = query;
  }

  await arm.close();
  await arm.close();
  assert.equal((await pool.query('SELECT 19 AS n')).rows[0].n, 19);
  assert.throws(() => arm.runHeadline(0), /closed/);
  await assert.rejects(() => drain(arm.stream(), fixture.comments, 'closed arm', scope), /closed/);
  passed('idempotent-close-preserves-caller-pool-and-refuses-queries');
  trace.detach();
  for (const restore of clients) restore();
  await oracle.query('TRUNCATE bench_writes RESTART IDENTITY');
}

await runWithShutdown(report, join(plan.out, 'report.json'), (scope) =>
  execute(scope, () => runControls(scope), 'Turbine native controls', 120000),
);

console.log(
  JSON.stringify({
    status: 'passed',
    controls: report.controls.length,
    report: join(plan.out, 'report.json'),
    sha256: sha256(readFileSync(join(plan.out, 'report.json'))),
  }),
);
