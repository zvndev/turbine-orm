import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { validateCampaign } from './validate.mjs';

/** Public provenance-free manifest; detailed resource samples stay in run files.
 * Never combines sample medians or emits a winner from a small campaign. */
export function summarize(runs, hashes) {
  validateCampaign(runs);
  assert.equal(hashes.length, runs.length);
  return {
    schemaVersion: 1, semantics: runs[0].semantics, performanceClaimsAllowed: false,
    classification: runs[0].classification, source: runs[0].source,
    harnessSha256: runs[0].harnessSha256, installed: runs[0].installed, runtime: runs[0].runtime,
    fixtureRows: runs[0].fixtureRows, batchSize: runs[0].batchSize, rounds: runs[0].rounds, warmup: runs[0].warmup,
    limitations: [
      'Smoke correctness/resource evidence only; no speed, superiority or general cross-engine conclusion.',
      'Shared host; independent process runs reuse warm server/OS caches and are not cold-start measurements.',
      'Unavailable engines are not successful execution or certification; a native route audit is separate from server/version coverage.',
      'Raw/Drizzle writes and Turbine writes share transaction/effect semantics but include different RETURNING/reselection work.',
      'RSS samples are observed boundaries, not true peaks; process maxRSS is cumulative; local PG backend resources exclude shared workers.',
      'No relations, JSON, decimal, temporal, concurrent load or Prisma workloads in this runner.',
    ],
    runs: runs.map((run, index) => ({
      runId: run.runId, at: run.at, resultSha256: hashes[index],
      engines: run.engines.map((engine) => engine.status === 'unavailable'
        ? { engine: engine.engine, status: engine.status, reason: engine.reason }
        : {
          engine: engine.engine, status: engine.status, actualServerVersion: engine.serverVersion,
          settings: engine.settings, pool: engine.pool, correctness: engine.correctness, cleanup: engine.cleanup,
          controls: { wrongCellAndOrderRejected: engine.controls.wrongCellAndOrderRejected,
            wrongEffectRejected: engine.controls.wrongEffectRejected,
            nativeRoutes: engine.controls.nativeRoutes,
            probeMedianRatio: engine.controls.probeMedianRatio, noiseFlag: engine.controls.noiseFlag },
          scenarios: engine.scenarios.map((scenario) => ({
            id: scenario.id, consumption: scenario.consumption,
            arms: scenario.arms.map((arm) => arm.status === 'unavailable'
              ? { name: arm.name, status: arm.status, reason: arm.reason }
              : { name: arm.name, status: arm.status, adapter: arm.adapter,
                ...(arm.transport ? { transport: arm.transport } : {}),
                samples: arm.samples.length,
                clientCpuAndRssSamples: arm.samples.filter((sample) => sample.userCpuUs >= 0 && sample.observedPeakRssBytes > 0).length,
                attributedLocalServerSamples: arm.samples.filter((sample) => sample.serverBefore && sample.serverAfter).length,
              }),
          })),
        }),
    })),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [output, ...inputs] = process.argv.slice(2);
  assert.ok(output && inputs.length >= 3, 'Usage: summarize.mjs manifest.json run1.json run2.json run3.json [...]');
  const bytes = inputs.map((input) => readFileSync(input));
  const runs = bytes.map((value) => JSON.parse(value));
  const hashes = bytes.map((value) => createHash('sha256').update(value).digest('hex'));
  writeFileSync(output, `${JSON.stringify(summarize(runs, hashes), null, 2)}\n`, { flag: 'wx' });
  console.log(`Wrote smoke evidence manifest: ${output}`);
}
