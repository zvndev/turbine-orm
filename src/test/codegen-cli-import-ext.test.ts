/**
 * `generate --import-ext ts`: sibling imports that Node's native type stripping
 * can resolve.
 *
 * `./types.js` names a file that does not exist on disk (only `types.ts` does),
 * so `node app.ts` over a generated client died on the first import. With the
 * `ts` mode the specifiers name the real files. `auto` never picks it, because a
 * type checker needs `allowImportingTsExtensions` to accept the result.
 *
 * Three layers: the emitted specifiers, a run of the generated files by Node
 * itself against a stub `turbine-orm` (needs Node 22.6+, no database, no build),
 * and a run against the real library and a live database (needs DATABASE_URL and
 * a built `dist/`). The `.js` mode is run the same way as the negative control,
 * so a green result means the run could tell the two apart.
 *
 * Run: DATABASE_URL=... npx tsx --test src/test/codegen-cli-import-ext.test.ts
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import { generateIndex, generateMetadata, generateTypes } from '../generate.js';
import type { ColumnMetadata, SchemaMetadata, TableMetadata } from '../schema.js';
import { makeProject, type Project, REPO_ROOT } from './codegen-cli-fixture.js';
import { skipGate } from './helpers.js';

function column(name: string, extra: Partial<ColumnMetadata> = {}): ColumnMetadata {
  return {
    name,
    field: name,
    pgType: 'text',
    tsType: 'string',
    nullable: false,
    hasDefault: false,
    isArray: false,
    pgArrayType: 'text[]',
    ...extra,
  };
}

const THINGS: TableMetadata = {
  name: 'things',
  columns: [column('id', { pgType: 'int4', tsType: 'number', hasDefault: true }), column('title')],
  columnMap: { id: 'id', title: 'title' },
  reverseColumnMap: { id: 'id', title: 'title' },
  dateColumns: new Set<string>(),
  pgTypes: { id: 'int4', title: 'text' },
  allColumns: ['id', 'title'],
  primaryKey: ['id'],
  uniqueColumns: [],
  indexes: [],
  isView: false,
  relations: {},
};
const SCHEMA: SchemaMetadata = { enums: {}, tables: { things: THINGS } };

/** Every relative specifier (`from './x'` or `from "./x"`) in a source file. */
function relativeSpecifiers(source: string): string[] {
  return [...source.matchAll(/from\s+['"](\.\.?\/[^'"]+)['"]/g)].map((m) => m[1]!);
}

describe('generated sibling imports follow the import extension', () => {
  const files = (importExt: string, importMode: string) => ({
    'index.ts': generateIndex(SCHEMA, { noTimestamp: true, importExt, importMode }),
    'metadata.ts': generateMetadata(SCHEMA, { noTimestamp: true, importExt, importMode }),
    'types.ts': generateTypes(SCHEMA, { noTimestamp: true, importExt, importMode }),
  });

  it('ts mode names the .ts files', () => {
    const specifiers = Object.values(files('.ts', 'ts')).flatMap(relativeSpecifiers);
    assert.ok(specifiers.length >= 2, `expected sibling imports, found ${JSON.stringify(specifiers)}`);
    assert.deepEqual(
      specifiers.filter((s) => !s.endsWith('.ts')),
      [],
      `a specifier does not end in .ts: ${JSON.stringify(specifiers)}`,
    );
  });

  it('js mode names .js and none mode names no extension', () => {
    const js = Object.values(files('.js', 'js')).flatMap(relativeSpecifiers);
    assert.ok(js.length >= 2 && js.every((s) => s.endsWith('.js')), JSON.stringify(js));
    const none = Object.values(files('', 'none')).flatMap(relativeSpecifiers);
    assert.ok(none.length >= 2 && none.every((s) => !/\.(js|ts)$/.test(s)), JSON.stringify(none));
  });
});

// ---------------------------------------------------------------------------
// Node's own type stripping
// ---------------------------------------------------------------------------

const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
const nodeStripsTypes = major > 22 || (major === 22 && minor >= 6);

/**
 * `it`, skipping every test with `reason` when one is given. For preconditions
 * that are not a database engine (a Node version, a built `dist/`): no
 * `TURBINE_REQUIRE_ENGINE` job can claim them, so they stay out of `skipGate`,
 * which is for engine availability only.
 */
function itUnless(base: typeof it, reason: string | undefined): typeof it {
  if (reason === undefined) return base;
  return ((name: string) => base(name, { skip: reason }, () => {})) as typeof it;
}

const strip = {
  it: itUnless(
    it,
    nodeStripsTypes ? undefined : `needs Node 22.6+ for native type stripping (running ${process.versions.node})`,
  ),
};

/** Run `app.ts` with Node's type stripping on. Warnings are noise, so they go to stderr only. */
function runStripped(cwd: string, env: Record<string, string> = {}) {
  const { NODE_TEST_CONTEXT: _omit, ...inherited } = process.env;
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'app.ts'], {
    cwd,
    encoding: 'utf-8',
    timeout: 120_000,
    env: { ...inherited, ...env },
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('Node runs a generated client directly (stub library, no database)', () => {
  let dir = '';

  /** Write the generated client for `importExt` plus a stub `turbine-orm` and an entry file. */
  function build(importExt: string, importMode: string) {
    rmSync(join(dir, 'generated'), { recursive: true, force: true });
    mkdirSync(join(dir, 'generated'), { recursive: true });
    const options = { noTimestamp: true, importExt, importMode };
    writeFileSync(join(dir, 'generated', 'types.ts'), generateTypes(SCHEMA, options));
    writeFileSync(join(dir, 'generated', 'metadata.ts'), generateMetadata(SCHEMA, options));
    writeFileSync(join(dir, 'generated', 'index.ts'), generateIndex(SCHEMA, options));
    writeFileSync(
      join(dir, 'app.ts'),
      [
        `import { turbine, SCHEMA } from './generated/index${importExt}';`,
        `const db = turbine({ connectionString: 'postgres://stub' });`,
        `console.log(JSON.stringify({ tables: Object.keys(SCHEMA.tables), client: db.constructor.name }));`,
        '',
      ].join('\n'),
    );
  }

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'turbine-import-ext-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'import-ext', type: 'module', private: true }));
    mkdirSync(join(dir, 'node_modules', 'turbine-orm'), { recursive: true });
    writeFileSync(
      join(dir, 'node_modules', 'turbine-orm', 'package.json'),
      JSON.stringify({ name: 'turbine-orm', type: 'module', exports: './index.js' }),
    );
    writeFileSync(
      join(dir, 'node_modules', 'turbine-orm', 'index.js'),
      [
        'export class TurbineClient { constructor(config, schema) { this.config = config; this.schema = schema; } }',
        'export class TransactionClient {}',
        'export class QueryInterface {}',
        '',
      ].join('\n'),
    );
  });

  after(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  strip.it('ts mode: node runs the generated index.ts, declare fields and all', () => {
    build('.ts', 'ts');
    const run = runStripped(dir);
    assert.equal(run.status, 0, `node could not run the ts-mode client:\n${run.stderr}`);
    assert.deepEqual(JSON.parse(run.stdout), { tables: ['things'], client: 'TurbineClient' });
  });

  strip.it('control: js mode cannot be run that way, so the run above tells the modes apart', () => {
    build('.js', 'js');
    // app.ts cannot import './generated/index.js' either, so point it at the .ts entry
    // and let the generated file's own './metadata.js' import be the thing that fails.
    writeFileSync(
      join(dir, 'app.ts'),
      `import { turbine } from './generated/index.ts';\nconsole.log(typeof turbine);\n`,
    );
    const run = runStripped(dir);
    assert.notEqual(run.status, 0, `the js-mode client ran unexpectedly:\n${run.stdout}`);
    assert.match(run.stderr, /ERR_MODULE_NOT_FOUND|Cannot find module/);
  });
});

// ---------------------------------------------------------------------------
// The real library and a live database
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
const built = existsSync(join(REPO_ROOT, 'dist', 'index.js'));
const database = skipGate(!DATABASE_URL, 'requires DATABASE_URL');
const real = {
  it: itUnless(
    database.it,
    !built
      ? 'requires a built dist/ (npm run build)'
      : nodeStripsTypes
        ? undefined
        : `needs Node 22.6+ (running ${process.versions.node})`,
  ),
};

describe('Node runs a generated client against the real library and a database', () => {
  const table = `cgcli_ext_${process.pid}_${Date.now().toString(36)}`;
  let pool: pg.Pool;
  let project: Project;

  before(async () => {
    if (!DATABASE_URL || !built || !nodeStripsTypes) return;
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    await pool.query(`CREATE TABLE "${table}" (id serial PRIMARY KEY, title text NOT NULL)`);
    await pool.query(`INSERT INTO "${table}" (title) VALUES ('first'), ('second')`);
    project = makeProject('import-ext-real', { databaseUrl: DATABASE_URL });
    symlinkSync(REPO_ROOT, join(project.dir, 'node_modules', 'turbine-orm'));
    project.write('turbine.config.js', `export default { include: [${JSON.stringify(table)}] };\n`);
  });

  after(async () => {
    if (!pool) return;
    await pool.query(`DROP TABLE IF EXISTS "${table}"`);
    await pool.end();
    project?.cleanup();
  });

  real.it('generate --import-ext ts writes .ts specifiers and node runs the client', () => {
    const generated = project.cli(['generate', '--import-ext', 'ts', '--out', './generated/turbine', '--no-timestamp']);
    assert.equal(generated.status, 0, generated.output);
    assert.match(generated.output, /Node type stripping/);
    const index = readFileSync(join(project.dir, 'generated', 'turbine', 'index.ts'), 'utf-8');
    assert.deepEqual(
      relativeSpecifiers(index).filter((s) => !s.endsWith('.ts')),
      [],
    );
    project.write(
      'app.ts',
      [
        `import { turbine } from './generated/turbine/index.ts';`,
        `const db = turbine({ connectionString: process.env.DATABASE_URL });`,
        `const rows = await db.table(${JSON.stringify(table)}).findMany({ orderBy: { id: 'asc' }, limit: 10 });`,
        `console.log(JSON.stringify(rows.map((r) => r.title)));`,
        `await db.disconnect();`,
        '',
      ].join('\n'),
    );
    const run = runStripped(project.dir, { DATABASE_URL: DATABASE_URL! });
    assert.equal(run.status, 0, `node could not run the generated client:\n${run.stderr}`);
    assert.deepEqual(JSON.parse(run.stdout.trim().split('\n').pop()!), ['first', 'second']);
  });

  real.it('generate with the default mode keeps .js specifiers', () => {
    const generated = project.cli(['generate', '--out', './generated/default', '--no-timestamp']);
    assert.equal(generated.status, 0, generated.output);
    const index = readFileSync(join(project.dir, 'generated', 'default', 'index.ts'), 'utf-8');
    const specifiers = relativeSpecifiers(index);
    assert.ok(specifiers.length > 0 && specifiers.every((s) => s.endsWith('.js')), JSON.stringify(specifiers));
  });
});
