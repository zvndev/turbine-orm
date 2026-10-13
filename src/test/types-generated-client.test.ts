/**
 * turbine-orm, a generated client's input and result types, compiled by tsc
 *
 * Generates a client for a blog schema and compiles consumer files against the
 * CURRENT source types (`turbine-orm` path-mapped to src/index.ts). Every
 * `@ts-expect-error` below is a shape the runtime refuses; an unused one fails
 * the compile, so each line proves the type rejects what it should.
 *
 * Covers: required columns on create, the foreign-key-or-relation choice,
 * nested creates that omit the keys the parent supplies, unique selectors on
 * findUnique / upsert / connect, belongsTo nested writes (to-one rules),
 * non-null required relations, typed `globalFilters`, typed `aggregate` and
 * `pipeline` results, `build*` key checking, `columnTypes`, and a compile
 * with `exactOptionalPropertyTypes`.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { generateIndex, generateMetadata, generateTypes } from '../generate.js';
import { blogSchema } from './types-fixture-schema.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const COLUMN_TYPES = { 'organizations.metadata': '{ tier: string; seats?: number }' };

function typecheck(
  consumers: Record<string, string>,
  extraOptions: Record<string, unknown> = {},
): { status: number | null; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'turbine-types-generated-'));
  try {
    const schema = blogSchema();
    writeFileSync(join(dir, 'types.ts'), generateTypes(schema, { noTimestamp: true, columnTypes: COLUMN_TYPES }));
    writeFileSync(join(dir, 'metadata.ts'), generateMetadata(schema, { noTimestamp: true }));
    writeFileSync(join(dir, 'index.ts'), generateIndex(schema, { noTimestamp: true }));
    for (const [name, source] of Object.entries(consumers)) writeFileSync(join(dir, name), source);
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          types: ['node'],
          typeRoots: [join(repoRoot, 'node_modules', '@types')],
          paths: { 'turbine-orm': [join(repoRoot, 'src', 'index.ts')] },
          ...extraOptions,
        },
        include: ['*.ts', join(repoRoot, 'types', '**', '*.d.ts')],
      }),
    );
    const result = spawnSync(
      join(repoRoot, 'node_modules', '.bin', 'tsc'),
      ['--noEmit', '-p', '.', '--pretty', 'false'],
      {
        cwd: dir,
        encoding: 'utf-8',
        timeout: 300_000,
      },
    );
    // Keep only diagnostics in the generated and consumer files (printed as
    // bare names, since tsc runs from their directory): the library modules
    // compile from source too, and another module's state is not under test.
    const own = `${result.stdout}\n${result.stderr}`
      .split('\n')
      .filter((line) => /^[\w.-]+\.ts\(\d+,\d+\): error/.test(line));
    if (result.status === null) return { status: null, output: `tsc did not finish: ${result.error ?? ''}` };
    return { status: own.length === 0 ? 0 : 1, output: own.join('\n') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const WRITES = `
import type { TurbineClient } from './index.js';
declare const db: TurbineClient;

export async function writes(): Promise<void> {
  // Required columns are required.
  await db.users.create({ data: { orgId: 1, email: 'a@b.c', name: 'A' } });
  // @ts-expect-error email is required
  await db.users.create({ data: { orgId: 1, name: 'A' } });
  // @ts-expect-error an unknown column
  await db.users.create({ data: { orgId: 1, email: 'a@b.c', name: 'A', emial: 'x' } });

  // A required belongsTo is satisfied by its key or by the relation.
  await db.users.create({ data: { email: 'a@b.c', name: 'A', organization: { connect: { id: 1 } } } });
  // @ts-expect-error neither orgId nor organization
  await db.users.create({ data: { email: 'a@b.c', name: 'A' } });

  // A nested create through a hasMany does not ask for the key the parent supplies.
  await db.users.create({
    data: { orgId: 1, email: 'a@b.c', name: 'A', posts: { create: [{ orgId: 1, title: 'T', content: 'C' }] } },
  });
  await db.users.create({
    // @ts-expect-error the nested post still needs its title
    data: { orgId: 1, email: 'a@b.c', name: 'A', posts: { create: { orgId: 1, content: 'C' } } },
  });

  // createMany takes plain rows with their required columns.
  await db.posts.createMany({ data: [{ userId: 1, orgId: 1, title: 'T', content: 'C' }] });
  // @ts-expect-error a row without its required columns
  await db.posts.createMany({ data: [{ title: 'T' }] });

  // Unique selectors: findUnique, upsert, connect.
  await db.users.findUnique({ where: { email: 'a@b.c' } });
  await db.users.findUnique({ where: { id: 1, orgId: 2 } });
  // @ts-expect-error name is not a unique key
  await db.users.findUnique({ where: { name: 'A' } });
  await db.users.upsert({
    where: { email: 'a@b.c' },
    create: { orgId: 1, email: 'a@b.c', name: 'A' },
    update: { name: 'B' },
  });
  // @ts-expect-error upsert must name a unique key
  await db.users.upsert({ where: { name: 'A' }, create: { orgId: 1, email: 'a@b.c', name: 'A' }, update: {} });
  await db.users.update({ where: { id: 1 }, data: { posts: { connect: { id: 3 } } } });
  // @ts-expect-error connect needs a unique key
  await db.users.update({ where: { id: 1 }, data: { posts: { connect: { title: 'T' } } } });

  // belongsTo nested writes take Prisma's to-one operations.
  await db.posts.update({ where: { id: 1 }, data: { user: { connect: { id: 2 } } } });
  await db.users.update({ where: { id: 1 }, data: { user: { disconnect: true } } });
  await db.users.update({ where: { id: 1 }, data: { user: { disconnect: {} } } });
  await db.posts.update({ where: { id: 1 }, data: { user: { update: { data: { name: 'B' } } } } });
  // @ts-expect-error a belongsTo has no set
  await db.posts.update({ where: { id: 1 }, data: { user: { set: [{ id: 2 }] } } });
  // @ts-expect-error a belongsTo connects a single row
  await db.posts.update({ where: { id: 1 }, data: { user: { connect: [{ id: 2 }] } } });

  // Atomic operators and { set } on update.
  await db.posts.update({ where: { id: 1 }, data: { viewCount: { increment: 1 }, title: { set: 'T' } } });
}
`;

const READS = `
import { turbine, type TurbineClient } from './index.js';
declare const db: TurbineClient;

export async function reads(): Promise<void> {
  // A required belongsTo is never null; a nullable one is.
  const post = await db.posts.findFirstOrThrow({ with: { user: true } });
  const email: string = post.user.email;
  const user = await db.users.findFirstOrThrow({ with: { user: true } });
  // @ts-expect-error the manager relation is nullable
  const managerEmail: string = user.user.email;

  // Nested select narrows.
  const rows = await db.users.findMany({ with: { posts: { select: { title: true } } }, limit: 1 });
  const title: string = rows[0]!.posts[0]!.title;
  // @ts-expect-error content was not selected
  rows[0]!.posts[0]!.content;

  // aggregate derives from its args.
  const agg = await db.posts.aggregate({ _sum: { viewCount: true }, _max: { title: true } });
  const sum: number | string | null = agg._sum.viewCount;
  const max: string | null = agg._max.title;
  // @ts-expect-error _avg was not requested
  agg._avg;

  // pipeline returns a tuple in both call forms.
  const [count, first] = await db.pipeline(db.users.buildCount(), db.users.buildFindFirst());
  const n: number = count;
  const [count2] = await db.pipeline([db.users.buildCount()], { transactional: false });
  const n2: number = count2;

  // build* variants check keys like their async twins.
  // @ts-expect-error a misspelled column
  db.users.buildCount({ where: { emial: 'x' } });
  // @ts-expect-error a misspelled column
  db.users.buildDeleteMany({ where: { emial: 'x' } });

  // Transaction callbacks receive the typed client, at every level.
  const txEmail: string = await db.$transaction(async (tx) => {
    const inner = await tx.$transaction(async (tx2) => tx2.users.findFirstOrThrow());
    // @ts-expect-error a misspelled accessor
    tx.userz;
    return inner.email;
  });
  const [txCount] = await db.$transaction([db.users.buildCount()]);
  const txN: number = txCount;
  const scoped = await db.$withSession({ 'app.org': 1 }, (tx) => tx.posts.findMany({ limit: 1 }));
  const scopedTitle: string | undefined = scoped[0]?.title;

  // columnTypes types a json column.
  const org = await db.organizations.findFirstOrThrow();
  const tier: string | undefined = org.metadata?.tier;

  void [email, managerEmail, title, sum, max, first, n, n2, tier, txEmail, txN, scopedTitle];
}

// Typed globalFilters: table keys and columns are checked.
export const filtered = turbine({ globalFilters: { posts: { viewCount: { gt: 0 } }, users: () => ({ orgId: 1 }) } });
export const byTableName = turbine({ globalFilters: { organizations: null } });
// @ts-expect-error a misspelled table
export const badTable = turbine({ globalFilters: { postz: { viewCount: 1 } } });
// @ts-expect-error a misspelled column
export const badColumn = turbine({ globalFilters: { posts: { viewCont: 1 } } });
`;

// The same consumer shapes a project compiled with exactOptionalPropertyTypes
// writes: an explicit `undefined` means "leave this out".
const EXACT_OPTIONAL = `
import { turbine, type TurbineClient } from './index.js';
declare const db: TurbineClient;
declare const maybeAvatar: string | undefined;
declare const maybeLimit: number | undefined;

export const client = turbine({ connectionString: process.env.DATABASE_URL });

export async function exact(): Promise<void> {
  await db.users.create({ data: { orgId: 1, email: 'a@b.c', name: 'A', avatarUrl: maybeAvatar } });
  await db.users.update({ where: { id: 1 }, data: { avatarUrl: maybeAvatar } });
  await db.users.findMany({ where: { avatarUrl: maybeAvatar }, limit: maybeLimit });
}
`;

describe('types: a generated client', () => {
  it('rejects the write shapes the runtime refuses and accepts the ones it takes', () => {
    const result = typecheck({ 'writes.ts': WRITES });
    assert.equal(result.status, 0, `tsc diagnostics:\n${result.output}`);
  });

  it('types relation results, aggregates, pipelines, build variants, global filters and columnTypes', () => {
    const result = typecheck({ 'reads.ts': READS });
    assert.equal(result.status, 0, `tsc diagnostics:\n${result.output}`);
  });

  it('compiles under exactOptionalPropertyTypes', () => {
    const result = typecheck(
      { 'reads.ts': READS, 'writes.ts': WRITES, 'exact.ts': EXACT_OPTIONAL },
      { exactOptionalPropertyTypes: true },
    );
    assert.equal(result.status, 0, `tsc diagnostics:\n${result.output}`);
  });
});
