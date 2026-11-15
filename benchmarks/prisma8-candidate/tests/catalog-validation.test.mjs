import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { admittedCatalog } from '../scripts/catalog.mjs';
import {
  validateCatalog,
  validateEvidence,
  validateStreamEvidence,
  validateUnavailableMetrics,
} from '../scripts/validate-report.mjs';
import { here, json, treeDigest } from '../scripts/verify-pins.mjs';

function catalogReport(inputs) {
  const rows = admittedCatalog(inputs),
    cases = [];
  for (const row of rows)
    for (const [arm, cell] of Object.entries(row.arms))
      if (cell.status === 'implemented') {
        const count = row.index === 10 ? 50 : 1;
        cell.preflight = { status: 'passed', cases: count };
        for (let i = 0; i < count; i++) cases.push({ id: row.id, arm, i, status: 'passed' });
      }
  return { catalog: rows, cases, comparatorInputs: inputs };
}
test('source-owned catalog admits all 151 native cases', () => {
  const report = catalogReport();
  assert.equal(report.cases.length, 151);
  validateCatalog(report);
});
test('coordinated catalog deletions, renamed cells, orphan and duplicate cases are refused', () => {
  for (const change of [
    (r) => {
      delete r.catalog[3].arms['Prisma 8 buffered'];
    },
    (r) => {
      for (const row of r.catalog) row.arms = {};
    },
    (r) => {
      r.catalog[0].arms['Prisma 8 buffered'].status = 'refused';
    },
    (r) => {
      r.catalog[0].id = 'invented';
    },
    (r) => {
      r.cases[0].arm = 'invented';
    },
    (r) => {
      r.cases[1] = { ...r.cases[0] };
    },
    (r) => {
      r.catalog.pop();
    },
  ]) {
    const report = catalogReport();
    change(report);
    assert.throws(() => validateCatalog(report));
  }
});
test('optional catalog support comes only from a complete admitted comparator pin', () => {
  const pin = {
    name: 'Turbine',
    version: '0.93.1',
    sourceCommit: 'a'.repeat(40),
    driver: 'pg@8.22.0',
    implementationKind: 'typed-orm',
    artifact: { path: '/synthetic/archive', sha256: 'b'.repeat(64) },
    module: { path: '/synthetic/module', sha256: 'c'.repeat(64) },
    supported: ['headline-3'],
  };
  validateCatalog(catalogReport([pin]));
  for (const change of [
    (p) => {
      p.driver = 'pg@8.23.1';
    },
    (p) => {
      p.supported = ['headline-7'];
    },
    (p) => {
      delete p.module;
    },
  ]) {
    const broken = structuredClone(pin);
    change(broken);
    assert.throws(() => validateCatalog(catalogReport([broken])));
  }
});
function streamReport() {
  const receipt = { count: 50000, sha256: 'a'.repeat(64) };
  return {
    fixture: { stream: receipt },
    cases: [
      {
        id: 'headline-6',
        arm: 'Prisma 8 cursor batch1000',
        receipt: { ...receipt },
        route: 'cursor',
        routeProof: { namedPortals: ['portal'], binds: 1, closes: 1, executeRows: Array(51).fill(1000) },
      },
      {
        id: 'headline-6',
        arm: 'Prisma 8 buffered',
        receipt: { ...receipt },
        route: 'buffered',
        routeProof: { namedPortals: [], executeRows: [] },
      },
    ],
  };
}
test('native stream admission requires full digest, route, portal, fetches and closure', () => {
  validateStreamEvidence(streamReport());
  for (const change of [
    (r) => {
      r.cases[0].receipt.count = 1;
    },
    (r) => {
      r.cases[0].routeProof.namedPortals = [];
    },
    (r) => {
      r.cases[0].routeProof.executeRows = [];
    },
    (r) => {
      r.cases[0].route = 'buffered';
    },
    (r) => {
      r.cases[0].routeProof.closes = 0;
    },
    (r) => {
      r.cases[1].routeProof.executeRows = [1000];
    },
  ]) {
    const report = streamReport();
    change(report);
    assert.throws(() => validateStreamEvidence(report));
  }
});
function evidence() {
  const identity = json(join(here, 'identity.json'));
  // Synthetic schema unit control, never native runtime evidence.
  const command = {
    code: 0,
    signal: null,
    reaped: true,
    ownershipProof: { passed: true, complete: true },
    remainingPids: [],
    remainingGroups: [],
  };
  return {
    ...streamReport(),
    formatVersion: 1,
    mode: 'preflight',
    identity,
    runtime: { ...identity.runtime, executable: '/synthetic/node' },
    source: {
      base: identity.canonicalBase,
      head: 'a'.repeat(40),
      gitStatus: '',
      candidateSha256: Object.fromEntries(
        ['src', 'scripts', 'fixture', 'canonical'].map((d) => [d, treeDigest(join(here, d))]),
      ),
      build: json(join(here, 'dist/build.json')),
    },
    commands: [
      { ...command, binary: '/synthetic/bin/initdb' },
      { ...command, binary: '/synthetic/node', args: ['/synthetic/dist/canonical/seed-neon.js'] },
    ],
    fixture: {
      ...streamReport().fixture,
      counts: {
        organizations: 5,
        users: 1000,
        posts: 10000,
        comments: 50000,
        tags: 50,
        post_tags: 30000,
        bench_wide: 2000,
      },
      sha256: 'b'.repeat(64),
    },
    fixtureChecks: { preflight: 'passed', controls: 'passed' },
  };
}
test('provenance, runtime, build, command and fixture checks cannot be deleted', () => {
  validateEvidence(evidence());
  for (const change of [
    (r) => {
      r.source = {};
    },
    (r) => {
      r.identity = {};
    },
    (r) => {
      r.commands = [];
    },
    (r) => {
      r.runtime.sha256 = '0'.repeat(64);
    },
    (r) => {
      r.source.build = {};
    },
    (r) => {
      r.fixtureChecks = {};
    },
  ]) {
    const report = evidence();
    change(report);
    assert.throws(() => validateEvidence(report));
  }
});

test('unmeasured report-level latency, memory and ranking remain unavailable', () => {
  const metrics = { p99: null, ranking: null, firstRowLatency: null, peakMemory: null };
  validateUnavailableMetrics({ metrics });
  for (const key of Object.keys(metrics))
    assert.throws(() => validateUnavailableMetrics({ metrics: { ...metrics, [key]: 1 } }));
});
