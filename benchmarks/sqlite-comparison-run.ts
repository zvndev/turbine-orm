/** Bounded original-harness runner using the established native evidence supervisor. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { comparisonRoot, sha256 } from './sqlite-comparison-identity.js';

const helper = new URL('./evidence/native-gate-child.mjs', import.meta.url);
const { execute, liveGroup } = await import(helper.href);
const args = process.argv.slice(2);
const allowed = new Set(['--artifact', '--sha256', '--output', '--time', '--quick', '--full']);
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  assert.ok(allowed.has(arg), `Unknown SQLite runner option ${arg}`);
  assert.equal(args.filter((a) => a === arg).length, 1, `Duplicate ${arg}`);
  if (['--artifact', '--sha256', '--output'].includes(arg))
    assert.ok(args[++i] && !args[i]!.startsWith('--'), `${arg} requires a value`);
}
const value = (name: string) => args[args.indexOf(name) + 1]!;
for (const name of ['--artifact', '--sha256', '--output']) assert.ok(args.includes(name), `${name} required`);
assert.equal(process.version, 'v24.10.0', 'Exact Node v24.10.0 required');
assert.ok(!(args.includes('--quick') && args.includes('--full')), 'Choose --quick or --full');
const timing = args.includes('--time');
assert.ok(!timing || process.env.SQLITE_COMPARISON_SERIALIZED === '1', 'Timing requires serial execution');
const artifact = resolve(value('--artifact')),
  expected = value('--sha256');
assert.match(expected, /^[a-f0-9]{64}$/i);
assert.equal(sha256(artifact), expected.toLowerCase(), 'SQLite artifact SHA256 mismatch');
const directory = resolve(value('--output'));
assert.ok(!existsSync(directory), 'Use a fresh SQLite output directory');
mkdirSync(directory, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), 'turbine-sqlite-owned-'));
const commands: Record<string, unknown>[] = [];
const report: Record<string, unknown> = {
  schemaVersion: 1,
  mode: timing ? 'timing' : 'correctness-only',
  comparativeClaim: false,
  artifact,
  sha256: expected.toLowerCase(),
  node: process.version,
  executable: process.execPath,
  executableSha256: sha256(process.execPath),
  worktree: comparisonRoot,
  helper: fileURLToPath(helper),
  helperSha256: sha256(fileURLToPath(helper)),
  commands,
  services: [],
  ports: [],
};
let failure: unknown;
try {
  const pending = execute(
    [
      '--import',
      join(comparisonRoot, 'benchmarks/node_modules/tsx/dist/loader.mjs'),
      join(comparisonRoot, 'benchmarks/bench-sqlite.ts'),
      timing ? '--time' : '--verify-only',
      args.includes('--quick') ? '--quick' : '--full',
      '--artifact',
      artifact,
      '--sha256',
      expected,
      '--report',
      join(directory, 'comparison.json'),
    ],
    {
      ...process.env,
      TMPDIR: scratch,
      NODE_OPTIONS: '',
      BENCH_RETAIN_SAMPLES: timing ? '1' : process.env.BENCH_RETAIN_SAMPLES,
    },
    join(directory, 'stdout.log'),
    join(directory, 'stderr.log'),
    commands,
    { timeoutMs: timing ? 1200000 : 120000, graceMs: 5000 },
  );
  const childPid = commands[0]?.processGroup;
  if (typeof childPid === 'number') {
    try {
      commands[0]!.linuxProcessStat = readFileSync(`/proc/${childPid}/stat`, 'utf8');
    } catch {
      /* child already exited */
    }
  }
  console.log(JSON.stringify({ event: 'sqlite-owned-child-started', pid: childPid, scratch }));
  await pending;
  report.status = 'passed';
} catch (error) {
  failure = error;
  report.status = 'failed';
  report.error = String(error);
} finally {
  // Independently audit only our process groups and paths, never signal an unknown PID.
  const remaining = commands.flatMap((c) => (typeof c.processGroup === 'number' ? liveGroup(c.processGroup) : []));
  const pathUsers: { pid: number; path: string; stat: string }[] = [];
  for (const name of readdirSync('/proc').filter((s) => /^\d+$/.test(s))) {
    try {
      for (const fd of readdirSync(`/proc/${name}/fd`)) {
        let target: string;
        try {
          target = readlinkSync(`/proc/${name}/fd/${fd}`);
        } catch {
          continue;
        }
        if (target.startsWith(`${scratch}/`))
          pathUsers.push({ pid: Number(name), path: target, stat: readFileSync(`/proc/${name}/stat`, 'utf8') });
      }
    } catch (error) {
      if (!['ENOENT', 'ESRCH', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  report.cleanup = { remainingOwnedWorkers: remaining, scratchPathUsers: pathUsers, scratch };
  if (!remaining.length && !pathUsers.length) rmSync(scratch, { recursive: true, force: true });
  Object.assign(report.cleanup as object, { removed: !existsSync(scratch) });
  if (remaining.length || pathUsers.length) {
    failure ??= new Error('Owned SQLite process/path cleanup failed');
    report.status = 'failed';
  }
  writeFileSync(join(directory, 'runner.json'), `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify({ status: report.status, directory, mode: report.mode }));
if (failure) throw failure;
