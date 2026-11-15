import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { admittedCatalog } from './catalog.mjs';
import { here, json, sha256, treeDigest } from './verify-pins.mjs';

export function validateReport(report) {
  assert.ok(['preflight', 'timing'].includes(report.mode), 'Unknown execution report mode');
  assert.equal(report.appendix, 'prisma8-postgres-candidate');
  assert.equal(report.status, 'passed', 'Native correctness report must pass');
  assert.equal(report.success, true);
  assert.equal(report.runtime.version, 'v26.12.0');
  assert.equal(report.profile.driver, 'pg@8.22.0');
  assert.equal(report.preflight.status, 'passed');
  assert.ok(report.cases.length >= 151, 'Missing candidate correctness cases');
  assert.equal(report.preflight.cases, report.cases.length);
  assert.deepEqual(report.cleanupErrors, []);
  assert.equal(report.settings.fault, null, 'Fault runs cannot become accepted benchmark evidence');
  assert.equal(report.controls.length, 8, 'Exactly eight native controls required');
  assert.equal(report.preflight.controls, report.controls.length);
  validateCatalog(report);
  validateEvidence(report);
  for (const id of [
    'cursor-first-row-early-return',
    'cursor-break',
    'cursor-cancel-after-first-row',
    'cursor-pre-abort',
    'transaction-rollback-independent-connection',
    'transaction-commit-independent-connection',
    'invalid-batch-size',
    'caller-pool-ownership-and-closed-client-refusal',
  ]) {
    assert.equal(
      report.controls.filter((item) => item.id === id && item.status === 'passed').length,
      1,
      `Missing native control: ${id}`,
    );
  }
  assert.equal(report.services.length, 1, 'Exactly one private PostgreSQL service required');
  const service = report.services[0];
  assert.equal(service.server_version, '18.6');
  assert.equal(service.max_connections, 32);
  assert.equal(service.startup, 'ready');
  for (const key of [
    'stopped',
    'connectionsClosed',
    'auditComplete',
    'portReleased',
    'datadirRemoved',
    'socketRemoved',
  ])
    assert.equal(service[key], true, `Service cleanup incomplete: ${key}`);
  assert.deepEqual(service.remainingPids, []);
  assert.deepEqual(service.remainingGroups, []);
  assert.equal(service.ownershipProof.passed, true);
  assert.equal(service.ownershipProof.complete, true);
  validateUnavailableMetrics(report);
  assert.equal(report.metrics.p99, null);
  assert.equal(report.metrics.ranking, null);
  if (report.mode === 'preflight') {
    assert.equal(report.results, null);
    assert.equal(report.metrics.status, 'unavailable');
    assert.equal(report.settings.rounds, null);
    assert.equal(report.settings.warmup, null);
  } else {
    const turbine = report.comparatorInputs?.find((arm) => arm.name === 'Turbine');
    assert.ok(turbine && report.artifact, 'Timing requires the pinned Turbine artifact and comparator');
    assert.equal(turbine.artifact.sha256, report.artifact.sha256);
    assert.equal(turbine.sourceCommit, report.artifact.sourceCommit);
    assert.equal(turbine.version, report.artifact.manifest.version);
    validateTiming(report);
  }
  return { status: 'passed', mode: report.mode, cases: report.cases.length, controls: report.controls.length };
}
export function validateUnavailableMetrics(report) {
  for (const key of ['p99', 'ranking', 'firstRowLatency', 'peakMemory'])
    assert.equal(report.metrics[key], null, `Unmeasured ${key} must stay unavailable`);
}
export function validateCatalog(report) {
  const expected = admittedCatalog(report.comparatorInputs);
  assert.deepEqual(
    report.catalog.map((row) => row.id),
    expected.map((row) => row.id),
    'Canonical catalog rows changed',
  );
  const expectedCases = new Set();
  for (let n = 0; n < expected.length; n++) {
    const row = report.catalog[n],
      source = expected[n];
    const { arms, ...identity } = row;
    const { arms: sourceArms, ...sourceIdentity } = source;
    assert.deepEqual(identity, sourceIdentity, 'Canonical scenario identity changed');
    assert.deepEqual(Object.keys(arms).sort(), Object.keys(sourceArms).sort(), 'Canonical arm map changed');
    for (const [name, cell] of Object.entries(arms)) {
      const { preflight, ...declaration } = cell;
      assert.deepEqual(declaration, sourceArms[name], `Canonical cell changed: ${row.id}/${name}`);
      if (cell.status === 'implemented') {
        const count = row.index === 10 ? 50 : 1;
        assert.deepEqual(preflight, { status: 'passed', cases: count });
        for (let i = 0; i < count; i++) expectedCases.add(JSON.stringify([row.id, name, i]));
      } else assert.equal(preflight, undefined);
    }
  }
  assert.equal(report.cases.length, expectedCases.size, 'Missing or orphan native correctness case');
  for (const item of report.cases) {
    assert.equal(item.status, 'passed');
    assert.ok(
      expectedCases.delete(JSON.stringify([item.id, item.arm, item.i])),
      'Orphan or duplicated native correctness case',
    );
  }
  assert.equal(expectedCases.size, 0);
  return expected;
}
export function validateEvidence(report) {
  const pins = json(join(here, 'identity.json'));
  assert.equal(report.formatVersion, 1);
  assert.deepEqual(report.identity, pins, 'Candidate identity changed');
  for (const key of ['version', 'sha256', 'platform', 'arch'])
    assert.equal(report.runtime[key], pins.runtime[key], `Runtime ${key} mismatch`);
  assert.ok(typeof report.runtime.executable === 'string' && report.runtime.executable.length > 0);
  assert.equal(report.source?.base, pins.canonicalBase);
  assert.match(report.source?.head ?? '', /^[a-f0-9]{40}$/);
  assert.equal(typeof report.source.gitStatus, 'string');
  if (report.mode === 'timing') {
    assert.equal(report.source.gitStatus, '', 'Timing requires a clean producer source');
    execFileSync('git', ['diff', '--exit-code', report.source.head, '--', 'src', 'scripts', 'fixture', 'canonical'], {
      cwd: here,
    });
    assert.equal(
      execFileSync(
        'git',
        ['ls-files', '--others', '--exclude-standard', '--', 'src', 'scripts', 'fixture', 'canonical'],
        { cwd: here, encoding: 'utf8' },
      ).trim(),
      '',
      'Timing source contains uncommitted files',
    );
  }
  for (const dir of ['src', 'scripts', 'fixture', 'canonical'])
    assert.equal(report.source.candidateSha256?.[dir], treeDigest(join(here, dir)), `Candidate source changed: ${dir}`);
  const build = report.source.build;
  assert.equal(build?.compiler, '5.9.3');
  for (const dir of ['src', 'fixture', 'canonical']) {
    assert.equal(build.source?.[dir], treeDigest(join(here, dir)), `Build source changed: ${dir}`);
    assert.equal(build.emitted?.[dir], treeDigest(join(here, 'dist', dir)), `Build payload changed: ${dir}`);
  }
  assert.ok(
    Array.isArray(report.commands) && report.commands.length === 2,
    'Native initdb and seed command evidence required',
  );
  assert.ok(report.commands[0].binary.endsWith('/bin/initdb'));
  assert.equal(report.commands[1].binary, report.runtime.executable);
  assert.ok(report.commands[1].args.some((arg) => arg.endsWith('/dist/canonical/seed-neon.js')));
  for (const command of report.commands) {
    assert.equal(command.code, 0);
    assert.equal(command.signal, null);
    assert.equal(command.reaped, true);
    assert.equal(command.ownershipProof?.passed, true);
    assert.equal(command.ownershipProof?.complete, true);
    assert.deepEqual(command.remainingPids, []);
    assert.deepEqual(command.remainingGroups, []);
  }
  for (const pin of report.comparatorInputs ?? [])
    for (const key of ['artifact', 'module'])
      assert.equal(sha256(readFileSync(resolve(pin[key].path))), pin[key].sha256, `Comparator ${key} changed`);
  assert.deepEqual(report.fixture?.counts, {
    organizations: 5,
    users: 1000,
    posts: 10000,
    comments: 50000,
    tags: 50,
    post_tags: 30000,
    bench_wide: 2000,
  });
  assert.match(report.fixture?.sha256 ?? '', /^[a-f0-9]{64}$/);
  assert.equal(report.fixtureChecks?.preflight, 'passed');
  assert.equal(report.fixtureChecks?.controls, 'passed');
  if (report.mode === 'timing') assert.equal(report.fixtureChecks?.timing, 'passed');
  validateStreamEvidence(report);
}
export function validateStreamEvidence(report) {
  assert.equal(report.fixture.stream.count, 50000);
  assert.match(report.fixture.stream.sha256, /^[a-f0-9]{64}$/);
  for (const item of report.cases.filter((item) => item.id === 'headline-6')) {
    assert.deepEqual(item.receipt, report.fixture.stream, 'Stream receipt mismatch');
    const cursor = item.arm.includes('cursor batch1000');
    assert.equal(item.route, cursor ? 'cursor' : 'buffered');
    if (cursor || item.arm === 'Prisma 8 buffered') {
      const proof = item.routeProof;
      assert.ok(Array.isArray(proof?.namedPortals) && Array.isArray(proof.executeRows), 'Missing native route proof');
      if (cursor) {
        assert.ok(
          proof.namedPortals.length > 0 &&
            proof.namedPortals.every((portal) => typeof portal === 'string' && portal.length),
        );
        assert.ok(proof.binds >= 1 && proof.closes >= 1);
        assert.ok(proof.executeRows.every((size) => size === 0 || size === 1000));
        assert.ok(proof.executeRows.filter((size) => size === 1000).length >= 50, 'Missing native cursor fetches');
      } else
        assert.ok(
          proof.executeRows.every((size) => size === 0),
          'Buffered route used cursor batching',
        );
    } else assert.equal(item.routeProof, null);
  }
}
export function validateTiming(report) {
  const { rounds, warmup } = report.settings;
  assert.ok(Number.isSafeInteger(rounds) && rounds >= 10, 'Timing requires at least ten measured rounds');
  assert.ok(Number.isSafeInteger(warmup) && warmup >= 0, 'Invalid timing warmup count');
  assert.equal(report.metrics.status, 'measured-separate-appendix');
  const rows = report.catalog.filter((row) => Object.values(row.arms).some((cell) => cell.status === 'implemented'));
  assert.ok(Array.isArray(report.results), 'Missing timing results');
  assert.deepEqual(
    report.results.map((row) => row.id),
    rows.map((row) => row.id),
    'Missing, duplicated or reordered timing scenario',
  );
  const expectedChecks = new Set();
  for (let n = 0; n < rows.length; n++) {
    const row = rows[n],
      result = report.results[n];
    const names = Object.keys(row.arms).filter((name) => row.arms[name].status === 'implemented');
    assert.equal(result.scenario, row.scenario, 'Timing scenario identity changed');
    assert.deepEqual(Object.keys(result.arms).sort(), [...names].sort(), 'Missing or invented timing arm');
    for (const name of names) {
      const actual = result.arms[name];
      assert.equal(actual.unit, 'ms');
      assert.equal(actual.n, rounds, 'Incomplete timing sample count');
      assert.ok(Array.isArray(actual.samples) && actual.samples.length === rounds, 'Incomplete timing samples');
      assert.ok(
        actual.samples.every((value) => Number.isFinite(value) && value >= 0),
        'Invalid timing sample',
      );
      const sorted = [...actual.samples].sort((a, b) => a - b);
      const stats = {
        min: sorted[0],
        median: rounds % 2 ? sorted[(rounds - 1) / 2] : (sorted[rounds / 2 - 1] + sorted[rounds / 2]) / 2,
        mean: sorted.reduce((a, b) => a + b, 0) / rounds,
        p95: sorted[Math.ceil(rounds * 0.95) - 1],
      };
      for (const [key, value] of Object.entries(stats))
        assert.equal(actual[key], value, `Timing ${key} disagrees with retained samples`);
      for (const key of ['p99', 'firstRow', 'peakMemory'])
        assert.equal(actual[key], null, `Unmeasured ${key} must stay unavailable`);
      for (const [phase, count] of [
        ['warmup', warmup],
        ['round', rounds],
      ])
        for (let i = 0; i < count; i++) expectedChecks.add(JSON.stringify([row.id, name, phase, i]));
    }
  }
  assert.ok(Array.isArray(report.executionChecks), 'Missing execution correctness receipts');
  assert.equal(report.executionChecks.length, expectedChecks.size, 'Missing or duplicated execution receipt');
  for (const check of report.executionChecks) {
    assert.equal(check.status, 'passed');
    const key = JSON.stringify([check.id, check.arm, check.phase, check.i]);
    assert.ok(expectedChecks.delete(key), 'Unknown or duplicated execution receipt');
  }
  assert.equal(expectedChecks.size, 0, 'Missing execution correctness receipt');
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  assert.ok(process.argv[2], 'Usage: node scripts/validate-report.mjs /absolute/report.json');
  console.log(JSON.stringify(validateReport(json(resolve(process.argv[2])))));
}
