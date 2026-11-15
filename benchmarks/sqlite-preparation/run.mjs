import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { controls } from './controls.mjs';
import { memory } from './memory.mjs';
import { validate } from './validate.mjs';
import { ARMS, CAPACITY, CASES, execute, route } from './workload.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
function files(dir) {
  return readdirSync(resolve(root, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`],
  );
}
const git = (...args) => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const environment = () => ({
  loadavg: os.loadavg(),
  freeMemory: os.freemem(),
  cpuTimes: os.cpus().map(({ times }) => times),
});
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    rounds: { type: 'string', default: '9' },
    iterations: { type: 'string', default: '1500' },
    'memory-arm': { type: 'string' },
  },
});
if (values['memory-arm']) {
  process.stdout.write(`${JSON.stringify(await memory(values['memory-arm']))}\n`);
} else {
  assert.ok(
    ['v22.16.0', 'v24.10.0'].includes(process.version),
    `exact Node22.16.0/24.10.0 required, got ${process.version}`,
  );
  assert.equal(typeof global.gc, 'function', 'run with --expose-gc');
  assert.ok(values.out, '--out is required');
  const rounds = Number(values.rounds);
  const iterations = Number(values.iterations);
  assert.ok(Number.isSafeInteger(rounds) && rounds >= 4 && rounds <= 100);
  assert.ok(Number.isSafeInteger(iterations) && iterations >= 128 && iterations <= 100000);
  const probe = new DatabaseSync(':memory:');
  let sqlite;
  try {
    sqlite = probe.prepare('SELECT sqlite_version() AS version, sqlite_source_id() AS source').get();
  } finally {
    probe.close();
  }
  const sourceFiles = [...files('src'), ...files('benchmarks/sqlite-preparation')]
    .filter((file) => !file.endsWith('.json') && !file.endsWith('.md'))
    .sort();
  const report = {
    format: 'sqlite-preparation-v1',
    startedAt: new Date().toISOString(),
    runtime: {
      node: process.version,
      executable: process.execPath,
      binarySha256: hash(process.execPath),
      sqlite,
      platform: process.platform,
      arch: process.arch,
    },
    source: {
      head: git('rev-parse', 'HEAD'),
      branch: git('branch', '--show-current'),
      worktree: root,
      status: git('status', '--short'),
      files: Object.fromEntries(sourceFiles.map((file) => [file, hash(resolve(root, file))])),
    },
    dependencies: {
      lockSha256: hash(resolve(root, 'package-lock.json')),
      tsx: JSON.parse(readFileSync(resolve(root, 'node_modules/tsx/package.json'), 'utf8')).version,
    },
    host: { cpu: os.cpus()[0]?.model, cpuCount: os.cpus().length, release: os.release(), totalMemory: os.totalmem() },
    config: {
      rounds,
      iterations,
      capacity: CAPACITY,
      cacheScope: 'one native handle, ordinary queries only',
      coldMeaning: 'first statement on initialized in-memory fixture; not disk/OS cache cold',
      warmupIterations: 128,
    },
    before: environment(),
    controls: await controls(),
    samples: [],
    memory: [],
    comparisons: [],
    conclusion:
      'Exploratory shared-host evidence only. No performance ranking, threshold or production optimization is justified by this report alone.',
  };
  for (const name of CASES) {
    for (let round = 0; round < rounds; round++) {
      const base = round % 2 ? [...ARMS].reverse() : ARMS;
      const shift = round % ARMS.length;
      const order = [...base.slice(shift), ...base.slice(0, shift)];
      for (const arm of order) {
        for (const phase of ['cold', 'warm']) {
          const r = route(arm, name === 'decode-wide');
          try {
            if (phase === 'warm') {
              await execute(r, name, 128);
              r.db.exec('UPDATE counters SET n=0 WHERE id=1');
            }
            const result = await execute(r, name, phase === 'cold' ? 1 : iterations);
            report.samples.push({ name, round, order, arm, phase, ...result });
          } finally {
            await r.close();
          }
          global.gc();
        }
      }
    }
    process.stderr.write(`verified ${name}\n`);
  }
  for (const arm of ARMS) {
    const child = spawnSync(
      process.execPath,
      [...process.execArgv, fileURLToPath(import.meta.url), '--memory-arm', arm],
      { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 },
    );
    assert.equal(child.status, 0, child.stderr);
    report.memory.push(JSON.parse(child.stdout));
  }
  for (const name of CASES) {
    for (const family of ['native', 'pool']) {
      const series = (suffix) =>
        report.samples
          .filter((s) => s.name === name && s.phase === 'warm' && s.arm === `${family}-${suffix}`)
          .sort((a, b) => a.round - b.round);
      const fresh = series('fresh');
      const control = series('control');
      const reuse = series('reuse');
      const delta = reuse.map((s, i) => fresh[i].ms - s.ms);
      const noise = control.map((s, i) => fresh[i].ms - s.ms);
      report.comparisons.push({
        name,
        family,
        freshMedianMs: median(fresh.map((s) => s.ms)),
        reuseMedianMs: median(reuse.map((s) => s.ms)),
        pairedFreshMinusReuseMs: delta,
        identicalFreshMinusControlMs: noise,
        pairedMedianMs: median(delta),
        controlMedianMs: median(noise),
        deltaRangeMs: [Math.min(...delta), Math.max(...delta)],
        controlRangeMs: [Math.min(...noise), Math.max(...noise)],
        interpretation: 'descriptive only; correlated shared-host samples do not establish a speedup',
      });
    }
  }
  report.after = environment();
  report.finishedAt = new Date().toISOString();
  report.cleanup = {
    nativeHandlesClosed: true,
    memoryChildrenExited: true,
    servicesStarted: 0,
    fixtureFilesCreated: 0,
  };
  report.validation = validate(report);
  writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`);
  process.stderr.write(`wrote ${values.out}: ${report.samples.length} verified samples\n`);
}
