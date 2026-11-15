/** Admission contract for the campaign owner's aggregation, before combining medians. */
import assert from 'node:assert/strict';
import { assertPgProvenance, assertPgSamples, type PgAdmissionOptions } from './pg-admission.js';

import type { ExtendedId } from './extended-equivalence.js';
import {
  assertExtendedExact,
  EXTENDED_SEMANTICS,
  EXTENDED_BOUNDARIES,
  extendedUnsupported,
  extendedCatalog,
  extendedGroups,
  fixtureCounts,
  preparedPolicy,
  requiredArms,
} from './extended-equivalence.js';

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected extended result object');
  return value as ObjectValue;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Expected extended result array');
  return value;
}
function positive(value: unknown, zero = false): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (zero ? 0 : 1))
    throw new Error('Invalid extended sample setting');
  return value;
}
function expectedSamples(id: ExtendedId, settings: ObjectValue): number {
  const rounds = positive(settings.rounds);
  if (id === 'cold-user') return positive(settings.coldRounds);
  if (settings.quick === true) return rounds;
  if (id === 'comments-50000') return Math.max(10, Math.floor(rounds / 10));
  if (id === 'wide-1000') return Math.max(20, Math.floor(rounds / 2));
  if (id === 'create-many') return Math.max(15, Math.floor(rounds / 5));
  return rounds;
}
/** Historical logs, partial groups, failed preflight/cleanup and missing RC never aggregate. */
export function assertExtendedRuns(
  runs: unknown[],
  options: PgAdmissionOptions & { allowSmoke?: boolean } = {},
): typeof EXTENDED_SEMANTICS {
  if (!runs.length) throw new Error('No extended runs to aggregate');
  let baseline: unknown;
  for (const [index, value] of runs.entries()) {
    const run = object(value),
      label = `Extended run ${index + 1}`;
    if (run.extendedSemantics !== EXTENDED_SEMANTICS || run.status !== 'passed')
      throw new Error(`${label}: unsupported semantics or failed run`);
    if (
      run.mode !== 'full' &&
      !(options.allowSmoke && options.scope !== undefined && options.scope !== 'final' && run.mode === 'bounded-smoke')
    )
      throw new Error(`${label}: correctness/smoke logs cannot become full timing evidence`);
    assertExtendedExact(`${label} complete groups`, run.groups, extendedGroups);
    const preflight = object(run.preflight),
      cleanup = object(run.cleanup),
      profile = object(run.profile),
      prepared = object(profile.prepared),
      settings = object(run.settings);
    if (preflight.status !== 'passed' || preflight.scenarios !== 17 || preflight.cases !== 113)
      throw new Error(`${label}: incomplete exact preflight`);
    assertExtendedExact(`${label} fixture scale`, preflight.fixtureCounts, fixtureCounts);
    assertExtendedExact(`${label} preflight groups`, preflight.groups, extendedGroups);
    if (
      cleanup.status !== 'passed' ||
      cleanup.clientsDisconnected !== true ||
      cleanup.borrowedPoolsEnded !== true ||
      cleanup.scratchAndSequenceRestored !== true
    )
      throw new Error(`${label}: unproven cleanup`);
    if (
      profile.driver !== 'pg8.23.1' ||
      profile.turbine !== 'supplied-pool' ||
      profile.poolMax !== 10 ||
      profile.coldPoolMax !== 10 ||
      profile.drizzleRc !== 'jit=true' ||
      prepared.preparedStatements !== true ||
      prepared.poolIdentity !== true ||
      prepared.nativeNamedVerified !== true ||
      prepared.nativeForceCustomPlanUnnamedVerified !== true ||
      typeof prepared.descriptorName !== 'string' ||
      !prepared.descriptorName
    )
      throw new Error(`${label}: driver/pool/prepared profile mismatch`);
    if (!['object', 'positional'].includes(String(profile.jsonEncoding)))
      throw new Error(`${label}: unverified JSON encoding`);
    const versions = object(run.versions);
    for (const [key, expected] of Object.entries({
      pg: '8.23.1',
      drizzleStable: '0.45.4',
      drizzleRc: '1.0.0-rc.5',
      prisma: '7.10.1',
      prismaAdapter: '7.10.1',
    }))
      if (versions[key] !== expected) throw new Error(`${label}: dependency mismatch ${key}`);
    positive(settings.rounds);
    positive(settings.warmup, true);
    positive(settings.coldRounds);
    if (settings.quick !== (run.mode === 'bounded-smoke')) throw new Error(`${label}: mislabeled timing mode`);
    if (options.scope !== 'historical')
      assert.equal(run.unsupportedSemantics, EXTENDED_BOUNDARIES, 'Versioned unsupported declaration required');
    const catalog = array(run.catalog).map(object),
      results = array(run.results).map(object);
    if (
      catalog.length !== 17 ||
      results.length !== 17 ||
      new Set(catalog.map((s) => s.id)).size !== 17 ||
      new Set(results.map((s) => s.scenario)).size !== 17
    )
      throw new Error(`${label}: incomplete or duplicate scenario catalog`);
    for (const entry of extendedCatalog) {
      const declared = catalog.find((s) => s.id === entry.id),
        measured = results.find((s) => s.scenario === entry.scenario);
      if (
        !declared ||
        declared.scenario !== entry.scenario ||
        declared.group !== entry.group ||
        declared.selected !== true ||
        !measured
      )
        throw new Error(`${label}: missing ${entry.id}`);
      assert.deepEqual(
        declared.unsupported ?? [],
        entry.id === 'strategy-many' ? extendedUnsupported : [],
        'Complete extended unsupported flatten declaration required',
      );
      const arms = requiredArms(entry.id),
        declaredArms = array(declared.arms).map(object),
        stats = array(measured.stats).map(object);
      if (
        declaredArms.length !== arms.length ||
        stats.length !== arms.length ||
        new Set(stats.map((a) => a.name)).size !== arms.length ||
        new Set(declaredArms.map((a) => a.name)).size !== arms.length
      )
        throw new Error(`${label}: incomplete/duplicate arms for ${entry.id}`);
      for (const name of arms) {
        const arm = declaredArms.find((a) => a.name === name),
          sample = stats.find((a) => a.name === name);
        if (arm?.status !== 'supported' || arm.preparedPolicy !== preparedPolicy(entry.id, name) || !sample)
          throw new Error(`${label}: missing/mislabeled arm ${entry.id}/${name}`);
        if (sample.n !== expectedSamples(entry.id, settings))
          throw new Error(`${label}: sample count mismatch ${entry.id}/${name}`);
        assertPgSamples(sample, expectedSamples(entry.id, settings), options);
      }
    }
    for (const key of ['driftHead', 'driftMid', 'driftTail'])
      if (typeof run[key] !== 'number' || !Number.isFinite(run[key]) || run[key] < 0)
        throw new Error(`${label}: missing drift probe`);
    assertPgProvenance(run, options);
    const comparable = {
      provenance: run.provenance,
      versions: run.versions,
      profile: run.profile,
      runtime: run.runtime,
      settings: run.settings,
      catalog: run.catalog,
    };
    if (baseline !== undefined) assert.deepStrictEqual(comparable, baseline, `${label} campaign profile`);
    baseline = comparable;
  }
  return EXTENDED_SEMANTICS;
}
