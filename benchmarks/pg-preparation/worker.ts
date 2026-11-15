/** Calls the original catalogs and their independent oracles; no replacement workload. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { createExtendedSuite } from '../bench-extended.js';
import { runHeadline } from '../bench-interleaved.js';
import { runLatency } from '../bench-latency.js';
import { runStream } from '../bench-stream-parity.js';
import { runDeepOffset } from '../deepoffset.js';
import { assertExact, type HeadlineScenario } from '../equivalence.js';
import { assertExtendedCatalog, extendedGroups } from '../extended-equivalence.js';
import { startTicks, within } from '../postgres-streaming/process.mjs';
import { assertExtendedRuns } from '../extended-results.js';
import { assertHeadlineRuns } from '../semantics.js';
import type { PgAdmissionOptions } from '../pg-admission.js';
import { assertSecondaryRun } from '../secondary-results.js';

const [suite, destination, mode] = process.argv.slice(2);
assert.ok(suite && destination && ['preflight', 'timing'].includes(mode!), 'suite destination preflight|timing');
const output = dirname(destination!);
const verifyOnly = mode === 'preflight';
const admissionOptions: PgAdmissionOptions = process.env.PG_BENCH_EXPECTED_MANIFEST
  ? { admission: JSON.parse(readFileSync(process.env.PG_BENCH_EXPECTED_MANIFEST, 'utf8')) }
  : { scope: 'preparation' };
const hash = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const loader = new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url).pathname;
const emit = (value: unknown) => writeFileSync(destination!, `${JSON.stringify(value, null, 2)}\n`);
async function child(
  file: string,
  name: string,
  env: Record<string, string> = {},
  success = true,
  extraArgs: string[] = [],
) {
  const args = ['--import', loader, file, ...extraArgs];
  const task = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const identity = {
    command: [process.execPath, ...args],
    pid: task.pid,
    startTicks: startTicks(task.pid),
    exit: null as unknown,
  };
  let text = '';
  task.stdout.on('data', (b) => {
    text += b;
  });
  task.stderr.on('data', (b) => {
    text += b;
  });
  try {
    const exit = await within(
      new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
        task.once('error', reject);
        task.once('close', (code, signal) => resolve({ code, signal }));
      }),
      120000,
      `Control child deadline: ${name}`,
    );
    identity.exit = exit;
    writeFileSync(join(output, `${name}.log`), text);
    assert.equal(exit.signal, null, name);
    assert.equal(exit.code === 0, success, `${name}: ${text.slice(-3000)}`);
    return { text, identity };
  } finally {
    if (task.exitCode === null && task.signalCode === null) task.kill('SIGKILL');
  }
}
function jsonLog(text: string) {
  const match = /=== JSON ===\s*([\s\S]*?)\s*Done\./.exec(text);
  assert.ok(match, 'Structured original-suite JSON required');
  return JSON.parse(match[1]!);
}
if (suite === 'headline') {
  const oracle = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await oracle.connect();
  const before = (await oracle.query('SELECT * FROM posts ORDER BY id')).rows;
  try {
    const result = await runHeadline({ verifyOnly, includeNoJit: verifyOnly, reportPath: destination });
    assert.equal(result.status, 'passed');
    assert.equal(result.cleanup.closed, true);
    assert.equal(result.catalog.length, 11);
    assert.equal(
      result.catalog.reduce((n, s) => n + s.arms.length, 0),
      verifyOnly ? 64 : 53,
    );
    if (verifyOnly) assert.deepEqual(result.results, []);
    else assertHeadlineRuns([result], admissionOptions);
    const increments = verifyOnly ? 0 : (Number(process.env.ROUNDS ?? 200) + Number(process.env.WARMUP ?? 20)) * 5;
    assertExact(
      'Headline measured stored effects',
      (await oracle.query('SELECT * FROM posts ORDER BY id')).rows,
      before.map((row) => (Number(row.id) === 1 ? { ...row, view_count: row.view_count + increments } : row)),
    );
  } finally {
    await oracle.query(
      'UPDATE posts SET view_count=restored.value FROM unnest($1::bigint[], $2::int[]) AS restored(id,value) WHERE posts.id=restored.id',
      [before.map((row) => row.id), before.map((row) => row.view_count)],
    );
    assertExact('Headline restored fixture', (await oracle.query('SELECT * FROM posts ORDER BY id')).rows, before);
    await oracle.end();
  }
} else if (suite === 'extended') {
  const { text, identity } = await child(
    new URL('../bench-extended.ts', import.meta.url).pathname,
    `extended-${mode}-original`,
    { EXTENDED_VERIFY_ONLY: verifyOnly ? '1' : '0' },
  );
  const result = jsonLog(text);
  assert.equal(result.status, 'passed');
  assert.equal(result.preflight.scenarios, 17);
  assert.equal(
    result.catalog.reduce((n: number, s: { arms: unknown[] }) => n + s.arms.length, 0),
    93,
  );
  assert.equal(result.cleanup.status, 'passed');
  if (verifyOnly) assert.deepEqual(result.results, []);
  if (!verifyOnly)
    assertExtendedRuns([result], { ...admissionOptions, allowSmoke: process.env.EXTENDED_QUICK === '1' });
  emit({ ...result, children: [identity] });
} else if (suite === 'stream' || suite === 'latency' || suite === 'deepoffset') {
  const fn = { stream: runStream, latency: runLatency, deepoffset: runDeepOffset }[suite];
  const result = await fn({ verifyOnly, reportPath: destination });
  assertSecondaryRun(result, suite, !verifyOnly, admissionOptions);
  emit(result);
} else if (suite === 'controls') {
  const cases: Record<string, unknown>[] = [];
  const children: unknown[] = [];
  // Refuse controls without prior real installed-package positives for every catalog.
  for (const key of ['headline', 'extended', 'stream', 'latency', 'deepoffset'])
    assert.equal(JSON.parse(readFileSync(join(output, `${key}.json`), 'utf8')).status, 'passed');
  const headlineCases = [
    {
      name: 'headline-missing-scenario',
      diagnostic: /every scenario exactly once/,
      mutate: (s: HeadlineScenario[]) => {
        s.pop();
      },
    },
    {
      name: 'headline-missing-stable',
      diagnostic: /Incomplete arm coverage/,
      mutate: (s: HeadlineScenario[]) => {
        s[0].arms = s[0].arms.filter((a) => a.name !== 'Drizzle');
      },
    },
    {
      name: 'headline-missing-rc-all',
      diagnostic: /RC participation was required/,
      mutate: (s: HeadlineScenario[]) => {
        for (const row of s) row.arms = row.arms.filter((a) => !a.name.startsWith('Drizzle RC'));
      },
    },
    {
      name: 'headline-null-omission',
      diagnostic: /exact result mismatch/,
      mutate: (s: HeadlineScenario[]) => {
        const a = s[3].arms[0];
        const f = a.fn;
        a.fn = async (i: number) => {
          const v = { ...((await f(i)) as Record<string, unknown>) };
          delete v.avatarUrl;
          return v;
        };
      },
    },
    {
      name: 'headline-fake-increment',
      diagnostic: /write effect/,
      mutate: (s: HeadlineScenario[]) => {
        s[7].arms[0].fn = async () => ({ id: 1 });
      },
    },
    {
      name: 'headline-stream-observation',
      diagnostic: /observed count/,
      mutate: (s: HeadlineScenario[]) => {
        const a = s[6].arms[0];
        const f = a.fn;
        a.fn = (i: number) => f(i);
      },
    },
  ];
  for (const c of headlineCases) {
    const path = join(output, `${c.name}.json`);
    await assert.rejects(
      runHeadline({ verifyOnly: true, includeNoJit: true, reportPath: path, mutate: c.mutate }),
      c.diagnostic,
    );
    const r = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(r.status, 'failed');
    assert.equal(r.cleanup.closed, true);
    assert.deepEqual(r.results, []);
    cases.push({ name: c.name, rejectedBeforeTiming: true, error: r.error, reportSha256: hash(path) });
  }
  for (const [key, filename] of [
    ['stream', 'bench-stream-parity'],
    ['latency', 'bench-latency'],
    ['deepoffset', 'deepoffset'],
  ]) {
    if (key !== filename) writeFileSync(join(output, `${filename}.json`), readFileSync(join(output, `${key}.json`)));
  }
  const secondaryChild = await child(
    new URL('../secondary-controls.ts', import.meta.url).pathname,
    'secondary-held-out',
    {},
    true,
    [output],
  );
  children.push(secondaryChild.identity);
  const secondary = JSON.parse(readFileSync(join(output, 'controls.json'), 'utf8'));
  cases.push(...secondary.cases);
  // Use the original extended runner's exact disposable mutation cases; no copied verifier or alternate operation implementation.
  const originalRunner = readFileSync(new URL('../extended-native-smoke.mjs', import.meta.url), 'utf8');
  const configText = / {2}const controls = (\[[\s\S]*?\n {2}\]);/.exec(originalRunner);
  assert.ok(configText, 'Original extended negative-control catalog');
  const extendedControls = Function(`return (${configText[1]});`)() as string[][];
  const original = new URL('../bench-extended.ts', import.meta.url).pathname;
  const source = readFileSync(original, 'utf8');
  const marker = 'report.preflight = await verifyExtended(scenarios, groups, suite.oracle);';
  assert.equal(source.split(marker).length, 2);
  const observer = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await observer.connect();
  try {
    for (const [name, group, mutation, diagnostic] of extendedControls) {
      const path = new URL(`../extended-control-${name}.ts`, import.meta.url).pathname;
      const faulty =
        mutation === 'REPLACE_PREPARED_POLICY'
          ? source.replace('preparedStatements: true', 'preparedStatements: false')
          : source.replace(marker, `${mutation}\n${marker}`);
      assert.notEqual(faulty, source);
      writeFileSync(path, faulty);
      try {
        const { text, identity } = await child(
          path,
          `extended-control-${name}`,
          { GROUPS: group!, EXTENDED_VERIFY_ONLY: '1' },
          false,
        );
        children.push(identity);
        const result = jsonLog(text);
        assert.equal(result.status, 'failed');
        assert.deepEqual(result.results, []);
        assert.equal(result.driftHead, undefined);
        assert.equal(text.includes('[drift probe'), false);
        assert.ok(
          result.errors.join('; ').includes(diagnostic),
          `${name}: expected diagnostic ${diagnostic}: ${result.errors}`,
        );
        if (name === 'restoration') await observer.query("SELECT setval('bench_writes_id_seq',1,false)");
        cases.push({
          name: `extended-${name}`,
          rejectedBeforeTiming: true,
          sourceSha256: hash(path),
          errors: result.errors,
          cleanup: result.cleanup,
        });
      } finally {
        rmSync(path, { force: true });
      }
    }
    // Exhaustive native catalog omission admission, without executing a reduced timing workload.
    const native = await createExtendedSuite(process.env.DATABASE_URL!, 1, 0, true);
    try {
      for (const s of native.scenarios) {
        assert.throws(
          () =>
            assertExtendedCatalog(
              native.scenarios.filter((row) => row.id !== s.id),
              extendedGroups,
            ),
          /every selected catalog row/,
        );
        for (const a of s.arms) {
          const omitted = native.scenarios.map((row) =>
            row === s ? { ...row, arms: row.arms.filter((arm) => arm !== a) } : row,
          );
          assert.throws(() => assertExtendedCatalog(omitted, extendedGroups), /Incomplete extended arm coverage/);
        }
      }
      cases.push({ name: 'extended-native-omissions', scenariosRejected: 17, armsRejected: 93, beforeExecution: true });
    } finally {
      await native.close();
    }
  } finally {
    await observer.end();
  }
  emit({ status: 'passed', mode: 'held-out-negative-controls', cases, children });
} else throw new Error(`Unknown original suite: ${suite}`);

const completed = JSON.parse(readFileSync(destination!, 'utf8'));
completed.resourceDiagnostics = {
  scope:
    'worker process cumulative including untimed setup/preflight; excludes child processes; no global memory bound',
  resourceUsage: process.resourceUsage(),
  memorySnapshotBytes: process.memoryUsage(),
};
emit(completed);
