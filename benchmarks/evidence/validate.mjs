import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { assertMysqlRoute } from './mysql-native.mjs';
import { assertPgRoute } from './pg-native.mjs';
import { distribution } from './metrics.mjs';
import { pins } from './verify-pins.mjs';
import { BATCH_SIZE, ENGINES, ROW_COUNT, SEMANTICS } from './workload.mjs';

const arms = ['raw', 'turbine-source', 'drizzle-stable', 'drizzle-candidate'];
export const SCENARIOS = ['page', 'point', 'transaction', 'native'];
export function validateRun(run, required = []) {
  assert.ok(run && typeof run === 'object' && !Array.isArray(run), 'Result must be an object');
  assert.ok(run.runtime && typeof run.runtime === 'object' && !Array.isArray(run.runtime), 'Missing runtime provenance');
  for (const key of ['node', 'v8', 'openssl', 'sourcePg']) {
    assert.ok(typeof run.runtime[key] === 'string' && run.runtime[key].trim().length > 0, `Missing runtime ${key}`);
  }
  assert.equal(run.schemaVersion, 1, 'Unknown result schema');
  assert.equal(run.semantics, SEMANTICS, 'Incompatible benchmark semantics');
  assert.equal(run.status, 'complete', 'Invalid or interrupted run');
  assert.equal(run.performanceClaimsAllowed, false, 'This runner does not certify speed claims');
  assert.match(run.runId, /^[a-f0-9-]{36}$/);
  assert.ok(Number.isInteger(run.rounds) && run.rounds > 0, 'Invalid rounds');
  assert.ok(Number.isInteger(run.warmup) && run.warmup > 0, 'Invalid warmup');
  assert.equal(run.fixtureRows, ROW_COUNT, 'Wrong fixture size');
  assert.equal(run.batchSize, BATCH_SIZE, 'Wrong native batch size');
  assert.match(run.source.gitHead, /^[a-f0-9]{40}$/);
  assert.match(run.source.contentSha256, /^[a-f0-9]{64}$/);
  assert.match(run.harnessSha256, /^[a-f0-9]{64}$/);
  for (const [name, pin] of Object.entries(pins.selection)) assert.equal(run.installed[name], pin.version, `Wrong installed ${name}`);
  assert.deepEqual(run.engines.map((engine) => engine.engine), ENGINES, 'Missing or duplicate engine');
  for (const engine of run.engines) {
    if (engine.status === 'unavailable') {
      assert.ok(engine.reason?.length > 10, 'Unavailable engine needs a reason');
      assert.ok(!required.includes(engine.engine), `Required engine ${engine.engine} unavailable`);
      assert.equal(engine.scenarios, undefined, 'Unavailable engine must not have measured scenarios');
      continue;
    }
    assert.equal(engine.status, 'complete');
    const settingKeys = { sqlite: ['journalMode', 'synchronous', 'foreignKeys'],
      postgresql: ['isolation', 'synchronous_commit', 'fsync', 'timezone'],
      mysql: ['isolation', 'flush_log', 'charset', 'collation', 'sql_mode', 'autocommit', 'log_bin'],
      mssql: ['compatibility_level', 'is_read_committed_snapshot_on', 'is_delayed_durability_on'] }[engine.engine];
    assert.ok(engine.settings && typeof engine.settings === 'object' && !Array.isArray(engine.settings), 'Missing server settings');
    for (const key of settingKeys) {
      const value = engine.settings[key];
      assert.ok((typeof value === 'string' && (value.trim().length > 0 || key === 'sql_mode')) ||
        (typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean', `Missing or invalid ${engine.engine} setting ${key}`);
    }

    assert.equal(engine.pool.max, 1, 'Connection budget mismatch');
    assert.equal(engine.pool.sharedPhysicalPoolAcrossArms, true, 'Arms must share the same physical pool');
    assert.equal(engine.pool.concurrency, 1, 'Evidence operations must be serial');
    assert.equal(engine.correctness.exactRows, true);
    assert.equal(engine.correctness.everyArmRollback, true);
    assert.equal(engine.correctness.everyMeasuredEffect, true);
    assert.equal(engine.controls.wrongCellAndOrderRejected, true);
    assert.equal(engine.controls.wrongEffectRejected, true);
    for (const probe of [engine.controls.before, engine.controls.after]) {
      assert.deepEqual(probe.distribution, distribution(probe.samplesMs), 'Invalid raw control distribution');
      assert.ok(probe.distribution.median > 0, 'Raw control median must be positive');
    }
    const ratio = engine.controls.after.distribution.median / engine.controls.before.distribution.median;
    assert.equal(engine.controls.probeMedianRatio, ratio);
    assert.equal(engine.controls.noiseFlag, Math.abs(Math.log(ratio)) > Math.log(1.2));
    assert.equal(engine.cleanup, 'complete', 'Scratch cleanup incomplete');
    assert.ok(engine.serverVersion?.length > 0, 'Missing actual server version');
    assert.deepEqual(engine.scenarios.map((scenario) => scenario.id), SCENARIOS, 'Incomplete scenario catalog');
    for (const scenario of engine.scenarios) {
      assert.equal(scenario.consumption, scenario.id === 'native' ? 'native-bounded-drain' : 'materialized');
      assert.deepEqual(scenario.arms.map((arm) => arm.name), arms, 'Incomplete arm catalog');
      for (const arm of scenario.arms) {
        const available = scenario.id === 'native'
          ? ['sqlite', 'postgresql', 'mysql'].includes(engine.engine) && ['raw', 'turbine-source'].includes(arm.name)
          : !(engine.engine === 'mssql' && arm.name === 'drizzle-stable');
        assert.equal(arm.status, available ? 'complete' : 'unavailable', 'Supported arm cannot silently skip; unsupported arm cannot invent support');
        if (arm.status === 'unavailable') {
          assert.ok(arm.reason?.length > 10);
          assert.equal(arm.samples, undefined);
          assert.equal(arm.distributions, undefined);
          continue;
        }
        assert.equal(arm.status, 'complete');
        assert.ok(arm.adapter?.length > 0);
        if (scenario.id === 'native') {
          assert.ok(arm.transport?.length > 10, 'Missing native transaction/consumption contract');
          const route = engine.controls.nativeRoutes?.[arm.name];
          assert.ok(route, 'Missing actual native route audit');
          if (engine.engine === 'sqlite') {
            assert.equal(route.iteratorOpens, 1);
            assert.equal(route.steppedRows, ROW_COUNT);
          } else if (engine.engine === 'mysql') assertMysqlRoute(route);
          else assertPgRoute(route);
        }
        assert.equal(arm.samples.length, run.rounds, 'Incomplete repetitions');
        assert.deepEqual(arm.samples.map((sample) => sample.round), Array.from({ length: run.rounds }, (_, i) => i));
        for (const key of ['wallMs', 'userCpuUs', 'systemCpuUs', 'rssBeforeBytes', 'rssAfterBytes', 'observedPeakRssBytes']) {
          assert.deepEqual(arm.distributions[key], distribution(arm.samples.map((sample) => sample[key])), `Incorrect ${key} distribution`);
        }
      }
      assert.ok(scenario.arms.some((arm) => arm.status === 'complete') || engine.engine === 'mssql', 'Vacuous scenario');
    }
  }
  assert.ok(run.engines.some((engine) => engine.status === 'complete'), 'No engines executed');
  return run;
}

// Campaign compatibility is deliberately stronger than matching display names.
// Never mix historical headline runs, driver versions, transports or source.
export function validateCampaign(runs) {
  assert.ok(runs.length >= 3, 'A campaign requires at least three independent process runs');
  const signature = (run) => JSON.stringify({
    semantics: run.semantics, source: run.source.contentSha256, harness: run.harnessSha256,
    installed: run.installed, runtime: run.runtime, rounds: run.rounds, warmup: run.warmup,
    engines: run.engines.map((engine) => ({ engine: engine.engine, status: engine.status,
      serverVersion: engine.serverVersion, settings: engine.settings, pool: engine.pool,
      catalog: engine.scenarios?.map((scenario) => [scenario.id, scenario.arms.map((arm) => [arm.name, arm.status, arm.adapter, arm.transport])]),
    })),
  });
  for (const run of runs) validateRun(run);
  for (const run of runs.slice(1)) assert.equal(signature(run), signature(runs[0]), 'Incompatible campaign metadata');
  assert.equal(new Set(runs.map((run) => run.runId)).size, runs.length, 'Duplicate process run');
  return { status: 'compatible', performanceClaimsAllowed: false, runs: runs.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const paths = process.argv.slice(2);
  assert.ok(paths.length, 'Usage: validate.mjs result.json [result2.json result3.json ...]');
  const runs = paths.map((path) => JSON.parse(readFileSync(path)));
  console.log(JSON.stringify(paths.length === 1 ? { status: validateRun(runs[0]).status } : validateCampaign(runs)));
}
