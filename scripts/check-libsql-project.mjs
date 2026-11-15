#!/usr/bin/env node
/** Installed local native project + seed admission. Never builds/re-packs its input. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deployOmission, deployWorkflow } from '../src/test/fixtures/libsql-native-deploy-workflow.mjs';
import { preservation } from '../src/test/fixtures/libsql-project-workflow/preservation.mjs';
import { workflow } from '../src/test/fixtures/libsql-project-workflow/workflow.mjs';
import { identity, sameProcess } from '../src/test/fixtures/neon-http/native-lifecycle.mjs';
import { lifecycle } from '../tooling/optional-pg-transports/lifecycle.mjs';

const [input, ...flags] = process.argv.slice(2);
assert.ok(input, 'Usage: node scripts/check-libsql-project.mjs <tested-tarball> --sha256 <pin> [--report <file>]');
const options = {};
for (let i = 0; i < flags.length; i += 2) {
  assert.ok(['--sha256', '--report'].includes(flags[i]), `Unknown option ${flags[i]}`);
  assert.ok(flags[i + 1], `Missing value for ${flags[i]}`);
  assert.equal(options[flags[i]], undefined, 'Duplicate option');
  options[flags[i]] = flags[i + 1];
}
const archive = resolve(input);
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
assert.match(options['--sha256'] ?? '', /^[a-f0-9]{64}$/, 'Exact tested archive SHA256 required');
assert.equal(hash(archive), options['--sha256'], 'Archive pin mismatch');
const scratch = resolve(process.env.TURBINE_LIBSQL_PROJECT_SCRATCH ?? join(homedir(), '.cache'));
mkdirSync(scratch, { recursive: true });
const root = mkdtempSync(join(scratch, 'tlp-'));
writeFileSync(join(root, 'NO-GIT-FIXTURE'), 'Disposable installed-tarball local libSQL workflow; no source alias.\n');
const reportPath = resolve(options['--report'] ?? join(scratch, `${root.split('/').pop()}.json`));
const report = {
  node: process.version,
  executable: process.execPath,
  owner: identity(process.pid),
  root,
  archive,
  sha256: hash(archive),
  gateSources: Object.fromEntries(
    [
      new URL(import.meta.url),
      new URL('../src/test/fixtures/libsql-project-workflow/workflow.mjs', import.meta.url),
      new URL('../src/test/fixtures/libsql-native-deploy-workflow.mjs', import.meta.url),
      new URL('../src/test/fixtures/libsql-project-workflow/preservation.mjs', import.meta.url),
      new URL('../src/test/fixtures/libsql-project-workflow/seed-api.mjs', import.meta.url),
    ].map((url) => [fileURLToPath(url), hash(fileURLToPath(url))]),
  ),
  scope: 'installed local native libSQL only; no hosted provider or SQL Server verification',
  commands: [],
  passed: false,
  ports: [],
  started: new Date().toISOString(),
};
const owner = lifecycle(report);
const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
async function run(cwd, binary, args, expected = 0, env = {}) {
  owner.assertOpen();
  const record = { cwd, binary, args, expected, ports: [] };
  report.commands.push(record);
  const handle = owner.spawn(
    binary,
    args,
    {
      cwd,
      deadlineMs: 120_000,
      env: {
        ...process.env,
        DATABASE_URL: '',
        NODE_OPTIONS: '',
        NODE_V8_COVERAGE: '',
        NO_COLOR: '1',
        TMPDIR: root,
        PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
        ...env,
      },
    },
    record,
  );
  let output = '';
  handle.child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  handle.child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const abort = () => {
    void handle.stop().catch((error) => owner.fail(error));
  };
  owner.signal.addEventListener('abort', abort, { once: true });
  try {
    await handle.closed;
    await handle.stop();
  } finally {
    owner.signal.removeEventListener('abort', abort);
  }
  record.output = output;
  save();
  assert.equal(record.code, expected, `${binary} ${args.join(' ')}\n${output}`);
  return output;
}
function files(path, prefix = '') {
  return readdirSync(path, { withFileTypes: true }).flatMap((item) =>
    item.isDirectory() ? files(join(path, item.name), `${prefix}${item.name}/`) : [`${prefix}${item.name}`],
  );
}
try {
  save();
  const consumer = join(root, 'consumer');
  mkdirSync(consumer);
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await run(consumer, 'npm', [
    'install',
    '--ignore-scripts',
    '--omit=optional',
    '--no-audit',
    '--no-fund',
    archive,
    'typescript@6.0.3',
    '@types/node@22.20.4',
  ]);
  const pkg = join(consumer, 'node_modules/turbine-orm');
  const manifest = JSON.parse(readFileSync(join(pkg, 'package.json')));
  assert.deepEqual(Object.keys(manifest.dependencies), ['pg'], 'pg remains the sole mandatory dependency');
  assert.ok(manifest.exports['./libsql/seed'], 'Seed export must be integrated in the archive');
  assert.equal(existsSync(join(consumer, 'node_modules/@types/pg')), false);
  const unpack = join(root, 'archive');
  mkdirSync(unpack);
  await run(root, 'tar', ['-xzf', archive, '-C', unpack]);
  const dist = files(join(unpack, 'package/dist')).sort();
  assert.deepEqual(files(join(pkg, 'dist')).sort(), dist);
  report.installedDistSha256 = Object.fromEntries(
    dist.map((file) => {
      const expected = hash(join(unpack, 'package/dist', file));
      assert.equal(hash(join(pkg, 'dist', file)), expected, `Installed payload ${file}`);
      return [file, expected];
    }),
  );
  const bins = [join(consumer, 'node_modules/.bin/turbine'), join(pkg, 'dist/cjs/cli/index.js')];
  const omission = async (label) => {
    for (const [index, bin] of bins.entries()) {
      const dir = join(consumer, `${label}-${index}`);
      mkdirSync(dir);
      const output = await run(
        dir,
        process.execPath,
        [bin, 'init', '--engine', 'libsql', '--url', 'file:./absent.sqlite', '--yes'],
        1,
      );
      assert.match(output, /optional @libsql\/client|native engine/);
      assert.deepEqual(readdirSync(dir), [], 'Native prerequisite refusal must precede scaffolding');
      writeFileSync(
        join(dir, 'turbine.config.mjs'),
        "export default {engine:'libsql',url:'file:./app.sqlite',seedFile:'./seed.mjs'};",
      );
      writeFileSync(join(dir, 'app.sqlite'), '');
      writeFileSync(
        join(dir, 'seed.mjs'),
        "import {writeFileSync} from 'node:fs';writeFileSync('import-effect','bad');export default async()=>{};",
      );
      const before = hash(join(dir, 'app.sqlite'));
      assert.match(await run(dir, process.execPath, [bin, 'seed'], 1), /optional @libsql\/client|native engine/);
      assert.equal(existsSync(join(dir, 'import-effect')), false);
      assert.equal(hash(join(dir, 'app.sqlite')), before);
    }
    await deployOmission({ consumer, bins, run, report, label });
  };
  await omission('missing-peer');
  await run(consumer, 'npm', [
    'install',
    '--ignore-scripts',
    '--include=optional',
    '--no-audit',
    '--no-fund',
    '@libsql/client@0.18.0',
  ]);
  // Isolate the native-engine control without touching repository dependencies.
  const native = readdirSync(join(consumer, 'node_modules/@libsql')).filter((name) =>
    /^(linux|darwin|win32)-/.test(name),
  );
  assert.ok(native.length, 'Actual native platform package required');
  const { renameSync } = await import('node:fs');
  for (const name of native) renameSync(join(consumer, 'node_modules/@libsql', name), join(root, name));
  try {
    await omission('missing-native');
  } finally {
    for (const name of native) renameSync(join(root, name), join(consumer, 'node_modules/@libsql', name));
  }
  const pg = join(consumer, 'node_modules/pg');
  renameSync(pg, join(root, 'pg-held'));
  try {
    for (const bin of bins)
      assert.match(
        await run(consumer, process.execPath, [bin, '--version'], 1),
        /Cannot find package 'pg'|Cannot find module 'pg'/,
      );
  } finally {
    renameSync(join(root, 'pg-held'), pg);
  }
  writeFileSync(
    join(consumer, 'seed-api.mjs'),
    readFileSync(new URL('../src/test/fixtures/libsql-project-workflow/seed-api.mjs', import.meta.url)),
  );
  for (const format of ['esm', 'cjs']) await run(consumer, process.execPath, ['seed-api.mjs', format]);
  await workflow({ consumer, bins, run, report });
  await preservation({ consumer, bins, run, report });
  await deployWorkflow({ consumer, bins, run, report });
  assert.equal(hash(archive), report.sha256, 'Input archive must remain immutable');
  report.passed = true;
} catch (error) {
  owner.fail(error);
  report.error = String(error?.stack ?? error);
  process.exitCode = 1;
} finally {
  await owner.shutdown();
  owner.dispose();
  const identities = report.lifecycle.children.flatMap((item) =>
    [...(item.ownedProcesses ?? []), item.supervisor].filter(Boolean),
  );
  report.independentCleanup = {
    remainingProcesses: identities.filter(sameProcess),
    remainingGroups: [...new Set(identities.map((item) => item.pgid ?? item.group))].filter((group) => {
      try {
        process.kill(-group, 0);
        return true;
      } catch (error) {
        if (error.code === 'ESRCH') return false;
        throw error;
      }
    }),
    ports: [],
    servicesStarted: false,
  };
  rmSync(root, { recursive: true, force: true });
  report.independentCleanup.fixtureAbsent = !existsSync(root);
  report.finished = new Date().toISOString();
  if (
    report.signalExitCode ||
    report.lifecycle.errors.length ||
    report.independentCleanup.remainingProcesses.length ||
    report.independentCleanup.remainingGroups.length
  ) {
    report.passed = false;
    process.exitCode = report.signalExitCode ?? 1;
  }
  save();
  console.log(
    JSON.stringify({
      passed: report.passed,
      node: report.node,
      sha256: report.sha256,
      commands: report.commands.length,
      report: reportPath,
      error: report.error,
    }),
  );
}
