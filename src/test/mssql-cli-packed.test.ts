/** Packed module/command flow with an observable native-driver fixture, not service certification. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const tsc = join(repo, 'node_modules/.bin/tsc');

it('packs MSSQL init/pull/status and strict ESM/CJS async consumers with refusal controls', {
  timeout: 180_000,
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'turbine-mssql-packed-'));
  function run(command: string, args: string[], cwd: string, extra: Record<string, string> = {}) {
    const result = spawnSync(command, args, {
      cwd,
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        DATABASE_URL: '',
        NO_COLOR: '1',
        MSSQL_FIXTURE_LOG: join(dir, 'events.jsonl'),
        MSSQL_FIXTURE_STATE: join(dir, 'rows.json'),
        ...extra,
      },
    });
    return { status: result.status, output: `${result.stdout}\n${result.stderr}\n${result.error ?? ''}` };
  }
  function ok(command: string, args: string[], cwd: string, extra?: Record<string, string>) {
    const result = run(command, args, cwd, extra);
    assert.equal(result.status, 0, `${args.join(' ')}\n${result.output}`);
    return result.output;
  }
  const events = () =>
    existsSync(join(dir, 'events.jsonl'))
      ? readFileSync(join(dir, 'events.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      : [];
  try {
    const staging = join(dir, 'staging');
    mkdirSync(staging);
    const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
    delete manifest.scripts;
    writeFileSync(join(staging, 'package.json'), JSON.stringify(manifest));
    for (const format of ['esm', 'cjs']) {
      ok(
        tsc,
        [
          '-p',
          join(repo, format === 'esm' ? 'tsconfig.json' : 'tsconfig.cjs.json'),
          '--outDir',
          join(staging, format === 'esm' ? 'dist' : 'dist/cjs'),
        ],
        repo,
      );
    }
    mkdirSync(join(staging, 'scripts'));
    copyFileSync(join(repo, 'scripts/finish-cjs-build.mjs'), join(staging, 'scripts/finish-cjs-build.mjs'));
    ok(process.execPath, [join(staging, 'scripts/finish-cjs-build.mjs')], staging);
    const packed = ok('npm', ['pack', '--ignore-scripts', '--json'], staging);
    const filename = (JSON.parse(packed.trim()) as { filename: string }[])[0]!.filename;
    const dependencies = join(dir, 'node_modules');
    mkdirSync(join(dependencies, 'turbine-orm'), { recursive: true });
    ok('tar', ['-xzf', join(staging, filename), '--strip-components=1', '-C', join(dependencies, 'turbine-orm')], dir);
    for (const name of ['pg', 'tsx']) symlinkSync(join(repo, 'node_modules', name), join(dependencies, name), 'dir');
    const driver = join(dependencies, 'mssql');
    mkdirSync(driver);
    writeFileSync(join(driver, 'package.json'), '{"name":"mssql","main":"index.cjs"}');
    copyFileSync(join(repo, 'src/test/fixtures/mssql-cli-driver.cjs'), join(driver, 'index.cjs'));
    const cli = join(dependencies, 'turbine-orm/dist/cli/index.js');
    const url = 'mssql://sa:PRIVATE_PASSWORD@localhost:1433/disposable';
    for (const type of ['module', 'commonjs']) {
      const consumer = join(dir, type);
      mkdirSync(consumer);
      writeFileSync(join(consumer, 'package.json'), JSON.stringify({ type }));
      const cliOk = (args: string[], extra?: Record<string, string>) =>
        ok(process.execPath, [cli, ...args], consumer, extra);
      cliOk(['init', '--engine', 'mssql', '--schema', 'app', '--url', url, '--yes']);
      const config = readFileSync(join(consumer, 'turbine.config.ts'), 'utf8');
      assert.match(config, /"engine": "mssql"/);
      assert.doesNotMatch(config, /PRIVATE_PASSWORD/);
      const generated = join(consumer, 'generated/turbine');
      assert.match(readFileSync(join(generated, 'index.ts'), 'utf8'), /await turbineMssql/);
      assert.match(cliOk(['info'], { DATABASE_URL: url }), /3/);
      for (const legacy of [false, true]) {
        writeFileSync(
          join(consumer, 'turbine.config.ts'),
          `export default ${JSON.stringify({ engine: 'mssql', url, schema: 'app', legacyToManyUniques: legacy })};`,
        );
        cliOk(['pull', '--no-timestamp']);
        const relationTypes = readFileSync(join(generated, 'types.ts'), 'utf8');
        assert.match(
          relationTypes,
          legacy ? /profiles: RelationDescriptor<.*'hasMany'/ : /profile: RelationDescriptor<.*'hasOne'/,
        );
      }
      writeFileSync(join(consumer, 'turbine.config.ts'), config);
      // Add filtered-out valid overrides, and a retained custom type. Pull must keep both semantics.
      writeFileSync(
        join(consumer, 'turbine.config.ts'),
        config
          .replace('"include": []', '"include": ["users"]')
          .replace(
            '"keepColumnNames": false',
            `"keepColumnNames": true, "columnTypes": { "users.email": "'user:a' | 'user:b'", "audit_logs.body": "string" }`,
          ),
      );
      cliOk(['pull', '--no-timestamp', '--import-ext', 'js'], { DATABASE_URL: url });
      const types = readFileSync(join(generated, 'types.ts'), 'utf8');
      assert.match(types, /email: 'user:a' \| 'user:b'/);
      assert.match(types, /display_name/);
      assert.doesNotMatch(types, /interface AuditLog/);
      const first = readFileSync(join(generated, 'index.ts'), 'utf8');
      cliOk(['generate', '--no-timestamp', '--import-ext', 'js'], { DATABASE_URL: url });
      assert.equal(readFileSync(join(generated, 'index.ts'), 'utf8'), first);
      writeFileSync(join(generated, 'index.ts'), `${first}\n// preserved by init\n`);
      cliOk(['init', '--yes', '--force'], { DATABASE_URL: url });
      assert.equal(readFileSync(join(generated, 'index.ts'), 'utf8'), `${first}\n// preserved by init\n`);
      const valid = `
import assert from 'node:assert/strict';
import { turbine } from './generated/turbine/index.js';
async function main() {
  const db = await turbine({ server: 'localhost', database: 'disposable', options: { encrypt: true, trustServerCertificate: false } },
    { schema: 'app', logger: {}, globalFilters: { users: null } });
  const user = await db.users.create({ data: { email: 'user:a', display_name: 'A' } });
  assert.equal(user.email, 'user:a');
  const rows = await db.users.findMany({ select: { email: true } });
  assert.ok(rows.length > 0);
  const email: 'user:a' | 'user:b' = rows[0]!.email;
  assert.equal(email, 'user:a');
  await db.disconnect();
}
void main();
// @ts-expect-error selected field typo must be refused
void turbine('mssql://localhost/db').then(db => db.users.findMany({ select: { emali: true } }));
// @ts-expect-error engine-specific options must stay typed
void turbine('mssql://localhost/db', { foreignKeys: true });
// @ts-expect-error generated factory stays asynchronous
void turbine('mssql://localhost/db').users;
`;
      writeFileSync(join(consumer, 'usage.ts'), valid);
      writeFileSync(
        join(consumer, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2023',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            strict: true,
            exactOptionalPropertyTypes: true,
            skipLibCheck: true,
            types: ['node'],
            typeRoots: [join(repo, 'node_modules/@types')],
            outDir: './out',
          },
          include: ['usage.ts', 'generated/**/*.ts'],
        }),
      );
      ok(tsc, ['-p', consumer], consumer);
      writeFileSync(join(consumer, 'usage.ts'), valid.replaceAll('// @ts-expect-error', '// negative control:'));
      const invalid = run(tsc, ['-p', consumer, '--noEmit'], consumer);
      assert.notEqual(invalid.status, 0, invalid.output);
      for (const marker of ['emali', 'foreignKeys', "turbine('mssql://localhost/db').users"]) {
        const line = valid.slice(0, valid.indexOf(marker)).split('\n').length;
        assert.ok(invalid.output.includes(`usage.ts(${line},`), invalid.output);
      }
      // Type-only negative controls must not execute during the runtime check.
      writeFileSync(join(consumer, 'usage.ts'), valid.slice(0, valid.indexOf('// @ts-expect-error')));
      ok(tsc, ['-p', consumer], consumer);
      ok(process.execPath, [join(consumer, 'out/usage.js')], consumer);
      const rendered = readFileSync(join(consumer, 'out/generated/turbine/index.js'), 'utf8');
      assert.ok(rendered.includes(type === 'module' ? 'import { turbineMssql }' : 'require("turbine-orm/mssql")'));
      assert.ok(JSON.parse(readFileSync(join(dir, 'rows.json'), 'utf8')).length > 0);
      const before = events().length;
      for (const args of [
        ['push'],
        ['migrate', 'deploy', '--force'],
        ['seed', '--dry-run'],
        ['generate', '--include-views'],
        ['init', '--with-schema'],
      ]) {
        const refused = run(process.execPath, [cli, ...args], consumer, { DATABASE_URL: url });
        assert.equal(refused.status, 1, refused.output);
        assert.match(refused.output, /not supported|does not support|refuse|Unknown flag/);
      }
      assert.equal(events().length, before, 'refused operations must never construct a driver');
      for (const args of [['--out', '--dry-run'], ['--url'], ['--url', '--dry-run', '--url', url], ['--schema']]) {
        const refused = run(process.execPath, [cli, 'migrate', 'up', ...args], consumer, { DATABASE_URL: url });
        assert.equal(refused.status, 1, refused.output);
        assert.match(refused.output, /does not support|requires a value/);
        assert.equal(events().length, before, 'malformed operands must never construct a driver');
      }
      cliOk(['migrate', 'create', 'packed_offline'], { DATABASE_URL: url });
      assert.equal(events().length, before, 'migration scaffolding is offline');
      const validConfig = readFileSync(join(consumer, 'turbine.config.ts'), 'utf8');
      for (const invalid of [
        { exclude: 'audit_logs' },
        { include: { users: true } },
        { include: [''] },
        { exclude: [null] },
      ]) {
        writeFileSync(
          join(consumer, 'turbine.config.ts'),
          `export default ${JSON.stringify({ engine: 'mssql', url, schema: 'app', ...invalid })};`,
        );
        const refused = run(process.execPath, [cli, 'pull', '--no-timestamp'], consumer);
        assert.equal(refused.status, 1, refused.output);
        assert.match(refused.output, /config (?:include|exclude) must be an array of nonempty table names/);
        assert.equal(events().length, before, 'malformed filters must never construct a driver');
      }
      writeFileSync(join(consumer, 'turbine.config.ts'), validConfig);
      const typoConfig = readFileSync(join(consumer, 'turbine.config.ts'), 'utf8').replace(
        'audit_logs.body',
        'audit_logs.typo',
      );
      writeFileSync(join(consumer, 'turbine.config.ts'), typoConfig);
      const typo = run(process.execPath, [cli, 'pull'], consumer, { DATABASE_URL: url });
      assert.equal(typo.status, 1, typo.output);
      assert.match(typo.output, /columnTypes key.*no table|no column/);
      const failed = run(process.execPath, [cli, 'status'], consumer, { DATABASE_URL: url, MSSQL_FIXTURE_FAIL: '1' });
      assert.equal(failed.status, 1, failed.output);
      assert.match(failed.output, /catalog fixture failure/);
    }
    const log = events();
    assert.ok(log.filter((e) => e.event === 'query').length > 30);
    assert.equal(log.filter((e) => e.event === 'connect').length, log.filter((e) => e.event === 'close').length);
    for (const event of log.filter((e) => e.event === 'query' && /INFORMATION_SCHEMA|sys\./.test(e.sql)))
      assert.equal(event.params.p1, 'app');
    assert.ok(
      log.some(
        (e) =>
          e.event === 'construct' &&
          e.config.options.encrypt === true &&
          e.config.options.trustServerCertificate === false,
      ),
    );
    // Wrong schema is a real empty-catalog control, and must not emit a client.
    const empty = join(dir, 'empty');
    mkdirSync(empty);
    const refused = run(
      process.execPath,
      [cli, 'pull', '--engine', 'mssql', '--url', url, '--schema', 'missing'],
      empty,
    );
    assert.equal(refused.status, 1, refused.output);
    assert.match(refused.output, /matched 0 tables/);
    assert.equal(existsSync(join(empty, 'generated/turbine/index.ts')), false);
    ok(
      process.execPath,
      [cli, 'pull', '--engine', 'mssql', '--url', url, '--schema', 'missing', '--allow-empty'],
      empty,
    );
    assert.match(readFileSync(join(empty, 'generated/turbine/index.ts'), 'utf8'), /await turbineMssql/);
    const offline = join(dir, 'offline');
    mkdirSync(offline);
    const beforeOffline = events().length;
    ok(process.execPath, [cli, 'init', '--engine', 'mssql', '--skip-generate'], offline);
    assert.match(readFileSync(join(offline, 'turbine.config.ts'), 'utf8'), /process.env.DATABASE_URL/);
    assert.equal(existsSync(join(offline, 'generated')), false);
    assert.equal(events().length, beforeOffline);
    assert.match(
      ok(process.execPath, [cli, 'migrate', '--engine', 'mssql', '--help'], offline),
      /SQL-first migrations/,
    );
    writeFileSync(join(offline, 'turbine.config.ts'), 'throw new Error("broken config"); export default {};');
    const unreadable = run(process.execPath, [cli, 'status', '--engine', 'mssql', '--url', url], offline);
    assert.equal(unreadable.status, 1, unreadable.output);
    assert.match(unreadable.output, /Could not load.*broken config/);
    writeFileSync(join(offline, 'turbine.config.ts'), 'export default { engine: "postgresql" };');
    const mixed = run(process.execPath, [cli, 'init', '--engine', 'mssql', '--url', url], offline);
    assert.equal(mixed.status, 1, mixed.output);
    assert.match(mixed.output, /different database engine/);
    assert.equal(events().length, beforeOffline, 'bad config must fail before opening any connection');
    rmSync(driver, { recursive: true });
    const absent = run(process.execPath, [cli, 'status', '--engine', 'mssql', '--url', url], empty);
    assert.equal(absent.status, 1, absent.output);
    assert.match(absent.output, /optional peer dependency 'mssql'/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
