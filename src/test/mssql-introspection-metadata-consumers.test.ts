/** Generated package consumers; catalog fixtures are not native-service evidence. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { generateIndex, generateMetadata, generateTypes } from '../generate.js';
import { introspectMssqlWith } from '../mssql.js';
import { catalogFixture } from './fixtures/mssql-introspection-metadata.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
it('checks generated SQL Server metadata in strict ESM/CJS package consumers with per-input negative controls', {
  timeout: 180_000,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'turbine-mssql-metadata-consumers-'));
  const run = (command: string, args: string[], cwd = dir) => {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 60_000 });
    return { status: result.status, output: `${result.stdout}\n${result.stderr}\n${result.error ?? ''}` };
  };
  const ok = (command: string, args: string[], cwd?: string) => {
    const result = run(command, args, cwd);
    assert.equal(result.status, 0, result.output);
  };
  const tsc = join(repo, 'node_modules/.bin/tsc');
  try {
    const staging = join(dir, 'staging');
    mkdirSync(staging);
    const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
    delete manifest.scripts;
    writeFileSync(join(staging, 'package.json'), JSON.stringify(manifest));
    for (const format of ['esm', 'cjs'])
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
    mkdirSync(join(staging, 'scripts'));
    copyFileSync(join(repo, 'scripts/finish-cjs-build.mjs'), join(staging, 'scripts/finish-cjs-build.mjs'));
    ok(process.execPath, [join(staging, 'scripts/finish-cjs-build.mjs')], staging);
    const dependencies = join(dir, 'node_modules');
    mkdirSync(dependencies);
    symlinkSync(staging, join(dependencies, 'turbine-orm'), 'dir');
    symlinkSync(join(repo, 'node_modules'), join(staging, 'node_modules'), 'dir');
    symlinkSync(join(repo, 'node_modules/pg'), join(dependencies, 'pg'), 'dir');
    const schema = await introspectMssqlWith(catalogFixture().exec, 'app', { logger: {} });
    for (const type of ['module', 'commonjs']) {
      const consumer = join(dir, type);
      mkdirSync(join(consumer, 'generated'), { recursive: true });
      writeFileSync(join(consumer, 'package.json'), JSON.stringify({ type }));
      for (const [name, emitter] of [
        ['index', generateIndex],
        ['metadata', generateMetadata],
        ['types', generateTypes],
      ] as const)
        writeFileSync(
          join(consumer, 'generated', `${name}.ts`),
          emitter(schema, { target: 'mssql', noTimestamp: true }),
        );
      const valid = `import assert from 'node:assert/strict';
import { turbine } from './generated/index.js';
import { SCHEMA } from './generated/metadata.js';
import { mssqlDialect } from 'turbine-orm/mssql';
import { QueryInterface } from 'turbine-orm';
assert.equal(SCHEMA.tables.generated_records!.columns.find(c => c.name === 'virtual_total')!.isGeneratedStored, true);
assert.equal(SCHEMA.tables.parents!.relations.profile!.type, 'hasOne');
const query = new QueryInterface(null!, 'generated_records', SCHEMA, undefined, { dialect: mssqlDialect });
assert.throws(() => query.buildCreate({ data: { quantity: 4, virtualTotal: 8 } }), /generated/i);
const filtered = new QueryInterface(null!, 'filtered_profiles', SCHEMA, undefined, { dialect: mssqlDialect });
assert.throws(() => filtered.buildFindUnique({ where: { parentId_scope: { parentId: 1, scope: 0 } } }), /unique|Unknown/i);
async function consumer() {
  const db = await turbine('mssql://localhost/disposable', { logger: {} });
  void db.generatedRecords.create({ data: { quantity: 4 } });
  void db.mandatoryKeys.create({ data: { code: 'required' } });
  void db.compositeLinks.create({ data: { tenantId: 1, code: 'a' } });
  void db.compositeUniqueLinks.findUnique({ where: { code_tenantId: { code: 'a', tenantId: 1 } } });
  void db.supersetProfiles.findUnique({ where: { parentId_scope: { parentId: 1, scope: 0 } } });
  const p = await db.parents.findFirst({ with: { profile: true, filteredProfiles: true } });
  const one: number | undefined = p?.profile?.id;
  const many: number | undefined = p?.filteredProfiles[0]?.id;
  const c = await db.compositeParents.findFirst({ with: { compositeLink: true } });
  const code: string | undefined = c?.compositeLink?.code;
  return { db, p, one, many, code };
}
void consumer;
`;
      const invalid = [
        'db.mandatoryKeys.create({ data: {} });',
        'db.generatedRecords.create({ data: {} });',
        'db.generatedRecords.create({ data: { quantity: 4, virtualTotal: 8 } });',
        'db.generatedRecords.update({ where: { id: 1 }, data: { storedTotal: 8 } });',
        'db.generatedRecords.update({ where: { id: 1 }, data: { version: new Uint8Array() } });',
        "db.compositeLinks.create({ data: { code: 'a' } });",
        'db.filteredProfiles.findUnique({ where: { parentId_scope: { parentId: 1, scope: 0 } } });',
        'db.computedProfiles.findUnique({ where: { parentId_normalized: { parentId: 1, normalized: 0 } } });',
        'db.parents.findFirst({ with: { profile: true } }).then(p => p?.profile?.[0]);',
        'db.parents.findFirst({ with: { filteredProfiles: true } }).then(p => p?.filteredProfiles?.id);',
      ];
      const prelude = `async function invalidInputs() { const { db } = await consumer();\n`;
      const usage =
        valid +
        prelude +
        invalid.map((s) => `// @ts-expect-error invalid metadata input\n${s}\n`).join('') +
        '}\nvoid invalidInputs;\n';
      writeFileSync(join(consumer, 'usage.ts'), usage);
      writeFileSync(
        join(consumer, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2023',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            strict: true,
            skipLibCheck: false,
            types: ['node'],
            typeRoots: [join(repo, 'node_modules/@types')],
            outDir: './out',
          },
          include: ['usage.ts', 'generated/**/*.ts'],
        }),
      );
      ok(tsc, ['-p', consumer]);
      ok(process.execPath, [join(consumer, 'out/usage.js')]);
      const rendered = readFileSync(join(consumer, 'out/generated/index.js'), 'utf8');
      assert.ok(rendered.includes(type === 'module' ? 'import { turbineMssql }' : 'require("turbine-orm/mssql")'));
      writeFileSync(join(consumer, 'usage.ts'), usage.replaceAll('// @ts-expect-error invalid metadata input', ''));
      const broken = run(tsc, ['-p', consumer, '--noEmit']);
      assert.notEqual(broken.status, 0, 'invalid metadata inputs unexpectedly compiled');
      for (const statement of invalid) {
        const line = usage.slice(0, usage.lastIndexOf(statement)).split('\n').length;
        assert.ok(broken.output.includes(`usage.ts(${line},`), `Missing diagnostic for ${statement}\n${broken.output}`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
