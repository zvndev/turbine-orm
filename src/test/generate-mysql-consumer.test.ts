/** Real packed modules and compiler diagnostics; injected transport tests are not service certification. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { generateIndex, generateMetadata, generateTypes } from '../generate.js';
import { defineSchema } from '../schema-builder.js';
import { schemaDefToMetadata } from '../schema-metadata.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const tsc = join(repo, 'node_modules/.bin/tsc');
const metadata = schemaDefToMetadata(
  defineSchema({
    users: {
      id: { type: 'serial', primaryKey: true },
      email: { type: 'text', notNull: true, unique: true },
      settings: { type: 'jsonb' },
    },
    posts: {
      id: { type: 'serial', primaryKey: true },
      userId: { type: 'integer', notNull: true, references: 'users.id' },
      title: { type: 'text', notNull: true },
    },
  }),
);
const invalid = [
  'pending.users.findMany();',
  "turbine('mysql://localhost/app', { connectionLimit: 'two' });",
  "turbine('mysql://localhost/app', { poolSize: 2 });",
  "turbine('mysql://localhost/app', { foreignKeys: true });",
  "turbine('mysql://localhost/app', { globalFilters: { usres: { email: 'x' } } });",
  "turbine('mysql://localhost/app', { globalFilters: { users: { emali: 'x' } } });",
  "db.users.findMany({ where: { emali: 'x' } });",
  'db.users.findMany({ select: { missing: true } });',
  'db.users.findMany({ with: { missing: true } });',
  "db.users.create({ data: { settings: { theme: 'x' } } });",
  'db.posts.create({ data: { title: 1, userId: 7 } });',
  'db.$transaction(async (tx) => tx.posts.create({ data: { title: 1, userId: 7 } }));',
  "db.$transaction(async (tx) => tx.$transaction(async (inner) => inner.posts.findMany({ where: { missing: 'x' } })));",
];

function run(command: string, args: string[], cwd = repo) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 120_000 });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}\n${result.error ?? ''}` };
}
function checked(command: string, args: string[], cwd = repo): string {
  const result = run(command, args, cwd);
  assert.equal(result.status, 0, result.output);
  return result.output;
}

// These rows and captured calls test the emitted wrapper against the actual
// packed engine. Native mysql2 binding/catalog behavior has a separate live gate.
const usage = `
import assert from 'node:assert/strict';
import { turbine } from './generated/index.js';
import { MysqlPool } from 'turbine-orm/mysql';
const sent: string[] = [];
let ends = 0;
const pool = {
  async query(sql: string, values?: unknown): Promise<[unknown, unknown]> {
    if (sql === 'SELECT VERSION() AS v') return [[{ v: '8.0.40' }], []];
    sent.push(sql);
    return [[{ id: 7, email: 'a@b.test', settings: { theme: 'dark' } }], []];
  },
  async execute(sql: string, values?: unknown): Promise<[unknown, unknown]> { return this.query(sql, values); },
  async getConnection() { return { ...this, release() {} }; },
  async end() { ends++; },
};
const pending = turbine(pool, { connectionLimit: 2, logger: {},
  globalFilters: { users: { email: { contains: '@' } } } });
async function main() {
  assert.ok(pending instanceof Promise);
  const db = await pending;
  const rows = await db.users.findMany({ select: { email: true }, where: { email: 'a@b.test' } });
  const email: string | undefined = rows[0]?.email;
  assert.equal(email, 'a@b.test');
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /SELECT/);
  assert.match(sent[0]!, /:p1/);
  assert.doesNotMatch(sent[0]!, /\\$1/);
  const operations = async () => {
    void turbine({ host: 'localhost', port: 3306, user: 'test', password: 'test', database: 'app' }, { connectionLimit: 2 });
    void turbine(new MysqlPool(pool), { connectionLimit: 2 });
    await db.users.create({ data: { email: 'x', settings: { theme: 'light' }, posts: { create: { title: 'post' } } } });
    await db.$transaction(async (tx) => {
      const result = await tx.users.findMany({ with: { posts: true } });
      const title: string | undefined = result[0]?.posts[0]?.title;
      return tx.$transaction(async (inner) => inner.posts.update({ where: { id: 1 }, data: { title: title ?? 'x' } }));
    });
    const [rows, count] = await db.$transaction([db.users.buildFindMany(), db.posts.buildCount()]);
    const n: number = count;
    void rows; void n;
  };
  void operations;
  await db.disconnect();
  assert.equal(ends, 0, 'borrowed pools must not be closed');
  console.log('packed MySQL generated wrapper passed');
}
void main();
`;

describe('MySQL packed generated consumers', () => {
  it('compiles strict ESM/CJS native options and async types, executes the packed wrapper, and rejects invalid consumers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'turbine-mysql-packed-'));
    try {
      const pkg = join(dir, 'package');
      mkdirSync(join(pkg, 'scripts'), { recursive: true });
      // Use the real exports map and build-finishing script in a private package.
      for (const file of ['package.json', 'README.md', 'LICENSE', 'scripts/finish-cjs-build.mjs']) {
        copyFileSync(join(repo, file), join(pkg, file));
      }
      // npm 10 can run prepare during directory packing even with --ignore-scripts.
      // This private staging package has built artifacts, not the checkout lifecycle.
      const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
      delete manifest.scripts;
      writeFileSync(join(pkg, 'package.json'), JSON.stringify(manifest));
      checked(tsc, ['-p', join(repo, 'tsconfig.json'), '--outDir', join(pkg, 'dist')]);
      checked(tsc, ['-p', join(repo, 'tsconfig.cjs.json'), '--outDir', join(pkg, 'dist/cjs')]);
      checked(process.execPath, [join(pkg, 'scripts/finish-cjs-build.mjs')]);
      checked('npm', ['pack', '--ignore-scripts', '--pack-destination', dir], pkg);
      const archive = join(
        dir,
        `turbine-orm-${JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version}.tgz`,
      );
      const install = join(dir, 'consumer');
      mkdirSync(install);
      writeFileSync(join(install, 'package.json'), '{"private":true}');
      checked(
        'npm',
        ['install', '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund', '--no-package-lock', archive],
        install,
      );
      for (const format of ['module', 'commonjs']) {
        const consumer = join(install, format);
        mkdirSync(join(consumer, 'generated'), { recursive: true });
        writeFileSync(join(consumer, 'package.json'), JSON.stringify({ type: format }));
        const options = {
          target: 'mysql',
          noTimestamp: true,
          columnTypes: { 'users.settings': '{ theme: string }' },
        } as const;
        for (const [file, emitter] of [
          ['index', generateIndex],
          ['types', generateTypes],
          ['metadata', generateMetadata],
        ] as const) {
          writeFileSync(join(consumer, `generated/${file}.ts`), emitter(metadata, options));
        }
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
              outDir: './out',
              typeRoots: [join(repo, 'node_modules/@types')],
              types: ['node'],
            },
            include: ['**/*.ts'],
            exclude: ['out'],
          }),
        );
        writeFileSync(join(consumer, 'app.ts'), usage);
        checked(tsc, ['-p', consumer]);
        const result = checked(process.execPath, [join(consumer, 'out/app.js')], consumer);
        assert.match(result, /packed MySQL generated wrapper passed/);
        // Suppress each deliberate error once, then remove the suppressions and
        // require a diagnostic on every same source line as a negative control.
        const brokenUsage = `import { turbine } from './generated/index.js';
const pending = turbine('mysql://localhost/app');
async function invalidCalls() {
const db = await pending;
${invalid.map((line) => `// @ts-expect-error intentional invalid consumer\n${line}`).join('\n')}
}
void invalidCalls;
`;
        const path = join(consumer, 'invalid.ts');
        writeFileSync(path, brokenUsage);
        checked(tsc, ['-p', consumer, '--noEmit']);
        writeFileSync(path, brokenUsage.replaceAll('// @ts-expect-error intentional invalid consumer', ''));
        const broken = run(tsc, ['-p', consumer, '--noEmit']);
        assert.notEqual(broken.status, 0, 'invalid consumer unexpectedly compiled');
        for (const statement of invalid) {
          const line = brokenUsage.slice(0, brokenUsage.indexOf(statement)).split('\n').length;
          assert.ok(broken.output.includes(`invalid.ts(${line},`), `No diagnostic for ${statement}\n${broken.output}`);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
