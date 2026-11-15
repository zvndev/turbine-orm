/** Bounded omission controls for the original SQLite catalog, never a timing run. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const directory = process.argv[2] ? resolve(process.argv[2]) : mkdtempSync(join(tmpdir(), 'turbine-sqlite-comparison-controls-'));
const { execute, liveGroup } = await import(new URL('./evidence/native-gate-child.mjs', import.meta.url).href);
const forwarded = process.argv.slice(3);
assert.ok(
  forwarded.length === 0 || (forwarded.length === 4 && forwarded[0] === '--artifact' && forwarded[2] === '--sha256'),
  'usage: sqlite-comparison-controls.ts NEW_DIRECTORY [--artifact PATH --sha256 HEX]',
);
if (forwarded.length) forwarded[1] = resolve(forwarded[1]!);
mkdirSync(directory, { recursive: true });
if (process.version !== 'v24.10.0') throw new Error('Exact Node 24.10 is required for native omission controls');
const controls: Record<string, string> = {
  none: '',
  catalog: 'SQLite catalog incomplete',
  arm: 'required arm catalog',
  value: 'exact result mismatch',
  order: 'exact result mismatch',
  type: 'exact result mismatch',
  stream: 'complete ordered stream',
  'stream-order': 'complete ordered stream',
  'write-effect': 'independent storage effect',
  restore: 'scratch restoration',
  transaction: 'Native dashboard transaction scope mismatch',
  coverage: 'SQLite supported catalog/preflight coverage',
  'hot-input': 'exact result mismatch',
};
const results = [];
for (const [fault, expected] of Object.entries(controls)) {
  const report = resolve(directory, `${fault}.json`);
  // Remove stale output before each child; the fresh report includes this child's PID.
  if (existsSync(report)) throw new Error(`Refusing to reuse control report ${report}`);
  const args = [
    '--import',
    './benchmarks/node_modules/tsx/dist/loader.mjs',
    'benchmarks/bench-sqlite.ts',
    '--verify-only',
    '--report',
    report,
    ...forwarded,
  ];
  const scratch = mkdtempSync(join(tmpdir(), 'sqlite-omission-control-'));
  const commands: {
    processGroup: number;
    exitCode: number;
    signal: string | null;
    timedOut: boolean;
    interrupted?: boolean;
    workersStopped: boolean;
  }[] = [];
  try {
    try {
      await execute(
        args,
        { ...process.env, TMPDIR: scratch, SQLITE_COMPARISON_FAULT: fault },
        resolve(directory, `${fault}.log`),
        resolve(directory, `${fault}.stderr.log`),
        commands,
      );
    } catch (error) {
      if (fault === 'none' || commands[0]?.exitCode !== 1) throw error;
    }
  } finally {
    const remaining = commands.flatMap((c) => liveGroup(c.processGroup));
    assert.deepEqual(remaining, [], `${fault}: independent owned process group audit`);
    rmSync(scratch, { recursive: true, force: true });
  }
  const child = commands[0]!;
  assert.ok(child.workersStopped && !child.timedOut && !child.interrupted, `${fault}: supervision`);
  assert.equal(child.signal, null, `${fault}: child signal`);
  const data = JSON.parse(readFileSync(report, 'utf8'));
  assert.equal(data.identity.pid, child.processGroup, `${fault}: fresh child identity`);
  assert.equal(data.fault, fault);
  assert.equal(data.mode, 'correctness-only');
  assert.equal(data.results.length, 0);
  assert.equal(data.cleanup.removed, true);
  assert.equal(existsSync(data.cleanup.directory), false);
  assert.deepEqual(data.cleanup.errors, []);
  assert.ok(data.cleanup.handles.length >= 5, `${fault}: observed handles must be nonempty`);
  assert.ok(
    data.cleanup.handles.every(
      (h: { closed: boolean; nativeClosed: boolean; transactionAtClose: boolean }) =>
        h.closed && h.nativeClosed && !h.transactionAtClose,
    ),
    `${fault}: native closure`,
  );
  if (fault === 'none') {
    assert.equal(child.exitCode, 0);
    assert.equal(data.status, 'passed');
    assert.equal(data.preflight.length, 317);
    assert.equal(data.coverage.scenarios, 63);
    assert.equal(data.coverage.supportedCells, 317);
    assert.equal(data.coverage.refused.length, 2);
    assert.equal(data.coverage.notApplicable.length, 19);
    for (const row of data.preflight.filter((r: { id: string }) => r.id === 'headline-10'))
      assert.deepEqual(
        row.inputs,
        Array.from({ length: 50 }, (_, i) => i),
      );
    assert.equal(data.transactions.length, 10);
    assert.deepEqual(data.sampleSettings, { quick: false, rounds: 200, warmup: 20, streamRounds: 15, coldRounds: 100 });
  } else {
    assert.equal(child.exitCode, 1, `${fault}: expected failure`);
    assert.equal(data.status, 'failed');
    assert.ok(data.error.message.includes(expected), `${fault}: wrong failure ${data.error.message}`);
  }
  results.push({
    fault,
    status: 'passed',
    pid: child.processGroup,
    exit: child.exitCode,
    supervision: child,
    expected,
    report,
    handles: data.cleanup.handles.length,
  });
  console.log(`${fault}: passed (${fault === 'none' ? 'positive prerequisite' : 'intended failure rejected'})`);
}
writeFileSync(resolve(directory, 'controls.json'), `${JSON.stringify({ status: 'passed', node: process.version, results }, null, 2)}\n`, {
  mode: 0o600,
});
