import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const cwd = process.cwd();
const output = resolve(process.argv[2] ?? '/tmp/turbine-live-query-controls');
mkdirSync(output, { recursive: true });
const root = mkdtempSync(join(output, 'fixture-'));
const report = { root, commands: [] };
const loader = join(cwd, 'node_modules/tsx/dist/loader.mjs');
function run(args, env = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env: { ...process.env, DATABASE_URL: '', TURBINE_REQUIRE_ENGINE: '', ...env },
    encoding: 'utf8',
    timeout: 20000,
  });
  report.commands.push({ args, pid: result.pid, status: result.status, stdout: result.stdout, stderr: result.stderr });
  return result;
}
try {
  const missing = run(['--import', loader, '--test', join(cwd, 'src/test/live-query-pg.test.ts')], {
    TURBINE_REQUIRE_ENGINE: 'postgres',
  });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stdout + missing.stderr, /precondition is unmet: DATABASE_URL not set/);
  mkdirSync(join(root, 'src/test'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  const source = readFileSync(join(cwd, 'src/live-query.ts'), 'utf8');
  const tests = readFileSync(join(cwd, 'src/test/live-query.test.ts'), 'utf8');
  writeFileSync(join(root, 'src/test/live-query.test.ts'), tests);
  writeFileSync(join(root, 'src/live-query.ts'), source);
  const clean = run(['--import', loader, '--test', 'src/test/live-query.test.ts']);
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  const mutations = [
    [
      'dirty snapshot refusal',
      'if (dirty) continue;',
      '/* deliberately deliver invalidated snapshot */',
      'discards the first racing',
    ],
    ['reconnect resync', 'onReconnect: invalidate,', 'onReconnect: () => {},', 'handles synchronous invalidation'],
  ];
  for (const [label, from, to, pattern] of mutations) {
    assert.equal(source.split(from).length, 2, `unique ${label} mutation anchor`);
    writeFileSync(join(root, 'src/live-query.ts'), source.replace(from, to));
    const broken = run(['--import', loader, '--test', '--test-name-pattern', pattern, 'src/test/live-query.test.ts']);
    assert.notEqual(broken.status, 0, `${label} omission must fail`);
    assert.match(broken.stdout + broken.stderr, /fail [1-9]|not ok|AssertionError|cancelled/);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
  report.removed = !existsSync(root);
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2));
}
