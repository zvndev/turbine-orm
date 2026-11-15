/** Full route acceptance; all imports and commands below target the installed package. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function workflow({ consumer, bins, run, report }) {
  const { createClient } = await import(pathToFileURL(join(consumer, 'node_modules/@libsql/client/lib-esm/node.js')));
  const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
  const forbidCjs = join(consumer, 'forbid-sqlite.cjs');
  const forbidEsm = join(consumer, 'forbid-sqlite-loader.mjs');
  writeFileSync(
    forbidCjs,
    "const M=require('node:module'),load=M._load;M._load=function(name,...args){if(name==='node:sqlite')throw new Error('node:sqlite forbidden');return load.call(this,name,...args);};",
  );
  writeFileSync(
    forbidEsm,
    "export function resolve(name,context,next){if(name==='node:sqlite')throw new Error('node:sqlite forbidden');return next(name,context);}",
  );
  const native = async (file, fn) => {
    const client = createClient({ url: pathToFileURL(file).href, intMode: 'bigint' });
    try {
      return await fn(client);
    } finally {
      client.close();
      assert.equal(client.closed, true);
    }
  };
  const configText = (config, cjs = false) =>
    `${cjs ? 'module.exports =' : 'export default'} ${JSON.stringify(config)};\n`;
  const snapshot = (dir) =>
    Object.fromEntries(
      readdirSync(dir, { withFileTypes: true }).flatMap((item) =>
        item.isFile() ? [[item.name, hash(join(dir, item.name))]] : [],
      ),
    );
  // No config can rescue a swallowed engine flag. Refuse before any PG fallback.
  report.rawEngineAdmission = [];
  for (const [index, bin] of bins.entries()) {
    const dir = join(consumer, `raw-engine-${index}`);
    mkdirSync(dir);
    for (const args of [
      ['migrate', 'create', 'heldout', '--schema'],
      ['migrate', 'status', '--url'],
      ['migrate', 'list', '-s'],
      ['init', '--url'],
      ['generate', '--out'],
      ['seed', '--url'],
    ]) {
      for (const engineFirst of [false, true]) {
        const tokens = engineFirst
          ? [args[0], '--engine', 'libsql', ...args.slice(1)]
          : [...args, '--engine', 'libsql'];
        const output = await run(dir, process.execPath, [bin, ...tokens], 1);
        assert.match(output, /\[TURBINE_E(?:003|017)\]/, 'Command must fail libSQL admission');
        assert.deepEqual(readdirSync(dir), [], 'Refusal must not create scaffolding or a database');
        report.rawEngineAdmission.push({ bin: index, args: tokens, passed: true });
      }
    }
  }
  // No project-local TS loader yet, including on Node 24 with native stripping.
  const noTsx = join(consumer, 'no-tsx');
  mkdirSync(noTsx);
  const noTsxDb = join(noTsx, 'app.sqlite');
  await native(noTsxDb, (db) => db.execute('CREATE TABLE items(id INTEGER PRIMARY KEY)'));
  writeFileSync(join(noTsx, 'turbine.config.mjs'), configText({ engine: 'libsql', url: 'file:./app.sqlite' }));
  writeFileSync(
    join(noTsx, 'seed.ts'),
    "import { writeFileSync } from 'node:fs'; writeFileSync('import-effect', 'bad'); export default async () => {};",
  );
  for (const bin of bins) {
    const before = snapshot(noTsx);
    assert.match(
      await run(noTsx, process.execPath, [bin, 'seed'], 1),
      /TypeScript libSQL seed \(missing\).*Install tsx/s,
    );
    assert.deepEqual(snapshot(noTsx), before);
    writeFileSync(join(noTsx, 'seed.js'), 'export default async () => {};');
    writeFileSync(
      join(noTsx, 'turbine.config.mjs'),
      configText({ engine: 'libsql', url: 'file:./app.sqlite', seedFile: './seed.js' }),
    );
    assert.match(await run(noTsx, process.execPath, [bin, 'seed']), /Seed completed/);
    writeFileSync(join(noTsx, 'turbine.config.mjs'), configText({ engine: 'libsql', url: 'file:./app.sqlite' }));
    rmSync(join(noTsx, 'seed.js'));
  }
  await run(consumer, 'npm', [
    'install',
    '--ignore-scripts',
    '--include=optional',
    '--no-audit',
    '--no-fund',
    'tsx@4.23.15',
  ]);
  report.installedPrerequisites = Object.fromEntries(
    ['@libsql/client', 'libsql', 'pg', 'tsx', 'typescript'].map((name) => [
      name,
      JSON.parse(readFileSync(join(consumer, 'node_modules', name, 'package.json'), 'utf8')).version,
    ]),
  );
  report.matrix = [];
  for (const [binIndex, bin] of bins.entries())
    for (const type of ['module', 'commonjs']) {
      const dir = join(consumer, `project-${binIndex}-${type}`);
      mkdirSync(dir);
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ private: true, type }));
      const cli = (args, code = 0, env = {}) => run(dir, process.execPath, [bin, ...args], code, env);
      const file = join(dir, 'app space.sqlite');
      const relativeUrl = 'file:./app%20space.sqlite';
      assert.match(await cli(['init', '--engine', 'libsql', '--url', relativeUrl, '--yes']), /Created/);
      assert.ok(existsSync(file));
      for (const absent of ['.env', 'turbine/migrations', 'turbine/schema.ts', 'seed.ts'])
        assert.equal(existsSync(join(dir, absent)), false);
      const initConfig = readFileSync(join(dir, 'turbine.config.ts'), 'utf8');
      assert.match(initConfig, /engine: 'libsql'/);
      await native(file, async (db) => {
        assert.equal((await db.execute("SELECT name FROM sqlite_master WHERE type='table'")).rows.length, 0);
        await db.executeMultiple(`
        PRAGMA foreign_keys=ON;
        CREATE TABLE parents(id INTEGER PRIMARY KEY, display_name TEXT NOT NULL, category TEXT NOT NULL);
        CREATE TABLE profiles(id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL UNIQUE REFERENCES parents(id), label TEXT NOT NULL);
        CREATE TABLE events(id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parents(id), title TEXT NOT NULL);
        CREATE TABLE hidden(id INTEGER PRIMARY KEY, secret TEXT);
        CREATE TABLE raw_records(id INTEGER PRIMARY KEY, "odd'name" TEXT NOT NULL);
        CREATE VIEW report_view AS SELECT id FROM parents;
      `);
      });
      // The real scaffolded TS config selects libSQL without an engine flag.
      await cli(['generate', '--no-timestamp']);
      assert.match(await cli(['seed', '--help']), /defineLibsqlSeed/);
      assert.match(await cli(['generate', '--help']), /Local libSQL/);
      assert.match(await cli(['seed', '--engine', 'libsql', '--help']), /defineLibsqlSeed/);
      const configFile = join(dir, 'turbine.config.ts');
      const base = {
        engine: 'libsql',
        url: relativeUrl,
        out: './generated/turbine',
        include: ['parents', 'profiles', 'events', 'raw_records', 'hidden'],
        exclude: ['hidden'],
        columnTypes: { 'parents.category': "'a' | 'b'", 'hidden.secret': 'string' },
      };
      const setConfig = (extra = {}) => writeFileSync(configFile, configText({ ...base, ...extra }));
      setConfig();
      await cli(['generate', '--no-timestamp']);
      const metadataFile = join(dir, 'generated/turbine/metadata.ts');
      const typesFile = join(dir, 'generated/turbine/types.ts');
      assert.doesNotMatch(readFileSync(typesFile, 'utf8'), /interface Hidden|interface ReportView/);
      assert.match(readFileSync(typesFile, 'utf8'), /'a' \| 'b'/);
      assert.match(readFileSync(metadataFile, 'utf8'), /hasOne/);
      const stable = hash(typesFile);
      setConfig({ columnTypes: { 'hidden.typo': 'string' } });
      assert.match(await cli(['generate', '--no-timestamp'], 1), /names no column/);
      assert.equal(hash(typesFile), stable);
      for (const [mode, ext] of [
        ['ts', '.ts'],
        ['none', ''],
        ['auto', '.js'],
        ['js', '.js'],
      ]) {
        setConfig({ importExtension: mode });
        await cli(['generate', '--no-timestamp']);
        assert.ok(readFileSync(join(dir, 'generated/turbine/index.ts'), 'utf8').includes(`from './metadata${ext}'`));
        writeFileSync(
          join(dir, 'mode-control.ts'),
          `import type {TurbineClient} from './generated/turbine/index${ext}';
export function controls(db:TurbineClient){void db.parents.findFirst({with:{profile:true,events:true}});
// @ts-expect-error filtered table is absent in every import mode
void db.hidden;
// @ts-expect-error column override remains narrow in every mode
void db.parents.create({data:{displayName:'x',category:'invalid'}});}`,
        );
        await run(dir, process.execPath, [
          join(consumer, 'node_modules/typescript/bin/tsc'),
          '--noEmit',
          '--strict',
          '--skipLibCheck',
          'false',
          '--target',
          'ES2023',
          '--module',
          'ESNext',
          '--moduleResolution',
          'Bundler',
          '--allowImportingTsExtensions',
          'mode-control.ts',
        ]);
      }
      setConfig({ keepColumnNames: true, legacyToManyUniques: true });
      await cli(['generate', '--no-timestamp']);
      assert.match(readFileSync(typesFile, 'utf8'), /display_name/);
      assert.match(readFileSync(metadataFile, 'utf8'), /hasMany/);
      setConfig();
      await cli(['generate', '--no-timestamp']);
      // Strict generated client + seed helper in the project module mode. Negative
      // assertions must be consumed by tsc, never merely executed as JS.
      const usage = `import assert from 'node:assert/strict';
import { turbine, type TurbineClient } from './generated/turbine/index.js';
import { defineLibsqlSeed, type LibsqlSeedClient } from 'turbine-orm/libsql/seed';
import type { TransactionClient } from 'turbine-orm';
export const seed = defineLibsqlSeed(async tx => {
 const exact: TransactionClient = tx; const same: LibsqlSeedClient = exact;
 await same.table<{ id: number; displayName: string; category: 'a' | 'b' }>('parents').create({data:{id:1,displayName:'typed',category:'a'}});
 await tx.table<{ id: number; parentId: number; label: string }>('profiles').create({data:{id:1,parentId:1,label:'one'}});
 await tx.table<{ id: number; parentId: number; title: string }>('events').create({data:{id:1,parentId:1,title:'many'}});
});
function controls(db: TurbineClient, tx: LibsqlSeedClient) {
 // @ts-expect-error callback handle does not own the client
 void tx.disconnect();
 // @ts-expect-error type override narrows category
 void db.parents.create({data:{displayName:'bad',category:'c'}});
 // @ts-expect-error filtered table is absent
 void db.hidden;
 // @ts-expect-error hasOne relation is not an array
 void db.parents.findFirst({with:{profile:true}}).then(p=>p?.profile?.[0]);
}
void controls;
async function main() { const db = await turbine(${JSON.stringify(relativeUrl)}, {logger:{},warnOnUnlimited:false});
 try { const row=await db.parents.findFirst({where:{id:1},with:{profile:true,events:true}});
 assert.equal(row?.displayName,'typed'); const label: string | undefined = row?.profile?.label;
 assert.equal(label,'one'); assert.equal(row?.events.length,1);
 const category: 'a' | 'b' | undefined = row?.category; assert.equal(category,'a');
 } finally { await db.disconnect(); } }
void main().catch((error:unknown)=>{console.error(error);process.exitCode=1;});`;
      writeFileSync(join(dir, 'usage.ts'), usage);
      // Extract the typed callback for actual CLI execution, without import effects
      // from the generated-client reader that is run after seeding.
      writeFileSync(
        join(dir, 'seed.ts'),
        usage.slice(0, usage.indexOf('function controls')).replace('export const seed =', 'export default'),
      );
      setConfig({ seedFile: './seed.ts' });
      const tsc = join(consumer, 'node_modules/typescript/bin/tsc');
      const tsconfig = {
        compilerOptions: {
          strict: true,
          skipLibCheck: false,
          target: 'ES2023',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          types: ['node'],
          outDir: './compiled',
        },
        include: ['usage.ts', 'seed.ts', 'generated/**/*.ts'],
      };
      writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify(tsconfig));
      await run(dir, process.execPath, [tsc, '-p', 'tsconfig.json']);
      assert.match(await cli(['seed']), /Seed completed/);
      await run(dir, process.execPath, [
        '--require',
        forbidCjs,
        '--experimental-loader',
        forbidEsm,
        'compiled/usage.js',
      ]);
      // The unique foreign key derives `profile` (hasOne) by default; the legacy
      // mode derives the plural hasMany, which relationNames renames back.
      setConfig({ legacyToManyUniques: true, relationNames: { parents: { profiles: 'profile' } } });
      await cli(['generate', '--no-timestamp']);
      writeFileSync(
        join(dir, 'legacy.ts'),
        `import {turbine} from './generated/turbine/index.js';
async function main(){const db=await turbine(${JSON.stringify(relativeUrl)},{logger:{},warnOnUnlimited:false});try{const p=await db.parents.findFirst({with:{profile:true}});const n:number|undefined=p?.profile.length;if(n!==1)throw new Error('legacy cardinality');}finally{await db.disconnect();}}void main().catch((e:unknown)=>{console.error(e);process.exitCode=1;});`,
      );
      writeFileSync(
        join(dir, 'tsconfig.legacy.json'),
        JSON.stringify({ ...tsconfig, include: ['legacy.ts', 'generated/**/*.ts'] }),
      );
      await run(dir, process.execPath, [tsc, '-p', 'tsconfig.legacy.json']);
      await run(dir, process.execPath, ['compiled/legacy.js']);
      setConfig({ seedFile: './seed.ts' });
      await cli(['generate', '--no-timestamp']);
      await native(file, async (db) =>
        assert.equal((await db.execute('SELECT display_name FROM parents WHERE id=1')).rows[0][0], 'typed'),
      );
      // Roll back callback and native nested savepoint writes, then reopen from a
      // separate native handle. URL precedence must reach the same persistent file.
      const failureSeed = `import { defineLibsqlSeed } from 'turbine-orm/libsql/seed';
export default defineLibsqlSeed(async tx => { await tx.raw\`INSERT INTO parents VALUES(2,'rollback','b')\`; throw new Error('workflow rollback'); });`;
      writeFileSync(join(dir, 'seed.ts'), failureSeed);
      assert.match(await cli(['seed', '--url', pathToFileURL(file).href], 1), /workflow rollback/);
      await native(file, async (db) => assert.equal((await db.execute('SELECT COUNT(*) FROM parents')).rows[0][0], 1n));
      const seedEffect =
        "import { writeFileSync } from 'node:fs'; writeFileSync('import-effect','bad'); export default async () => {};";
      writeFileSync(join(dir, 'seed.mjs'), seedEffect);
      setConfig({ seedFile: './seed.mjs' });
      // Config unknown/runtime options must survive resolution long enough to be
      // refused, and every refusal must precede seed import and database effects.
      const beforeDb = hash(file);
      const refused = async (
        args,
        pattern = /unsupported|not support|requires|require|takes no|Unknown|Missing|schema|persistent|local|existing|flag|value|argument/i,
      ) => {
        const before = snapshot(dir);
        assert.match(await cli(args, 1), pattern);
        assert.deepEqual(snapshot(dir), before);
        assert.equal(hash(file), beforeDb);
        assert.equal(existsSync(join(dir, 'import-effect')), false);
      };
      for (const command of ['migrate', 'push', 'schema', 'doctor', 'mcp', 'tools']) await refused([command]);
      for (const args of [
        ['seed', '--dry-run'],
        ['seed', '--preview'],
        ['seed', '--yes'],
        ['seed', '--out', './bad'],
        ['seed', '--schema', 'main'],
        ['seed', 'extra'],
        ['seed', '--url'],
        ['seed', '--url', ':memory:'],
        ['seed', '--url', 'file::memory:'],
        ['seed', '--url', 'https://example.invalid/db'],
        ['seed', '--url', 'file:./absent.sqlite'],
        ['seed', '--include', 'parents'],
        ['seed', '--url', relativeUrl, '--url'],
      ])
        await refused(args);
      for (const key of [
        'syncUrl',
        'syncInterval',
        'authToken',
        'encryptionKey',
        'remoteEncryptionKey',
        'offline',
        'replicas',
        'unexpected',
      ]) {
        setConfig({ seedFile: './seed.mjs', [key]: false });
        await refused(['seed']);
      }
      setConfig({ seedFile: './seed.mjs', schema: 'attached' });
      await refused(['seed']);
      setConfig({ seedFile: './seed.mjs', schemaFile: './schema.ts' });
      await refused(['seed']);
      setConfig({ seedFile: './seed.sql' });
      writeFileSync(join(dir, 'seed.sql'), 'SELECT 1;');
      await refused(['seed']);
      // Six real module extensions, canonical/legacy seedFile selection, default
      // discovery and both normalized URL spellings. Each callback writes natively.
      for (const [index, ext] of ['js', 'mjs', 'cjs', 'ts', 'mts', 'cts'].entries()) {
        const id = 10 + index;
        const cjs = ext === 'cjs' || (ext === 'js' && type === 'commonjs');
        const prefix = cjs
          ? "const { defineLibsqlSeed }=require('turbine-orm/libsql/seed'); module.exports="
          : "import { defineLibsqlSeed } from 'turbine-orm/libsql/seed'; export default";
        writeFileSync(
          join(dir, `seed.${ext}`),
          `${prefix} defineLibsqlSeed(async tx=>{await tx.raw\`INSERT INTO parents VALUES(${id},'${ext}','a')\`;});`,
        );
        setConfig(index === 0 ? { seed: `./seed.${ext}` } : { seedFile: `./seed.${ext}` });
        await cli(
          index % 2 ? ['seed', '--url', relativeUrl] : ['seed'],
          0,
          index === 2 ? { DATABASE_URL: pathToFileURL(file).href } : {},
        );
      }
      writeFileSync(join(dir, 'seed.ts'), 'export default async () => {};');
      setConfig();
      await cli(['seed']);
      const seeded = hash(file);
      const status = await cli(['status']);
      assert.match(
        status,
        /Catalog observations only\. Use migrate status for separate read-only migration inspection/,
      );
      assert.match(
        await run(dir, process.execPath, ['--require', forbidCjs, '--experimental-loader', forbidEsm, bin, 'status']),
        /Catalog observations only/,
      );
      assert.doesNotMatch(status, /"hidden"|"report_view"/);
      await cli(['pull', '--no-timestamp']);
      assert.equal(hash(file), seeded);
      await native(file, async (db) => {
        assert.equal((await db.execute('SELECT COUNT(*) FROM parents')).rows[0][0], 7n);
        assert.equal(
          (await db.execute("SELECT name FROM sqlite_master WHERE name LIKE '%turbine%migration%'")).rows.length,
          0,
        );
      });
      // Raw names and default JS ESM/CommonJS consumers are both strict compiled.
      setConfig({ keepColumnNames: true, relationNames: undefined, columnTypes: undefined });
      await cli(['generate', '--no-timestamp']);
      assert.match(readFileSync(typesFile, 'utf8'), /display_name/);
      assert.ok(readFileSync(typesFile, 'utf8').includes("odd'name"));
      writeFileSync(
        join(dir, 'raw.ts'),
        `import { turbine } from './generated/turbine/index.js';
async function main(){const db=await turbine(${JSON.stringify(relativeUrl)},{logger:{},warnOnUnlimited:false});try {
const row=await db.rawRecords.create({data:{"odd'name":"raw"}});const value:string=row["odd'name"];if(value!=="raw")throw new Error('raw name lost');
const p=await db.parents.findFirst();const name:string|undefined=p?.display_name;void name;
}finally{await db.disconnect();}} void main().catch((e:unknown)=>{console.error(e);process.exitCode=1;});`,
      );
      writeFileSync(
        join(dir, 'tsconfig.json'),
        JSON.stringify({ ...tsconfig, include: ['raw.ts', 'generated/**/*.ts'] }),
      );
      await run(dir, process.execPath, [tsc, '-p', 'tsconfig.json']);
      await run(dir, process.execPath, ['compiled/raw.js']);
      // Public read-only migration inspection uses a separate native fixture.
      const inspectionDir = join(dir, 'inspection');
      mkdirSync(inspectionDir);
      const inspectionFile = join(inspectionDir, 'history.sqlite');
      const migrations = join(inspectionDir, 'migrations');
      mkdirSync(migrations);
      writeFileSync(
        join(inspectionDir, 'turbine.config.mjs'),
        configText({ engine: 'libsql', url: 'file:./history.sqlite', migrationsDir: './migrations' }),
      );
      await native(inspectionFile, (db) => db.execute('CREATE TABLE preserved(id INTEGER PRIMARY KEY)'));
      const inspect = (args = ['status'], code = 0) =>
        run(inspectionDir, process.execPath, [bin, 'migrate', ...args], code);
      let beforeInspection = hash(inspectionFile);
      const uninitialized = JSON.parse(await inspect(['status', '--exit-code'], 2));
      assert.equal(uninitialized.historyState, 'uninitialized');
      assert.deepEqual(uninitialized.history, []);
      assert.equal(hash(inspectionFile), beforeInspection);
      await inspect(['up'], 1);
      await inspect(['status', '--step', '1'], 1);
      await inspect(['status', '--url', '--exit-code'], 1);
      assert.equal(hash(inspectionFile), beforeInspection);
      const migrationName = '20260101000000_existing';
      const migrationText =
        '-- UP\nCREATE TABLE must_not_execute(id INTEGER);\n-- DOWN\nDROP TABLE must_not_execute;\n';
      writeFileSync(join(migrations, `${migrationName}.sql`), migrationText);
      const checksum = createHash('sha256').update(migrationText).digest('hex');
      await native(inspectionFile, async (db) => {
        await db.execute(
          'CREATE TABLE _turbine_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)',
        );
        await db.execute({
          sql: 'INSERT INTO _turbine_migrations(name,checksum,applied_at) VALUES (?,?,?)',
          args: [migrationName, checksum, '2026-01-01 00:00:00'],
        });
      });
      beforeInspection = hash(inspectionFile);
      const initialized = JSON.parse(await inspect(['status', '--exit-code']));
      assert.equal(initialized.scope, 'local-read-only');
      assert.equal(initialized.historyState, 'initialized');
      assert.equal(initialized.checksums[0].state, 'sha256-match');
      assert.deepEqual(initialized.problems, []);
      assert.equal(initialized.statuses[0].name, migrationName);
      assert.equal('file' in initialized.statuses[0], false);
      assert.deepEqual(JSON.parse(await inspect(['list'])), initialized);
      writeFileSync(join(migrations, `${migrationName}.sql`), `${migrationText}-- changed\n`);
      assert.equal(JSON.parse(await inspect(['status', '--exit-code'], 2)).checksums[0].state, 'modified');
      rmSync(join(migrations, `${migrationName}.sql`));
      assert.equal(JSON.parse(await inspect(['status', '--exit-code'], 2)).checksums[0].state, 'missing');
      assert.equal(hash(inspectionFile), beforeInspection);
      await native(inspectionFile, async (db) => {
        assert.equal((await db.execute("SELECT name FROM sqlite_schema WHERE name='must_not_execute'")).rows.length, 0);
        await db.execute('ALTER TABLE _turbine_migrations ADD COLUMN noncanonical TEXT');
      });
      const malformed = hash(inspectionFile);
      assert.match(await inspect(['status'], 1), /Invalid local libSQL migration history/);
      assert.equal(hash(inspectionFile), malformed);
      await inspect(['status', '--url', 'file:./missing.sqlite'], 1);
      assert.equal(existsSync(join(inspectionDir, 'missing.sqlite')), false);
      // No fallback is introduced by the CLI or the generated module graph.
      report.matrix.push({
        bin: binIndex === 0 ? 'installed ESM .bin/turbine' : 'installed CJS CLI',
        project: type,
        schema: 'native main catalog',
        generatedStrictConsumer: true,
        typedSeed: true,
        reopen: true,
        rollback: true,
        seedExtensions: ['js', 'mjs', 'cjs', 'ts', 'mts', 'cts'],
        importModes: ['auto', 'js', 'ts', 'none'],
      });
    }
  // Strict import/require of public seed declarations, separately from project
  // module type selection and without any source-tree type roots.
  for (const ext of ['mts', 'cts']) {
    writeFileSync(
      join(consumer, `types.${ext}`),
      `import {defineLibsqlSeed,type LibsqlSeedClient} from 'turbine-orm/libsql/seed';
import type {TransactionClient} from 'turbine-orm';
defineLibsqlSeed(async tx=>{const a:TransactionClient=tx;const b:LibsqlSeedClient=a;void b;
// @ts-expect-error transaction handle has no disconnect
tx.disconnect();});`,
    );
  }
  await run(consumer, process.execPath, [
    join(consumer, 'node_modules/typescript/bin/tsc'),
    '--noEmit',
    '--strict',
    '--skipLibCheck',
    'false',
    '--target',
    'ES2023',
    '--module',
    'NodeNext',
    '--moduleResolution',
    'NodeNext',
    'types.mts',
    'types.cts',
  ]);
}
