import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism, cpus, loadavg, platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { auditNative, openEngine } from './engines.mjs';
import { distribution, measure } from './metrics.mjs';
import { SCENARIOS, validateRun } from './validate.mjs';
import { verifyPins } from './verify-pins.mjs';
import {
  BATCH_SIZE,
  checkRows,
  ENGINES,
  EXPECTED,
  EXPECTED_DRAIN,
  FIXTURE,
  positiveInteger,
  requiredEngines,
  ROW_COUNT,
  SEMANTICS,
} from './workload.mjs';

import { sourceFingerprint, harnessFingerprint } from './fingerprint.mjs';
export { harnessFingerprint } from './fingerprint.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

function writeResult(path, result) {
  // An interrupted run cannot leave a previous successful result at this path.
  writeFileSync(`${path}.pending`, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  renameSync(`${path}.pending`, path);
}

export async function engineRun(context, config) {
  const result = {
    engine: context.engine,
    status: 'running',
    serverVersion: context.version,
    settings: context.settings,
    pool: { max: 1, sharedPhysicalPoolAcrossArms: true, concurrency: 1 },
    correctness: { exactRows: false, everyArmRollback: false, everyMeasuredEffect: false },
    controls: { nativeRoutes: {} },
    scenarios: [],
    cleanup: 'pending',
  };
  try {
    checkRows('seed oracle', await context.all(), FIXTURE);
    // Same-count wrong values and ordering are live negative controls against
    // the exact oracle used by the measured callbacks.
    const page = await context.arms[0].page();
    assert.throws(
      () =>
        checkRows(
          'wrong-cell negative control',
          page.map((row, i) => (i ? row : { ...row, label: 'wrong' })),
          EXPECTED.page,
        ),
      /exact result mismatch/,
    );
    assert.throws(
      () => checkRows('wrong-order negative control', [...page].reverse(), EXPECTED.page),
      /exact result mismatch/,
    );
    result.controls.wrongCellAndOrderRejected = true;
    for (const arm of context.arms) {
      checkRows(`${arm.name} page preflight`, await arm.page(), EXPECTED.page);
      for (let i = 0; i < 16; i++) checkRows(`${arm.name} point ${i}`, await arm.point(i), EXPECTED.point(i));
      await assert.rejects(async () => arm.transaction(true), /evidence rollback control/);
      checkRows(`${arm.name} rollback actual effects`, await context.all(), FIXTURE);
      checkRows(`${arm.name} commit return`, await arm.transaction(), EXPECTED.transaction);
      checkRows(`${arm.name} commit actual effects`, await context.all(), EXPECTED.transaction);
      await context.reset();
      if (arm.native) {
        const audited = await auditNative(context, arm);
        assert.deepEqual(audited.value, EXPECTED_DRAIN, `${arm.name} every streamed cell`);
        result.controls.nativeRoutes[arm.name] = audited.route;
      }
    }
    result.correctness.exactRows = true;
    result.correctness.everyArmRollback = true;
    // A plausible return value cannot conceal a write to the wrong row.
    await context.rawTransaction(async (query) => {
      await query('UPDATE evidence_items SET value=value+1 WHERE id=3');
    });
    await assert.rejects(
      async () => checkRows('wrong-effect negative control', await context.all(), FIXTURE),
      /exact result mismatch/,
    );
    await context.exec('UPDATE evidence_items SET value=value-1 WHERE id=3');
    checkRows('negative control restoration', await context.all(), FIXTURE);
    result.controls.wrongEffectRejected = true;
    const probe = async () => {
      const values = [];
      for (let i = 0; i < Math.max(5, config.warmup); i++) await context.query('SELECT 1 AS evidence_probe');
      for (let i = 0; i < Math.max(10, config.rounds); i++) {
        const start = performance.now();
        await context.query('SELECT 1 AS evidence_probe');
        values.push(performance.now() - start);
      }
      return { samplesMs: values, distribution: distribution(values), loadavg: loadavg() };
    };
    result.controls.before = await probe();
    for (const id of SCENARIOS) {
      const scenario = { id, consumption: id === 'native' ? 'native-bounded-drain' : 'materialized', arms: [] };
      const active = [];
      for (const name of ['raw', 'turbine-source', 'drizzle-stable', 'drizzle-candidate']) {
        const arm = context.arms.find((candidate) => candidate.name === name);
        const fn = arm?.[id];
        if (!fn) {
          scenario.arms.push({
            name,
            status: 'unavailable',
            reason:
              context.unavailableArms.find((candidate) => candidate.arm === name)?.reason ??
              'Native consumption not implemented in this adapter; materialized reads are a separate scenario',
          });
          continue;
        }
        const target = {
          name,
          status: 'complete',
          adapter: arm.adapter,
          ...(id === 'native' ? { transport: arm.nativeContract } : {}),
          samples: [],
        };
        scenario.arms.push(target);
        active.push({ arm, target });
      }
      const operation = async ({ arm, target }, round, timed) => {
        if (id === 'transaction') await context.reset();
        config.checkInterrupted?.();
        const fn = (i, sample) => (id === 'transaction' ? arm.transaction() : arm[id](i, sample));
        const measured = timed ? await measure(fn, round, context.serverPid) : { value: await fn(round, () => {}) };
        if (id === 'native') assert.deepEqual(measured.value, EXPECTED_DRAIN, `${arm.name} native exact digest`);
        else
          checkRows(
            `${arm.name} ${id} round ${round}`,
            measured.value,
            id === 'point' ? EXPECTED.point(round) : EXPECTED[id],
          );
        // Verify complete table effects after every warmup AND timed operation,
        // outside the timed interval, including read-only arms.
        checkRows(
          `${arm.name} ${id} independent effects`,
          await context.all(),
          id === 'transaction' ? EXPECTED.transaction : FIXTURE,
        );
        if (timed) target.samples.push(measured.sample);
        if (id === 'transaction') await context.reset();
      };
      for (let round = 0; round < config.warmup; round++) {
        for (let index = 0; index < active.length; index++)
          await operation(active[(index + round) % active.length], round, false);
      }
      for (let round = 0; round < config.rounds; round++) {
        for (let index = 0; index < active.length; index++)
          await operation(active[(index + round) % active.length], round, true);
      }
      for (const { target } of active)
        target.distributions = Object.fromEntries(
          ['wallMs', 'userCpuUs', 'systemCpuUs', 'rssBeforeBytes', 'rssAfterBytes', 'observedPeakRssBytes'].map(
            (key) => [key, distribution(target.samples.map((sample) => sample[key]))],
          ),
        );
      result.scenarios.push(scenario);
    }
    result.controls.after = await probe();
    result.controls.probeMedianRatio =
      result.controls.after.distribution.median / result.controls.before.distribution.median;
    result.controls.noiseFlag = Math.abs(Math.log(result.controls.probeMedianRatio)) > Math.log(1.2);
    result.correctness.everyMeasuredEffect = true;
    result.status = 'complete';
  } finally {
    await context.close();
    result.cleanup = 'complete';
  }
  return result;
}

async function main() {
  const output = process.argv[2] ? resolve(process.argv[2]) : join(mkdtempSync(join(tmpdir(), 'turbine-evidence-')), 'evidence.json');
  // Refuse reuse before configuration parsing: stale success must never be
  // mistaken for the output of a new invocation that fails before measuring.
  writeFileSync(output, '{"status":"initializing"}\n', { flag: 'wx', mode: 0o600 });
  const rounds = positiveInteger(process.env.EVIDENCE_ROUNDS ?? '30', 'EVIDENCE_ROUNDS');
  const warmup = positiveInteger(process.env.EVIDENCE_WARMUP ?? '5', 'EVIDENCE_WARMUP');
  const required = requiredEngines(process.env.EVIDENCE_REQUIRE_ENGINES);
  const source = {
    gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    contentSha256: sourceFingerprint(),
  };
  const rootRequire = createRequire(new URL('../../package.json', import.meta.url));
  const run = {
    schemaVersion: 1,
    semantics: SEMANTICS,
    status: 'running',
    runId: randomUUID(),
    at: new Date().toISOString(),
    performanceClaimsAllowed: false,
    classification: rounds < 100 || warmup < 20 ? 'smoke' : 'measurement-candidate',
    rounds,
    warmup,
    fixtureRows: ROW_COUNT,
    batchSize: BATCH_SIZE,
    source,
    harnessSha256: harnessFingerprint(),
    installed: verifyPins(),
    runtime: {
      node: process.version,
      v8: process.versions.v8,
      openssl: process.versions.openssl,
      sourcePg: rootRequire('pg/package.json').version,
      sourceMysql2: rootRequire('mysql2/package.json').version,
    },
    host: {
      platform: platform(),
      release: release(),
      architecture: process.arch,
      cpuModel: cpus()[0]?.model,
      logicalCpuCount: cpus().length,
      availableParallelism: availableParallelism(),
      memoryBytes: totalmem(),
      loadavg: loadavg(),
    },
    resourcePolicy:
      'Client process CPU deltas include all threads; observed RSS samples at call/batch boundaries are not true allocation peaks. maxRSS is process lifetime, not per-arm. Same-user local PG backend ticks/RSS exclude shared workers and other backends. Network server CPU/RSS unavailable. No speed claims; shared-host load, small samples, cache/GC and untimed verification affect measurements.',
    engines: [],
  };
  writeResult(output, run);
  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const checkInterrupted = () => {
    if (interrupted) throw new Error('Evidence run interrupted');
  };
  try {
    for (const engine of ENGINES) {
      checkInterrupted();
      const context = await openEngine(engine);
      if (context.unavailable) {
        run.engines.push({ engine, status: 'unavailable', reason: context.unavailable });
        if (required.includes(engine)) throw new Error(`Required ${engine} unavailable: ${context.unavailable}`);
      } else run.engines.push(await engineRun(context, { rounds, warmup, checkInterrupted }));
      writeResult(output, run);
      console.log(`${engine}: ${run.engines.at(-1).status}`);
    }
    assert.equal(sourceFingerprint(), run.source.contentSha256, 'Source changed during run');
    assert.equal(harnessFingerprint(), run.harnessSha256, 'Harness changed during run');
    assert.deepEqual(verifyPins(), run.installed, 'Installed packages changed during run');
    run.status = 'complete';
    validateRun(run, required);
    writeResult(output, run);
    console.log(`Validated evidence: ${output} (performance claims disabled)`);
  } catch (error) {
    run.status = 'invalid';
    run.failure = {
      name: error.name,
      message:
        'Execution, correctness, prerequisite or cleanup failed; see local stderr. No numbers from this run are valid.',
    };
    writeResult(output, run);
    throw error;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
