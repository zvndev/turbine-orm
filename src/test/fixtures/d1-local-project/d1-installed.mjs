/** Normal installed CLI lifecycle proof. Every command uses the existing bounded owner. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { archiveIdentity, command, installedPayload } from '../../../../tooling/optional-pg-transports/harness.mjs';
import { runWithShutdown } from '../../../../tooling/optional-pg-transports/run.mjs';

const root = process.env.D1_PROJECT_ROOT ?? mkdtempSync(join(tmpdir(), 'turbine-d1-project-'));
process.once('exit', () => {
  if (!process.env.D1_PROJECT_ROOT) rmSync(root, { recursive: true, force: true });
});
if (process.env.D1_PROJECT_ROOT) mkdirSync(root, { mode: 0o700 });
const archive = resolve(process.env.D1_PROJECT_ARCHIVE ?? '');
const identity = archiveIdentity(archive, process.env.D1_PROJECT_SHA256);
const report = { commands: [], root, archive, sha256: identity.sha256, node: process.version, controls: [] };
const env = {
  ...process.env,
  DATABASE_URL: '',
  TMPDIR: join(root, 'tmp'),
  TMP: join(root, 'tmp'),
  TEMP: join(root, 'tmp'),
};
mkdirSync(env.TMPDIR, { recursive: true });
const consumer = join(root, 'consumer');
const reference = join(root, 'reference');
mkdirSync(consumer);
mkdirSync(reference);
writeFileSync(
  join(consumer, 'package.json'),
  JSON.stringify({ name: 'd1-local-consumer', private: true, type: 'module' }),
);
const library = join(consumer, 'node_modules/turbine-orm');
const project = join(consumer, 'project');
mkdirSync(project);
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
try {
  await runWithShutdown(
    report,
    join(root, 'report.json'),
    async (scope) => {
      const run = (cwd, args, binary = process.execPath) =>
        command(report, cwd, binary, args, env, { scope, timeoutMs: 120000 });
      const npm = (args) => run(consumer, [process.env.D1_PROJECT_NPM, ...args]);
      const cli = (args, format = 'esm') =>
        run(project, [join(library, format === 'esm' ? 'dist/cli/index.js' : 'dist/cjs/cli/index.js'), ...args]);
      const refuse = async (cwd, args, pattern, extraEnv = {}) => {
        let rejected = false;
        try {
          await command(report, cwd, process.execPath, args, { ...env, ...extraEnv }, { timeoutMs: 45000 });
        } catch (error) {
          rejected = true;
          assert.match(String(error), pattern);
        }
        assert(rejected, 'negative control unexpectedly succeeded');
        const record = report.commands.at(-1);
        report.controls.push({ args, code: record.code, pattern: String(pattern) });
        return record.stdout + record.stderr;
      };
      const cliRefuse = (args, pattern) => refuse(project, [join(library, 'dist/cli/index.js'), ...args], pattern);
      await run(reference, ['-xzf', archive, '--strip-components=1'], 'tar');
      await npm(['install', '--omit=dev', '--no-audit', '--no-fund', archive]);
      report.payload = installedPayload(reference, library);
      const consumerRequire = createRequire(join(consumer, 'package.json'));
      report.defaultPgVersion = consumerRequire('pg/package.json').version;
      writeFileSync(join(root, 'default-install.lock.json'), readFileSync(join(consumer, 'package-lock.json')));

      assert.deepEqual(identity.manifest.dependencies, { pg: '^8.15.0' });
      writeFileSync(
        join(consumer, 'default.mjs'),
        `import {createRequire} from 'node:module';import {resolveConfig} from 'turbine-orm/cli';const require=createRequire(import.meta.url);require('turbine-orm');if(resolveConfig({engine:'d1'},{}).engine!=='d1')throw Error('engine');for(const p of ['miniflare','workerd','mysql2','mssql','@libsql/client']){try{require.resolve(p);throw Error('unexpected '+p)}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e}}`,
      );
      await run(consumer, [join(consumer, 'default.mjs')]);
      writeFileSync(
        join(consumer, 'default.cjs'),
        `const {resolveConfig}=require('turbine-orm/cli');require('turbine-orm');if(resolveConfig({engine:'d1'},{}).engine!=='d1')throw Error('engine');`,
      );
      await run(consumer, [join(consumer, 'default.cjs')]);
      const before = await cliRefuse(['init', '--engine', 'd1'], /requires optional miniflare@4\.20260730\.0/);
      assert(!before.includes('Local D1 service:'));
      assert(!existsSync(join(project, '.turbine')));
      assert(!existsSync(join(project, 'turbine.config.mjs')));
      await refuse(
        project,
        [join(library, 'dist/cjs/cli/index.js'), 'init', '--engine', 'd1'],
        /requires optional miniflare@4\.20260730\.0/,
      );
      report.defaultOptionalToolAbsent = true;
      // Explicit and config-derived help/aliases require neither tooling nor persisted state.
      for (const commandName of ['init', 'generate', 'pull', 'gen', 'g', 'status', 'info', 'migrate', 'migration', 'm'])
        assert.match(await cli([commandName, '--engine', 'd1', '--help']), /Local D1:/);
      writeFileSync(
        join(project, 'turbine.config.mjs'),
        "export default {engine:'d1',d1:{binding:'DB',databaseId:'help-only',persist:'./state'}};",
      );
      for (const commandName of ['init', 'generate', 'pull', 'gen', 'g', 'status', 'info', 'migrate', 'migration', 'm'])
        assert.match(await cli([commandName, '--help']), /Local D1:/);
      for (const commandName of ['doctor', 'push', 'studio', 'seed'])
        await cliRefuse([commandName, '--engine', 'd1'], /Local D1 supports/);
      rmSync(join(project, 'turbine.config.mjs'));
      assert(!existsSync(join(project, 'state')));
      report.helpWithoutToolOrState = true;

      for (const args of [
        ['pull', '--out', '--engine', 'd1'],
        ['pull', '--engine', 'd1', '--out'],
        ['migrate', 'deploy', '--engine', 'd1', '--step', '1'],
      ]) {
        const text = await cliRefuse(args, /Missing value|Unsupported local D1/);
        assert(!text.includes('Local D1 service:'));
      }
      await npm([
        'install',
        '--save-dev',
        '--save-exact',
        '--no-audit',
        '--no-fund',
        'miniflare@4.20260730.0',
        'typescript@6.0.3',
        '@types/node@22.20.4',
        '@cloudflare/workers-types@5.20261106.1',
        'esbuild@0.28.2',
      ]);
      report.toolingVersions = Object.fromEntries(
        ['miniflare', 'workerd', 'typescript', '@types/node', '@cloudflare/workers-types', 'esbuild'].map((name) => [
          name,
          consumerRequire(`${name}/package.json`).version,
        ]),
      );
      writeFileSync(join(root, 'tooling-install.lock.json'), readFileSync(join(consumer, 'package-lock.json')));
      const broken = join(consumer, 'startup-fault');
      mkdirSync(broken);
      await refuse(
        broken,
        [join(library, 'dist/cli/index.js'), 'init', '--engine', 'd1'],
        /working Miniflare workerd executable/,
        { MINIFLARE_WORKERD_PATH: join(root, 'missing-workerd') },
      );
      assert(!existsSync(join(broken, 'turbine.config.mjs')));
      assert(!existsSync(join(broken, 'turbine/migrations/plan.json')));
      assert(!existsSync(join(broken, '.turbine/d1')));
      const occupied = join(consumer, 'occupied');
      mkdirSync(join(occupied, '.turbine/d1'), { recursive: true });
      writeFileSync(join(occupied, '.turbine/d1/user.txt'), 'user-owned');
      const untouched = await refuse(
        occupied,
        [join(library, 'dist/cli/index.js'), 'init', '--engine', 'd1'],
        /fresh persistence/,
      );
      assert(!untouched.includes('Local D1 service:'));
      assert.equal(readFileSync(join(occupied, '.turbine/d1/user.txt'), 'utf8'), 'user-owned');
      assert(!existsSync(join(occupied, 'turbine.config.mjs')));
      report.startupAdmission = { missingWorkerdNoEffects: true, unrelatedPersistencePreserved: true };
      await cli(['init', '--engine', 'd1']);
      const marker = join(project, '.turbine/d1/.turbine-d1.json');
      const markerHash = sha(marker);
      assert.match(await cli(['migrate', 'status']), /"historyState":"uninitialized"/);
      assert.match(await cli(['migrate', 'list']), /uninitialized/);
      const planPath = join(project, 'turbine/migrations/plan.json');
      const plan = [
        {
          id: '0001_items',
          statements: [
            'CREATE TABLE items(id INTEGER PRIMARY KEY,label TEXT NOT NULL UNIQUE)',
            "INSERT INTO items VALUES (1,'first')",
          ],
        },
      ];
      writeFileSync(planPath, JSON.stringify(plan));
      assert.match(await cli(['migrate', 'deploy']), /"applied":\["0001_items"\]/);
      assert.match(await cli(['pull', '--out', './generated-first', '--no-timestamp']), /Generated 3 D1 files/);
      const edited = join(project, 'generated-first/index.ts');
      writeFileSync(edited, `${readFileSync(edited, 'utf8')}\n// User edit survives regeneration refusal.\n`);
      const editedHash = sha(edited);
      assert(
        !(await cliRefuse(['generate', '--out', './generated-first'], /fresh --out/)).includes('Local D1 service:'),
      );
      assert.equal(sha(edited), editedHash);
      plan.push({ id: '0002_more', statements: ["INSERT INTO items VALUES (2,'second')"] });
      writeFileSync(planPath, JSON.stringify(plan));
      assert.match(await cli(['migrate', 'deploy'], 'cjs'), /"applied":\["0002_more"\]/);
      assert.match(
        await cli(['generate', '--out', './generated-next', '--no-timestamp'], 'cjs'),
        /Generated 3 D1 files/,
      );
      assert.match(await cli(['status']), /"applied":\["0001_items","0002_more"\],"pending":\[\]/);
      assert.equal(sha(marker), markerHash);
      const bad = JSON.parse(JSON.stringify(plan));
      bad[0].statements[1] = "INSERT INTO items VALUES (1,'changed')";
      writeFileSync(planPath, JSON.stringify(bad));
      await cliRefuse(['migrate', 'status'], /changed checksum/);
      await cliRefuse(['migrate', 'deploy'], /changed checksum/);
      writeFileSync(planPath, JSON.stringify(plan));
      plan.push({ id: '0003_invalid', statements: ['PRAGMA user_version=1'] });
      writeFileSync(planPath, JSON.stringify(plan));
      assert(!(await cliRefuse(['migrate', 'list'], /SQL admission failed/)).includes('Local D1 service:'));
      plan.pop();
      writeFileSync(planPath, JSON.stringify(plan));
      for (const out of ['./.turbine/d1/nested', './turbine/migrations', './turbine.config.mjs'])
        assert(!(await cliRefuse(['pull', '--out', out], /disjoint|fresh --out/)).includes('Local D1 service:'));
      const planAlias = join(project, 'plan-alias.json');
      linkSync(planPath, planAlias);
      assert(!(await cliRefuse(['status'], /regular, unaliased/)).includes('Local D1 service:'));
      rmSync(planAlias);
      const m = JSON.parse(readFileSync(marker, 'utf8'));
      writeFileSync(marker, JSON.stringify({ ...m, databaseId: 'wrong' }));
      assert(!(await cliRefuse(['status'], /marker identity/)).includes('Local D1 service:'));
      writeFileSync(marker, `${JSON.stringify(m)}\n`);
      const database = join(project, '.turbine/d1', m.databaseFile);
      renameSync(database, `${database}.held`);
      assert(!(await cliRefuse(['status'], /state is missing/)).includes('Local D1 service:'));
      assert(!existsSync(database));
      renameSync(`${database}.held`, database);
      const lock = join(project, '.turbine/d1/.turbine-d1.lock');
      await run(project, [
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(lock)},process.pid+'\\n',{flag:'wx'})`,
      ]);
      const dead = Number(readFileSync(lock, 'utf8'));
      assert.throws(() => process.kill(dead, 0), { code: 'ESRCH' });
      await cliRefuse(['status'], /in use or has a stale lock/);
      assert(existsSync(lock));
      // Explicit operator recovery of this fixture's dead owner's lock, after ESRCH proof.
      rmSync(lock);
      report.staleLock = { pid: dead, provedDead: true, automaticallyRemoved: false };
      report.runtimeFaults = [];
      const interruptedRoot = join(root, 'fault-interrupted');
      const interruptedOutput = await refuse(
        consumer,
        [resolve('src/test/fixtures/d1-local-project/d1-lifecycle.mjs'), library, interruptedRoot, 'interrupted'],
        /Local D1 service:/,
      );
      assert(!interruptedOutput.includes('ERR_SERVER_NOT_RUNNING'));
      const interruptedLock = join(interruptedRoot, 'state/.turbine-d1.lock');
      assert(existsSync(interruptedLock));
      const interruptedPid = Number(readFileSync(interruptedLock, 'utf8'));
      assert.throws(() => process.kill(interruptedPid, 0), { code: 'ESRCH' });
      report.interruptedWait = { bounded: true, pid: interruptedPid, ownerReaped: true, lockPreserved: true };

      for (const mode of ['stalled', 'late', 'dispose-fail', 'dispose-stall']) {
        const faultRoot = join(root, `fault-${mode}`);
        await run(consumer, [resolve('src/test/fixtures/d1-local-project/d1-lifecycle.mjs'), library, faultRoot, mode]);
        const fault = JSON.parse(readFileSync(join(faultRoot, 'lifecycle.json'), 'utf8'));
        assert.equal(fault.externalDisposal, true);
        if (mode.startsWith('dispose-')) assert.equal(fault.lockRetained, true);
        report.runtimeFaults.push(fault);
      }
      report.native = await (await import('./d1-native.mjs')).nativeProof({
        root,
        consumer,
        project,
        library,
        run,
        report,
        env,
      });
      assert.deepEqual(installedPayload(reference, library), report.payload);
      assert.equal(sha(archive), identity.sha256);
      report.payloadUnchanged = true;
    },
    async () => {
      rmSync(consumer, { recursive: true, force: true });
      rmSync(reference, { recursive: true, force: true });
      report.consumerRemoved = !existsSync(consumer);
      report.referenceRemoved = !existsSync(reference);
    },
  );
} catch (error) {
  console.error(error);
  process.exitCode = report.signalExitCode ?? 1;
}
console.log(`D1 installed report: ${join(root, 'report.json')}`);
