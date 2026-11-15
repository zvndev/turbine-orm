/** Synthetic report fixture for admission tests only; never performance evidence. */
import {
  extendedGroups,
  fixtureCounts,
  extendedCatalog,
  requiredArms,
  preparedPolicy,
  EXTENDED_BOUNDARIES,
  extendedUnsupported,
} from './extended-equivalence.js';

export function syntheticRun(quick = false) {
  return {
    extendedSemantics: 'extended-exact-ordered-v1',
    unsupportedSemantics: EXTENDED_BOUNDARIES,
    status: 'passed',
    mode: quick ? 'bounded-smoke' : 'full',
    groups: [...extendedGroups],
    settings: { rounds: 1, warmup: 0, coldRounds: 1, quick },
    versions: {
      pg: '8.23.1',
      drizzleStable: '0.45.4',
      drizzleRc: '1.0.0-rc.5',
      prisma: '7.10.1',
      prismaAdapter: '7.10.1',
      turbine: 'synthetic',
    },
    runtime: { node: 'synthetic', executable: '/synthetic/node' },
    profile: {
      driver: 'pg8.23.1',
      turbine: 'supplied-pool',
      poolMax: 10,
      coldPoolMax: 10,
      drizzleRc: 'jit=true',
      jsonEncoding: 'positional',
      prepared: {
        preparedStatements: true,
        poolIdentity: true,
        nativeNamedVerified: true,
        nativeForceCustomPlanUnnamedVerified: true,
        descriptorName: 'synthetic',
      },
    },
    preflight: {
      status: 'passed',
      scenarios: 17,
      cases: 113,
      groups: [...extendedGroups],
      fixtureCounts: { ...fixtureCounts },
    },
    cleanup: {
      status: 'passed',
      clientsDisconnected: true,
      borrowedPoolsEnded: true,
      scratchAndSequenceRestored: true,
    },
    catalog: extendedCatalog.map((s) => ({
      ...s,
      selected: true,
      ...(s.id === 'strategy-many' ? { unsupported: extendedUnsupported } : {}),
      arms: requiredArms(s.id).map((name) => ({
        name,
        status: 'supported',
        preparedPolicy: preparedPolicy(s.id, name),
      })),
    })),
    results: extendedCatalog.map((s) => ({
      scenario: s.scenario,
      stats: requiredArms(s.id).map((name) => ({
        name,
        median: 1,
        avg: 1,
        min: 1,
        p95: 1,
        n: quick ? 1 : s.id === 'comments-50000' ? 10 : s.id === 'wide-1000' ? 20 : s.id === 'create-many' ? 15 : 1,
      })),
    })),
    driftHead: 1,
    driftMid: 1,
    driftTail: 1,
  };
}
