/** Actual installed local D1 sidecar admission, including a change during runtime loading. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { archiveIdentity, command, installedPayload } from '../../../tooling/optional-pg-transports/harness.mjs';
import { runWithShutdown } from '../../../tooling/optional-pg-transports/run.mjs';

const root = process.env.D1_SIDECAR_ROOT ?? mkdtempSync(join(tmpdir(), 'turbine-d1-sidecars-'));
process.once('exit', () => {
  if (!process.env.D1_SIDECAR_ROOT) rmSync(root, { recursive: true, force: true });
});
if (process.env.D1_SIDECAR_ROOT) mkdirSync(root, { mode: 0o700 });
const archive = resolve(process.env.D1_SIDECAR_ARCHIVE);
const identity = archiveIdentity(archive, process.env.D1_SIDECAR_SHA256);
const lock = JSON.parse(readFileSync(process.env.D1_SIDECAR_TOOL_LOCK, 'utf8'));
const report = { root, node: process.version, archive: identity, commands: [], cases: [] };
const consumer = join(root, 'consumer');
const reference = join(root, 'reference');
mkdirSync(consumer, { recursive: true });
mkdirSync(reference);
mkdirSync(join(root, 'tmp'));
const env = { ...process.env, DATABASE_URL: '', TMPDIR: join(root, 'tmp'), npm_config_cache: join(root, 'npm-cache') };
const spec = `file:${archive}`;
lock.packages[''].dependencies['turbine-orm'] = spec;
lock.packages['node_modules/turbine-orm'].resolved = spec;
lock.packages['node_modules/turbine-orm'].integrity =
  `sha512-${createHash('sha512').update(readFileSync(archive)).digest('base64')}`;
writeFileSync(join(consumer, 'package.json'), JSON.stringify({ ...lock.packages[''], private: true, type: 'module' }));
writeFileSync(join(consumer, 'package-lock.json'), JSON.stringify(lock, null, 2));
const library = join(consumer, 'node_modules/turbine-orm');
const project = join(consumer, 'project');
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
await runWithShutdown(
  report,
  join(root, 'report.json'),
  async (scope) => {
    const run = (cwd, binary, args, extra = {}) =>
      command(report, cwd, binary, args, { ...env, ...extra }, { scope, timeoutMs: 120000 });
    await run(consumer, process.execPath, [process.env.D1_SIDECAR_NPM, 'ci', '--no-audit', '--no-fund']);
    await run(reference, 'tar', ['-xzf', archive, '--strip-components=1']);
    report.payload = installedPayload(reference, library);
    const require = createRequire(join(consumer, 'package.json'));
    report.versions = Object.fromEntries(
      ['pg', 'miniflare', 'workerd'].map((name) => [name, require(`${name}/package.json`).version]),
    );
    const nativeRequire = createRequire(require.resolve('miniflare'));
    const workerd = nativeRequire('workerd').default;
    report.workerd = { path: workerd, sha256: hash(workerd) };
    const bin = (format) => join(library, format === 'esm' ? 'dist/cli/index.js' : 'dist/cjs/cli/index.js');
    mkdirSync(project);
    await run(project, process.execPath, [bin('esm'), 'init', '--engine', 'd1']);
    writeFileSync(
      join(project, 'turbine/migrations/plan.json'),
      JSON.stringify([
        {
          id: '0001_items',
          statements: [
            'CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT)',
            "INSERT INTO items VALUES(1,'preserved')",
          ],
        },
      ]),
    );
    await run(project, process.execPath, [bin('cjs'), 'migrate', 'deploy']);
    for (const format of ['esm', 'cjs']) {
      await run(project, process.execPath, [bin(format), 'status']);
      await run(project, process.execPath, [bin(format), 'migrate', 'status']);
      for (const suffix of ['-wal', '-shm', '-journal']) {
        for (const kind of ['hardlink', 'symlink', 'directory', 'late-hardlink']) {
          const target = join(consumer, `${format}${suffix}-${kind}`);
          cpSync(project, target, { recursive: true });
          const persist = join(target, '.turbine/d1');
          const marker = JSON.parse(readFileSync(join(persist, '.turbine-d1.json'), 'utf8'));
          const sidecar = join(persist, marker.databaseFile) + suffix;
          rmSync(sidecar, { recursive: true, force: true });
          const caller = join(target, 'caller-owned.txt');
          writeFileSync(caller, Buffer.alloc(65536, 0x41));
          const before = hash(caller);
          const extra = {};
          let calls;
          if (kind === 'hardlink') linkSync(caller, sidecar);
          else if (kind === 'symlink') symlinkSync(caller, sidecar);
          else if (kind === 'directory') mkdirSync(sidecar);
          else {
            const wrapper = join(target, 'workerd-probe.cjs');
            calls = join(target, 'workerd-calls.jsonl');
            writeFileSync(
              wrapper,
              `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');if(args[0]!=='--version')throw Error('runtime must not open');const version=require('node:child_process').execFileSync(${JSON.stringify(workerd)},args,{encoding:'utf8',timeout:10000});fs.linkSync(${JSON.stringify(caller)},${JSON.stringify(sidecar)});process.stdout.write(version);\n`,
              { mode: 0o700 },
            );
            extra.MINIFLARE_WORKERD_PATH = wrapper;
          }
          let rejected = false;
          try {
            await run(target, process.execPath, [bin(format), 'status'], extra);
          } catch (error) {
            rejected = true;
            assert.match(String(error), /sidecar|symbolic link/);
          }
          assert(rejected, `${format} ${suffix} ${kind} accepted`);
          assert.equal(hash(caller), before, 'caller bytes changed');
          assert.equal(lstatSync(caller).size, 65536);
          assert.equal(lstatSync(caller).nlink, kind.includes('hardlink') ? 2 : 1);
          assert(existsSync(sidecar), 'refusal must not remove sidecar');
          assert(!existsSync(join(persist, '.turbine-d1.lock')));
          assert(!report.commands.at(-1).stdout.includes('Local D1 service:'));
          if (calls) assert.deepEqual(readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse), [['--version']]);
          report.cases.push({ format, suffix, kind, callerSha256: before, untouched: true, noRuntime: true });
          rmSync(target, { recursive: true, force: true });
        }
      }
    }
    report.finalPayload = installedPayload(reference, library);
    report.passed = true;
  },
  async () => {
    rmSync(project, { recursive: true, force: true });
    report.projectRemoved = !existsSync(project);
  },
);
