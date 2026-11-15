/** Installed initialization rollback/no-adoption control with a real optional runtime. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { archiveIdentity, command } from '../../../../tooling/optional-pg-transports/harness.mjs';
import { runWithShutdown } from '../../../../tooling/optional-pg-transports/run.mjs';

const root = process.env.D1_PROJECT_ROOT ?? mkdtempSync(join(tmpdir(), 'turbine-d1-project-'));
process.once('exit', () => {
  if (!process.env.D1_PROJECT_ROOT) rmSync(root, { recursive: true, force: true });
});
if (process.env.D1_PROJECT_ROOT) mkdirSync(root, { mode: 0o700 });
const archive = resolve(process.env.D1_PROJECT_ARCHIVE);
const identity = archiveIdentity(archive, process.env.D1_PROJECT_SHA256);
const report = { commands: [], root, node: process.version, archiveSha256: identity.sha256 };
const consumer = join(root, 'consumer');
mkdirSync(consumer);
mkdirSync(join(root, 'tmp'));
writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
const env = {
  ...process.env,
  DATABASE_URL: '',
  TMPDIR: join(root, 'tmp'),
  TMP: join(root, 'tmp'),
  TEMP: join(root, 'tmp'),
};
try {
  await runWithShutdown(
    report,
    join(root, 'report.json'),
    async (scope) => {
      await command(
        report,
        consumer,
        process.execPath,
        [process.env.D1_PROJECT_NPM, 'install', '--no-audit', '--no-fund', archive, 'miniflare@4.20260730.0'],
        env,
        { scope },
      );
      const require = createRequire(join(consumer, 'package.json'));
      report.versions = Object.fromEntries(
        ['pg', 'miniflare', 'workerd'].map((name) => [name, require(`${name}/package.json`).version]),
      );
      writeFileSync(join(root, 'installed.lock.json'), readFileSync(join(consumer, 'package-lock.json')));
      const bin = join(consumer, 'node_modules/turbine-orm/dist/cli/index.js');
      async function refuses(cwd, extraEnv, pattern) {
        let caught = false;
        try {
          await command(
            report,
            cwd,
            process.execPath,
            [bin, 'init', '--engine', 'd1'],
            { ...env, ...extraEnv },
            { timeoutMs: 45000 },
          );
        } catch (e) {
          caught = true;
          assert.match(String(e), pattern);
        }
        assert(caught);
        return report.commands.at(-1);
      }
      const broken = join(consumer, 'broken');
      mkdirSync(broken);
      const result = await refuses(
        broken,
        { MINIFLARE_WORKERD_PATH: join(root, 'missing-workerd') },
        /ENOENT|workerd|runtime|D1 startup/,
      );
      assert(!existsSync(join(broken, 'turbine.config.mjs')));
      assert(!existsSync(join(broken, 'turbine/migrations/plan.json')));
      assert(!existsSync(join(broken, '.turbine/d1/.turbine-d1.json')));
      report.failedStartup = {
        configRolledBack: true,
        planRolledBack: true,
        noMarker: true,
        lockPreserved: existsSync(join(broken, '.turbine/d1/.turbine-d1.lock')),
        statePreserved: existsSync(join(broken, '.turbine/d1')),
        code: result.code,
      };
      const wrapper = join(root, 'after-probe.cjs');
      const wrapperLog = join(root, 'wrapper.jsonl');
      const nativeRequire = createRequire(require.resolve('miniflare'));
      const executable = nativeRequire('workerd').default;
      writeFileSync(
        wrapper,
        `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');const {appendFileSync}=require('node:fs');const args=process.argv.slice(2);appendFileSync(${JSON.stringify(wrapperLog)},JSON.stringify({pid:process.pid,args})+'\\n');const probe=args[0]==='--version';const result=spawnSync(${JSON.stringify(executable)},probe?args:[...args,'--invalid-startup-control'],{stdio:probe?'inherit':['inherit','inherit','inherit',3],timeout:10000});process.exit(result.status??1);\n`,
        { mode: 0o700 },
      );
      const afterProbe = join(consumer, 'after-probe');
      mkdirSync(afterProbe);
      const after = await refuses(afterProbe, { MINIFLARE_WORKERD_PATH: wrapper }, /workerd|runtime|D1|startup/);
      const invocations = readFileSync(wrapperLog, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert(invocations.some((row) => row.args[0] === '--version'));
      assert(invocations.some((row) => row.args[0] === 'serve'));
      assert(!existsSync(join(afterProbe, 'turbine.config.mjs')));
      assert(!existsSync(join(afterProbe, 'turbine/migrations/plan.json')));
      assert(!existsSync(join(afterProbe, '.turbine/d1/.turbine-d1.json')));
      report.afterSuccessfulProbe = {
        realVersionProbe: true,
        actualWorkerdServeFailed: true,
        configRolledBack: true,
        planRolledBack: true,
        noMarker: true,
        code: after.code,
      };
      report.probeFailures = [];
      for (const [mode, body] of [
        ['nonzero', 'process.exit(23)'],
        ['wrong-version', "process.stdout.write('different tool')"],
        [
          'timeout',
          `require('node:fs').writeFileSync(${JSON.stringify(join(root, 'timeout.pid'))},String(process.pid));setTimeout(()=>{},30000)`,
        ],
      ]) {
        const tool = join(root, `probe-${mode}.cjs`);
        writeFileSync(tool, `#!${process.execPath}\n${body};\n`, { mode: 0o700 });
        const directory = join(consumer, `probe-${mode}`);
        mkdirSync(directory);
        await refuses(directory, { MINIFLARE_WORKERD_PATH: tool }, /working Miniflare workerd executable/);
        assert(!existsSync(join(directory, 'turbine.config.mjs')));
        assert(!existsSync(join(directory, '.turbine')));
        assert(!existsSync(join(directory, 'turbine')));
        if (mode === 'timeout') {
          const pid = Number(readFileSync(join(root, 'timeout.pid'), 'utf8'));
          assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
        }
        report.probeFailures.push({ mode, noEffects: true });
      }
      const local = require(join(consumer, 'node_modules/turbine-orm/dist/cjs/cli/d1-local.js'));
      const previous = process.env.MINIFLARE_WORKERD_PATH;
      process.env.MINIFLARE_WORKERD_PATH = join(root, 'missing-workerd');
      try {
        await local.loadD1Runtime();
        assert.fail('missing executable accepted');
      } catch (error) {
        assert.equal(error.cause?.code, 'ENOENT');
        report.originalPrerequisiteCause = { code: error.cause.code, preserved: true };
      } finally {
        if (previous === undefined) delete process.env.MINIFLARE_WORKERD_PATH;
        else process.env.MINIFLARE_WORKERD_PATH = previous;
      }
      const occupied = join(consumer, 'occupied');
      mkdirSync(join(occupied, '.turbine/d1'), { recursive: true });
      writeFileSync(join(occupied, '.turbine/d1/user.txt'), 'user-owned');
      const untouched = await refuses(occupied, {}, /fresh persistence/);
      assert(!untouched.stdout.includes('Local D1 service:'));
      assert.equal(readFileSync(join(occupied, '.turbine/d1/user.txt'), 'utf8'), 'user-owned');
      assert(!existsSync(join(occupied, 'turbine.config.mjs')));
      report.unrelatedPersistencePreserved = true;
    },
    async () => {
      rmSync(consumer, { recursive: true, force: true });
      report.consumerRemoved = !existsSync(consumer);
    },
  );
} catch (e) {
  console.error(e);
  process.exitCode = report.signalExitCode ?? 1;
}
console.log(`D1 init fault report: ${join(root, 'report.json')}`);
