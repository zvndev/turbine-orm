import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateIndex, generateMetadata, generateTypes } from '../generate.js';
import type { SchemaMetadata } from '../schema.js';
import { defineSchema } from '../schema-builder.js';
import { schemaDefToMetadata } from '../schema-metadata.js';
import { schemaToSQL } from '../schema-sql.js';
import { introspectSqliteDatabase, sqliteDialect } from '../sqlite.js';
import { skipGate } from './helpers.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const tsc = join(repo, 'node_modules/.bin/tsc');
const example = join(repo, 'examples/sqlite-generated');
// Load the example as a fixture without adding examples/ to the library's rootDir.
const { tables } = (await import(pathToFileURL(join(example, 'schema.ts')).href)) as {
  tables: Parameters<typeof defineSchema>[0];
};
const codeFirst = schemaDefToMetadata(defineSchema(tables));
const DatabaseSync: typeof DatabaseSyncType | undefined = (() => {
  try {
    return createRequire(import.meta.url)('node:sqlite').DatabaseSync;
  } catch {
    return undefined;
  }
})();
const sqlite = skipGate(!DatabaseSync, 'SQLite generation runtime requires node:sqlite (Node >= 22.5)');

function run(command: string, args: string[]): { status: number | null; output: string } {
  const result = spawnSync(command, args, { cwd: repo, encoding: 'utf8', timeout: 120_000 });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}\n${result.error ?? ''}` };
}

function writeGenerated(dir: string, schema: SchemaMetadata): void {
  mkdirSync(dir, { recursive: true });
  const options = { target: 'sqlite', noTimestamp: true } as const;
  writeFileSync(join(dir, 'index.ts'), generateIndex(schema, options));
  writeFileSync(join(dir, 'types.ts'), generateTypes(schema, options));
  writeFileSync(join(dir, 'metadata.ts'), generateMetadata(schema, options));
}

function sourceConfig(dir: string): void {
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        target: 'ES2023',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        typeRoots: [join(repo, 'node_modules/@types')],
        types: ['node'],
        paths: {
          'turbine-orm': [join(repo, 'src/index.ts')],
          'turbine-orm/sqlite': [join(repo, 'src/sqlite.ts')],
        },
      },
      include: ['**/*.ts', join(repo, 'types/**/*.d.ts')],
    }),
  );
}

const VALID = `
import { turbine } from './generated/index.js';
import type { TagCreate } from './generated/types.js';
const db = turbine(':memory:', { foreignKeys: true, busyTimeoutMs: 100, logger: {},
  globalFilters: { users: { email: { contains: '@' } } } });
const tag: TagCreate = { slug: 'ts', label: 'TypeScript' };
void db.tags.create({ data: tag });
void db.users.create({ data: { email: 'a@b.test', displayName: 'A',
  posts: { create: { title: 'Post', comments: { create: { body: 'Comment' } } } } } });
async function reads(): Promise<string> {
  const rows = await db.users.findMany({ select: { email: true }, with: {
    posts: { with: { comments: true, user: true } } } });
  const body: string | undefined = rows[0]?.posts[0]?.comments[0]?.body;
  const name: string | undefined = rows[0]?.posts[0]?.user.displayName;
  const primary: string | undefined = (await db.$primary().users.findFirst())?.email;
  const [users, count] = await db.$transaction([db.users.buildFindMany(), db.posts.buildCount()]);
  const n: number = count;
  const email: string | undefined = users[0]?.email;
  return body ?? name ?? primary ?? email ?? String(n);
}
void reads;
void db.$transaction(async (tx) => {
  await tx.users.update({ where: { id: 1 }, data: { displayName: 'B' } });
  return tx.$transaction(async (inner) => {
    const user = await inner.users.findUnique({ where: { email: 'a@b.test' }, with: { posts: true } });
    const title: string | undefined = user?.posts[0]?.title;
    return title;
  });
});
// View contracts reuse the ordinary generator's accessor rules.
void db.postSummaries.findMany();
`;

const INVALID = [
  "db.users.findMany({ where: { emali: 'typo' } });",
  'db.users.findMany({ with: { missingRelation: true } });',
  'db.users.findMany({ with: { posts: { with: { missingRelation: true } } } });',
  'db.users.findMany({ select: { missingColumn: true } });',
  "db.users.create({ data: { displayName: 'missing email' } });",
  "db.posts.create({ data: { title: 'missing required foreign key' } });",
  "db.posts.create({ data: { userId: 1, title: 'x', comments: { create: { body: 123 } } } });",
  "db.posts.update({ where: { id: 1 }, data: { score: 'wrong scalar type' } });",
  "db.tags.create({ data: { label: 'missing natural primary key' } });",
  "db.postSummaries.findUnique({ where: { title: 'view has no unique key' } });",
  "turbine(':memory:', { connectionString: 'postgres://invalid' });",
  "turbine(':memory:', { pool: {} });",
  "turbine(':memory:', { host: 'localhost', poolSize: 10 });",
  "turbine(':memory:', { replicas: [] });",
  "turbine(':memory:', { globalFilters: { usres: { email: 'wrong table' } } });",
  "turbine(':memory:', { globalFilters: { users: { emali: 'wrong column' } } });",
  "db.$transaction(async (tx) => { await tx.users.create({ data: { email: 123, displayName: 'bad' } }); });",
  'db.$transaction(async (tx) => tx.$transaction(async (inner) => { await inner.posts.findMany({ where: { missingColumn: 1 } }); }));',
  'db.users.findMany({ select: { email: true } }).then((rows) => rows[0]!.displayName);',
];

function withView(schema: SchemaMetadata): SchemaMetadata {
  const view = schemaDefToMetadata(defineSchema({ postSummaries: { title: { type: 'text', notNull: true } } }));
  view.tables.post_summaries!.isView = true;
  return { ...schema, tables: { ...schema.tables, ...view.tables } };
}

function compilerChecks(schema: SchemaMetadata, checkNaturalKey: boolean): void {
  const dir = mkdtempSync(join(tmpdir(), 'turbine-sqlite-types-'));
  try {
    writeGenerated(join(dir, 'generated'), withView(schema));
    sourceConfig(dir);
    const invalid = INVALID.filter((s) => checkNaturalKey || !s.includes('missing natural primary key'));
    // The example DDL has a TEXT PRIMARY KEY without NOT NULL. On an ordinary
    // SQLite rowid table that key really is nullable, so omission is valid.
    const nullableKey = checkNaturalKey ? '' : "void db.tags.create({ data: { label: 'nullable native key' } });";
    const usage = `${VALID}\n${nullableKey}\n${invalid.map((s) => `// @ts-expect-error intentional invalid consumer\n${s}`).join('\n')}\n`;
    writeFileSync(join(dir, 'usage.ts'), usage);
    const valid = run(tsc, ['-p', dir]);
    assert.equal(valid.status, 0, valid.output);
    // Remove only the suppression markers, keeping line numbers. Each invalid
    // call must now produce its OWN real compiler diagnostic (negative control).
    writeFileSync(join(dir, 'usage.ts'), usage.replaceAll('// @ts-expect-error intentional invalid consumer', ''));
    const broken = run(tsc, ['-p', dir]);
    assert.notEqual(broken.status, 0, 'invalid consumer unexpectedly compiled');
    for (const statement of invalid) {
      const line = usage.slice(0, usage.indexOf(statement)).split('\n').length;
      assert.ok(broken.output.includes(`usage.ts(${line},`), `No diagnostic for ${statement}\n${broken.output}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function introspected(): SchemaMetadata {
  const handle = new DatabaseSync!(':memory:');
  try {
    for (const statement of schemaToSQL(defineSchema(tables), { dialect: sqliteDialect })) handle.exec(statement);
    const schema = introspectSqliteDatabase(handle, { logger: {} });
    assert.equal(Object.keys(schema.tables).length, 4);
    assert.ok(schema.tables.users!.relations.posts);
    assert.ok(schema.tables.posts!.relations.user);
    // Re-reading the same catalog must give byte-identical generated source.
    const again = introspectSqliteDatabase(handle, { logger: {} });
    for (const emitter of [generateIndex, generateTypes, generateMetadata]) {
      const options = { target: 'sqlite', noTimestamp: true } as const;
      assert.equal(emitter(schema, options), emitter(again, options));
    }
    return schema;
  } finally {
    handle.close();
  }
}

describe('generated SQLite consumer diagnostics', () => {
  it('allows a DatabaseSync entity alongside the native SQLite handle type', () => {
    const dir = mkdtempSync(join(tmpdir(), 'turbine-sqlite-name-collision-'));
    try {
      writeGenerated(
        join(dir, 'generated'),
        schemaDefToMetadata(
          defineSchema({
            databaseSyncs: {
              id: { type: 'serial', primaryKey: true },
              label: { type: 'text', notNull: true },
            },
          }),
        ),
      );
      sourceConfig(dir);
      writeFileSync(
        join(dir, 'usage.ts'),
        `
import { DatabaseSync as NativeHandle } from 'node:sqlite';
import { turbine } from './generated/index.js';
import type { DatabaseSync } from './generated/types.js';
const db = turbine(new NativeHandle(':memory:'));
const created: Promise<DatabaseSync> = db.databaseSyncs.create({ data: { label: 'sync' } });
void created;
`,
      );
      const compiled = run(tsc, ['-p', dir]);
      assert.equal(compiled.status, 0, compiled.output);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('checks code-first nested inputs, projections, callbacks, views and engine-specific options', () => {
    compilerChecks(codeFirst, true);
  });
  sqlite.it('checks the same contracts using real SQLite catalog metadata', () => {
    compilerChecks(introspected(), false);
  });
});

// Build into a private temporary package, never shared dist/. Native Node then
// loads tsc's ESM/CJS output without tsx, bundling, or a custom loader.
describe('generated SQLite native modules', () => {
  sqlite.it('loads and uses code-first and introspected clients in native ESM and CJS', () => {
    const dir = mkdtempSync(join(tmpdir(), 'turbine-sqlite-native-'));
    try {
      const pkg = join(dir, 'node_modules/turbine-orm');
      mkdirSync(pkg, { recursive: true });
      symlinkSync(join(repo, 'node_modules'), join(pkg, 'node_modules'), 'dir');
      writeFileSync(
        join(pkg, 'package.json'),
        JSON.stringify({
          name: 'turbine-orm',
          type: 'module',
          imports: { '#pg': 'pg' },
          exports: {
            '.': { import: './esm/index.js', require: './cjs/index.js' },
            './sqlite': { import: './esm/sqlite.js', require: './cjs/sqlite.js' },
          },
        }),
      );
      for (const format of ['esm', 'cjs'] as const) {
        const lib = join(pkg, format);
        const built = run(tsc, [
          '-p',
          join(repo, format === 'esm' ? 'tsconfig.json' : 'tsconfig.cjs.json'),
          '--outDir',
          lib,
        ]);
        assert.equal(built.status, 0, built.output);
        if (format === 'cjs') {
          writeFileSync(join(lib, 'package.json'), JSON.stringify({ type: 'commonjs', imports: { '#pg': 'pg' } }));
        }
        for (const [name, metadata] of [
          ['code-first', codeFirst],
          ['introspected', introspected()],
        ] as const) {
          const consumer = join(dir, `${format}-${name}`);
          writeGenerated(join(consumer, 'generated'), metadata);
          copyFileSync(join(example, 'app.ts'), join(consumer, 'app.ts'));
          copyFileSync(join(example, 'generate.ts'), join(consumer, 'generate.ts'));
          copyFileSync(join(example, 'schema.ts'), join(consumer, 'schema.ts'));
          writeFileSync(
            join(consumer, 'package.json'),
            JSON.stringify({ type: format === 'esm' ? 'module' : 'commonjs' }),
          );
          writeFileSync(
            join(consumer, 'tsconfig.json'),
            JSON.stringify({
              compilerOptions: {
                target: 'ES2023',
                module: 'NodeNext',
                moduleResolution: 'NodeNext',
                strict: true,
                exactOptionalPropertyTypes: true,
                types: ['node'],
                skipLibCheck: true,
                outDir: './out',
                typeRoots: [join(repo, 'node_modules/@types')],
              },
              include: ['**/*.ts'],
            }),
          );
          const compiled = run(tsc, ['-p', consumer]);
          assert.equal(compiled.status, 0, compiled.output);
          const result = run(process.execPath, [join(consumer, 'out/app.js')]);
          assert.equal(result.status, 0, `${format}/${name}: ${result.output}`);
          assert.match(result.output, /SQLite generated client: nested reads\/writes.*passed/);
          const javascript = readFileSync(join(consumer, 'out/generated/index.js'), 'utf8');
          assert.ok(
            javascript.includes(format === 'esm' ? 'import { turbineSqlite }' : 'require("turbine-orm/sqlite")'),
          );
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
