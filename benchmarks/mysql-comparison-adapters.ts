/** Native ORM arms. No production API is replaced or patched. */
import assert from 'node:assert/strict';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import * as stableOps from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/mysql2';
import * as rcOps from 'drizzle-rc';
import { drizzle as drizzleRc } from 'drizzle-rc/mysql2';
import { makeJitRqbMapper } from 'drizzle-rc/relations';
import { PrismaClient } from './generated/prisma-mysql/index.js';
import {
  BATCH_SIZE,
  bind,
  connectionOptions,
  FIXTURE_TIME,
  makePool,
  MYSQL_SESSION_IDENTITY_SQL,
  MYSQL2_SETTINGS,
  POOL_SIZE,
} from './mysql-comparison-config.js';
import { decodeRaw, type Row } from './mysql-equivalence.js';
import * as stable from './mysql-schema.js';
import * as candidate from './mysql-schema-rc.js';

// biome-ignore lint/suspicious/noExplicitAny: the stable and RC native query builders have incompatible generic interfaces.
type Native = any;
export type Table = 'users' | 'posts' | 'comments' | 'benchWide';
export type Relation = 'posts' | 'l3' | 'user' | 'tags' | 'count';
export interface Read {
  unique?: boolean;
  take?: number;
  skip?: number;
  id?: number;
  afterId?: number;
  userId?: number;
  orgId?: number;
  published?: boolean;
  relation?: Relation;
  postLimit?: number;
  havingPublished?: boolean;
  newest?: boolean;
  strategy?: string;
}
export interface Adapter {
  name: string;
  protocol: string;
  find(table: Table, spec: Read): Promise<Row[]>;
  count(table: Table, userId?: number): Promise<number>;
  aggregate(): Promise<unknown>;
  dashboard(transaction: boolean): Promise<unknown>;
  increment(): Promise<unknown>;
  bulk(rows: Row[]): Promise<unknown>;
  bulkCount(rows: Row[]): Promise<{ count: number }>;
  boundaries?(): Promise<unknown>;
  literalProbe(value: string): Promise<unknown>;
  ownership(): unknown;
  settings(): Promise<unknown>;
  update(i: number): Promise<unknown>;
  upsert(i: number): Promise<unknown>;
  delete(): Promise<unknown>;
  stream(mode: 'rows' | 'batches' | 'keyset' | 'native', observe?: (row: unknown) => void): Promise<number>;
  close(): Promise<void>;
  warm(): Promise<void>;
  deepText?(): Promise<Row[]>;
}
function poolOwnership(pool: Native) {
  const p = pool.pool;
  return {
    owner: 'comparison',
    threadIds: [...p._allConnections.toArray()].map((c: Native) => c.threadId),
    connections: p._allConnections.length,
    free: p._freeConnections.length,
    queued: p._connectionQueue.length,
    closedBy: 'explicit pool.end; Turbine disconnect leaves supplied pool open',
  };
}
const tableNames = { users: 'users', posts: 'posts', comments: 'comments', benchWide: 'bench_wide' };
const modelNames = { users: 'user', posts: 'post', comments: 'comment', benchWide: 'benchWide' };
const order = (spec: Read) => (spec.newest ? [{ createdAt: 'desc' }, { id: 'desc' }] : { id: 'asc' });
const where = (spec: Read, big = false): Row => {
  const out: Row = {};
  for (const k of ['id', 'userId', 'orgId'] as const)
    if (spec[k] !== undefined) out[k] = big ? BigInt(spec[k]!) : spec[k];
  if (spec.afterId !== undefined) out.id = { gt: big ? BigInt(spec.afterId) : spec.afterId };
  if (spec.published !== undefined) out.published = spec.published;
  if (spec.havingPublished) out.posts = { some: { published: true } };
  return out;
};
function include(spec: Read, prisma = false): Row | undefined {
  const sort = { id: 'asc' };
  switch (spec.relation) {
    case 'posts':
      return { posts: { orderBy: sort } };
    case 'l3':
      return {
        posts: {
          orderBy: sort,
          ...(spec.postLimit ? { [prisma ? 'take' : 'limit']: spec.postLimit } : {}),
          [prisma ? 'include' : 'with']: { comments: { orderBy: sort } },
        },
      };
    case 'user':
      return { user: true };
    case 'tags':
      return prisma ? { postTags: { orderBy: { tagId: 'asc' }, include: { tag: true } } } : { tags: { orderBy: sort } };
    case 'count':
      return prisma ? { _count: { select: { posts: true } } } : { _count: { posts: true } };
    default:
      return undefined;
  }
}
export function flattenTags(rows: Row[]): Row[] {
  return rows.map(({ postTags, ...row }) => ({ ...row, tags: (postTags as { tag: Row }[]).map((x) => x.tag) }));
}
async function drain(adapter: Adapter, observe?: (row: unknown) => void) {
  let n = 0,
    last = 0;
  for (;;) {
    const rows = await adapter.find('comments', { take: BATCH_SIZE, afterId: last });
    for (const row of rows) {
      observe?.(row);
      last = Number(row.id);
      n++;
    }
    if (rows.length < BATCH_SIZE) return n;
  }
}
export async function createAdapter(name: string): Promise<Adapter> {
  switch (name) {
    case 'Turbine':
      return createTurbine();
    case 'Raw':
      return createRaw();
    case 'Drizzle':
      return createDrizzle(false);
    case 'Drizzle RC':
      return createDrizzle(true);
    case 'Prisma 7':
      return createPrisma();
    default:
      throw new Error(`unknown MySQL arm ${name}`);
  }
}
export async function createAdapters(): Promise<Adapter[]> {
  const arms: Adapter[] = [];
  try {
    arms.push(await createTurbine());
    arms.push(createRaw());
    arms.push(createDrizzle(false));
    arms.push(createDrizzle(true));
    arms.push(createPrisma());
    return arms;
  } catch (error) {
    await Promise.allSettled(arms.map((a) => a.close()));
    throw error;
  }
}
export async function createTurbine(): Promise<Adapter> {
  const pool = makePool('Turbine supplied');
  let db: Native;
  try {
    const { turbine } = await import('./generated/turbine-mysql/index.js');
    db = await turbine(pool, { logger: {}, warnOnUnlimited: false, diagnostics: { mode: 'production' } });
  } catch (error) {
    await pool.end();
    throw error;
  }
  const find = async (client: Native, table: Table, spec: Read) =>
    spec.unique
      ? [await client[table].findUnique({ where: where(spec), ...(spec.relation ? { with: include(spec) } : {}) })]
      : client[table].findMany({
          where: where(spec),
          orderBy: order(spec),
          ...(spec.take !== undefined ? { limit: spec.take } : {}),
          ...(spec.skip !== undefined ? { offset: spec.skip } : {}),
          ...(spec.relation ? { with: include(spec) } : {}),
          ...(spec.strategy ? { relationLoadStrategy: spec.strategy } : {}),
        });
  const adapter: Adapter = {
    name: 'Turbine',
    protocol: 'mysql2 binary execute for bound statements; supplied pool; driver statement cache',
    find: (t, s) => find(db, t, s),
    count: (t, userId) => db[t].count(userId === undefined ? {} : { where: { userId } }),
    aggregate: async () => {
      const rows = await db.posts.groupBy({
        by: ['orgId'],
        _count: true,
        _avg: { viewCount: true },
        having: { _count: { gt: 100 } },
        orderBy: { orgId: 'asc' },
      });
      return rows.map((r: Native) => ({ orgId: r.orgId, count: r._count, avgViews: r._avg.viewCount }));
    },
    dashboard: async (transaction) => {
      const reads = async (tx: Native) => [
        await tx.users.findUnique({ where: { id: 1 } }),
        await tx.posts.count({ where: { userId: 1 } }),
        await tx.comments.count({ where: { userId: 1 } }),
        await find(tx, 'posts', { userId: 1, newest: true, take: 5 }),
        await tx.users.count(),
      ];
      if (transaction) return db.$transaction(reads, { isolationLevel: 'ReadCommitted' });
      // MySQL has no PostgreSQL extended-query pipeline. Explicit independent pool reads.
      return Promise.all([
        db.users.findUnique({ where: { id: 1 } }),
        db.posts.count({ where: { userId: 1 } }),
        db.comments.count({ where: { userId: 1 } }),
        find(db, 'posts', { userId: 1, newest: true, take: 5 }),
        db.users.count(),
      ]);
    },
    literalProbe: (value) =>
      db.benchWrites.create({ data: { orgId: 1, slug: 'escape-probe', label: value, createdAt: FIXTURE_TIME } }),
    ownership: () => poolOwnership(pool),
    settings: async () => ({
      configured: MYSQL2_SETTINGS,
      sampledSession: (await pool.query(MYSQL_SESSION_IDENTITY_SQL))[0],
    }),
    increment: () => db.posts.update({ where: { id: 1 }, data: { viewCount: { increment: 1 } } }),
    bulk: (rows) => db.benchWrites.createMany({ data: rows }),
    bulkCount: (rows) => db.benchWrites.createMany({ data: rows, returning: false }),
    boundaries: async () => {
      assert.equal(await db.pipelineSupported(), false, 'MySQL PG pipeline must be unavailable');
      return { pipelineSupported: false, defaultCreateManyReturning: 'empty array; storage is separately tested' };
    },
    update: (i) => db.benchWrites.update({ where: { id: 1 }, data: { amount: i } }),
    upsert: (i) =>
      db.benchWrites.upsert({
        where: { slug: 'upsert' },
        create: { orgId: 1, slug: 'upsert', label: 'upsert', amount: i, createdAt: FIXTURE_TIME },
        update: { amount: i },
      }),
    delete: () => db.benchWrites.delete({ where: { slug: 'delete' } }),
    stream: async (mode, observe) => {
      if (mode === 'keyset') return drain(adapter, observe);
      let n = 0;
      const args = { batchSize: BATCH_SIZE, orderBy: { id: 'asc' } };
      if (mode === 'batches') {
        for await (const batch of db.comments.findManyStreamBatches(args))
          for (const row of batch) {
            observe?.(row);
            n++;
          }
      } else {
        for await (const row of db.comments.findManyStream(args)) {
          observe?.(row);
          n++;
        }
      }
      return n;
    },
    warm: async () => {
      await db.raw`SELECT 1`;
    },
    close: async () => {
      try {
        await db.disconnect();
        await pool.query('SELECT 1');
      } finally {
        await pool.end();
      }
    },
  };
  return adapter;
}
function createPrisma(): Adapter {
  const factory = new PrismaMariaDb({ ...connectionOptions(), connectionLimit: POOL_SIZE, timezone: '+00:00' });
  let driver: Native;
  const nativeConnect = factory.connect.bind(factory);
  factory.connect = async () => {
    const adapter = await nativeConnect();
    driver = adapter.underlyingDriver();
    return adapter;
  };
  const db: Native = new PrismaClient({ adapter: factory });
  const find = async (client: Native, table: Table, spec: Read) => {
    if (spec.unique)
      return [
        await client[modelNames[table]].findUnique({
          where: where(spec, true),
          ...(spec.relation ? { include: include(spec, true) } : {}),
        }),
      ];
    const rows = await client[modelNames[table]].findMany({
      where: where(spec, true),
      orderBy: order(spec),
      ...(spec.take !== undefined ? { take: spec.take } : {}),
      ...(spec.skip !== undefined ? { skip: spec.skip } : {}),
      ...(spec.relation ? { include: include(spec, true) } : {}),
    });
    return spec.relation === 'tags' ? flattenTags(rows) : rows;
  };
  const adapter: Adapter = {
    name: 'Prisma 7',
    protocol: 'adapter-mariadb; mariadb binary execute; adapter-owned pool; default prepareCacheLength=0',
    find: (t, s) => find(db, t, s),
    count: (t, userId) => db[modelNames[t]].count(userId === undefined ? {} : { where: { userId: BigInt(userId) } }),
    aggregate: async () => {
      const rows = await db.post.groupBy({
        by: ['orgId'],
        _count: true,
        _avg: { viewCount: true },
        having: { orgId: { _count: { gt: 100 } } },
        orderBy: { orgId: 'asc' },
      });
      return rows.map((r: Native) => ({ orgId: r.orgId, count: r._count, avgViews: r._avg.viewCount }));
    },
    dashboard: async (transaction) => {
      const q = [
        db.user.findUnique({ where: { id: 1n } }),
        db.post.count({ where: { userId: 1n } }),
        db.comment.count({ where: { userId: 1n } }),
        db.post.findMany({ where: { userId: 1n }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 5 }),
        db.user.count(),
      ];
      return transaction ? db.$transaction(q, { isolationLevel: 'ReadCommitted' }) : Promise.all(q);
    },
    literalProbe: (value) =>
      db.benchWrite.create({ data: { orgId: 1n, slug: 'escape-probe', label: value, createdAt: FIXTURE_TIME } }),
    settings: async () => ({
      configured: { driver: 'mariadb', connectionLimit: POOL_SIZE, timezone: '+00:00', prepareCacheLength: 0 },
      sampledSession: await db.$queryRawUnsafe(MYSQL_SESSION_IDENTITY_SQL),
    }),
    ownership: () => ({
      owner: 'PrismaMariaDb(config)',
      closedBy: 'PrismaClient.$disconnect',
      externalPool: false,
      prepareCacheLength: 0,
      connections: driver?.totalConnections(),
      active: driver?.activeConnections(),
      idle: driver?.idleConnections(),
      queued: driver?.taskQueueSize(),
    }),
    increment: () => db.post.update({ where: { id: 1n }, data: { viewCount: { increment: 1 } } }),
    bulk: (rows) => db.benchWrite.createMany({ data: rows.map((r) => ({ ...r, orgId: BigInt(r.orgId as number) })) }),
    bulkCount: (rows) =>
      db.benchWrite.createMany({ data: rows.map((r) => ({ ...r, orgId: BigInt(r.orgId as number) })) }),
    update: (i) => db.benchWrite.update({ where: { id: 1n }, data: { amount: i } }),
    upsert: (i) =>
      db.benchWrite.upsert({
        where: { slug: 'upsert' },
        create: { orgId: 1n, slug: 'upsert', label: 'upsert', amount: i, createdAt: FIXTURE_TIME },
        update: { amount: i },
      }),
    delete: () => db.benchWrite.delete({ where: { slug: 'delete' } }),
    stream: (_mode, observe) => drain(adapter, observe),
    warm: async () => {
      await db.$queryRaw`SELECT 1`;
    },
    close: () => db.$disconnect(),
  };
  return adapter;
}
function createDrizzle(rc: boolean): Adapter {
  const pool = makePool(rc ? 'Drizzle RC' : 'Drizzle');
  const s: Native = rc ? candidate : stable;
  const op: Native = rc ? rcOps : stableOps;
  const db: Native = rc
    ? drizzleRc({ client: pool, relations: candidate.relations, jit: true })
    : drizzle(pool, { schema: stable, mode: 'default' });
  if (rc) assert.equal(db.dialect.mapperGenerators.relationalRows, makeJitRqbMapper, 'RC JIT mapper must engage');
  const predicate = (table: Native, spec: Read) => {
    const terms = [];
    for (const k of ['id', 'userId', 'orgId', 'published'] as const)
      if (spec[k] !== undefined) terms.push(op.eq(table[k], spec[k]));
    if (spec.afterId !== undefined) terms.push(op.gt(table.id, spec.afterId));
    if (spec.havingPublished)
      terms.push(
        op.exists(
          db
            .select({ one: op.sql`1` })
            .from(s.posts)
            .where(op.and(op.eq(s.posts.userId, table.id), op.eq(s.posts.published, true))),
        ),
      );
    return terms.length ? op.and(...terms) : undefined;
  };
  const find = async (client: Native, table: Table, spec: Read) => {
    const t = s[table],
      sort = spec.newest ? [op.desc(t.createdAt), op.desc(t.id)] : [op.asc(t.id)];
    if (spec.relation === 'count') {
      const rows = await client
        .select({
          ...op.getTableColumns(t),
          postCount: op.sql`(SELECT COUNT(*) FROM posts p WHERE p.user_id = users.id)`,
        })
        .from(t)
        .orderBy(op.asc(t.id))
        .limit(spec.take!);
      return rows.map(({ postCount, ...row }: Native) => ({ ...row, _count: { posts: Number(postCount) } }));
    }
    if (spec.havingPublished)
      return client
        .select()
        .from(t)
        .where(predicate(t, spec))
        .orderBy(...sort)
        .limit(spec.take!);
    let withValue: Row | undefined;
    const relOrder = (tbl: Native) => (rc ? { id: 'asc' } : op.asc(tbl.id));
    if (spec.relation === 'posts' || spec.relation === 'l3')
      withValue = {
        posts: {
          orderBy: relOrder(s.posts),
          ...(spec.postLimit ? { limit: spec.postLimit } : {}),
          ...(spec.relation === 'l3' ? { with: { comments: { orderBy: relOrder(s.comments) } } } : {}),
        },
      };
    if (spec.relation === 'user') withValue = { user: true };
    if (spec.relation === 'tags')
      withValue = { postTags: { orderBy: rc ? { tagId: 'asc' } : op.asc(s.postTags.tagId), with: { tag: true } } };
    const config = {
      where: rc ? where(spec) : predicate(t, spec),
      orderBy: rc ? (spec.newest ? { createdAt: 'desc', id: 'desc' } : { id: 'asc' }) : sort,
      ...(spec.take !== undefined ? { limit: spec.take } : {}),
      ...(spec.skip !== undefined ? { offset: spec.skip } : {}),
      ...(withValue ? { with: withValue } : {}),
    };
    const rows = spec.unique
      ? [await client.query[table].findFirst(config)]
      : await client.query[table].findMany(config);
    return spec.relation === 'tags' ? flattenTags(rows) : rows;
  };
  const count = async (client: Native, table: Table, userId?: number) =>
    Number(
      (
        await client
          .select({ n: op.count() })
          .from(s[table])
          .where(userId === undefined ? undefined : op.eq(s[table].userId, userId))
      )[0].n,
    );
  const returning = async (
    write: (tx: Native) => Promise<unknown>,
    table: Native,
    condition: Native,
    deleted = false,
  ) =>
    db.transaction(async (tx: Native) => {
      if (deleted) {
        const rows = await tx.select().from(table).where(condition).for('update');
        await write(tx);
        return rows[0];
      }
      await write(tx);
      return (await tx.select().from(table).where(condition))[0];
    });
  const adapter: Adapter = {
    name: rc ? 'Drizzle RC' : 'Drizzle',
    protocol: `mysql2 text query; ${rc ? 'RC JIT' : 'stable native'}; default APIs (prepare() is not server PREPARE)`,
    find: (t, spec) => find(db, t, spec),
    count: (t, u) => count(db, t, u),
    aggregate: async () => {
      const rows = await db
        .select({ orgId: s.posts.orgId, count: op.count(), avgViews: op.avg(s.posts.viewCount) })
        .from(s.posts)
        .groupBy(s.posts.orgId)
        .having(op.gt(op.count(), 100))
        .orderBy(op.asc(s.posts.orgId));
      return rows.map((r: Native) => ({ ...r, avgViews: Number(r.avgViews) }));
    },
    dashboard: async (transaction) => {
      const reads = [
        (tx: Native) => find(tx, 'users', { id: 1, take: 1 }).then((r) => r[0]),
        (tx: Native) => count(tx, 'posts', 1),
        (tx: Native) => count(tx, 'comments', 1),
        (tx: Native) => find(tx, 'posts', { userId: 1, newest: true, take: 5 }),
        (tx: Native) => count(tx, 'users'),
      ];
      if (transaction)
        return db.transaction(
          async (tx: Native) => {
            const result = [];
            for (const read of reads) result.push(await read(tx));
            return result;
          },
          { isolationLevel: 'read committed' },
        );
      return Promise.all(reads.map((r) => r(db)));
    },
    literalProbe: (value) =>
      returning(
        (tx) =>
          tx.insert(s.benchWrites).values({ orgId: 1, slug: 'escape-probe', label: value, createdAt: FIXTURE_TIME }),
        s.benchWrites,
        op.eq(s.benchWrites.slug, 'escape-probe'),
      ),
    ownership: () => poolOwnership(pool),
    settings: async () => ({
      configured: MYSQL2_SETTINGS,
      sampledSession: (await pool.query(MYSQL_SESSION_IDENTITY_SQL))[0],
    }),
    increment: () =>
      returning(
        (tx) =>
          tx
            .update(s.posts)
            .set({ viewCount: op.sql`${s.posts.viewCount} + 1` })
            .where(op.eq(s.posts.id, 1)),
        s.posts,
        op.eq(s.posts.id, 1),
      ),
    bulk: (rows) => db.insert(s.benchWrites).values(rows),
    bulkCount: async (rows) => {
      const value = await db.insert(s.benchWrites).values(rows);
      return { count: Number((Array.isArray(value) ? value[0] : value).affectedRows) };
    },
    update: (i) =>
      returning(
        (tx) => tx.update(s.benchWrites).set({ amount: i }).where(op.eq(s.benchWrites.id, 1)),
        s.benchWrites,
        op.eq(s.benchWrites.id, 1),
      ),
    upsert: (i) =>
      returning(
        (tx) =>
          tx
            .insert(s.benchWrites)
            .values({ orgId: 1, slug: 'upsert', label: 'upsert', amount: i, createdAt: FIXTURE_TIME })
            .onDuplicateKeyUpdate({ set: { amount: i } }),
        s.benchWrites,
        op.eq(s.benchWrites.slug, 'upsert'),
      ),
    delete: () =>
      returning(
        (tx) => tx.delete(s.benchWrites).where(op.eq(s.benchWrites.slug, 'delete')),
        s.benchWrites,
        op.eq(s.benchWrites.slug, 'delete'),
        true,
      ),
    stream: async (mode, observe) => {
      if (mode !== 'native') return drain(adapter, observe);
      let n = 0;
      for await (const row of db.select().from(s.comments).orderBy(op.asc(s.comments.id)).iterator()) {
        observe?.(row);
        n++;
      }
      return n;
    },
    warm: async () => {
      await db.execute(op.sql`SELECT 1`);
    },
    close: () => pool.end(),
  };
  return adapter;
}
export function createRaw(): Adapter {
  const pool = makePool('Raw');
  const sqlRows = async (runner: Native, sql: string, params: unknown[] = []) =>
    decodeRaw((await runner.execute(sql, params))[0]);
  const find = async (runner: Native, table: Table, spec: Read): Promise<Row[]> => {
    const clauses: string[] = [],
      params: unknown[] = [];
    const names = { id: 'id', userId: 'user_id', orgId: 'org_id', published: 'published' };
    for (const k of ['id', 'userId', 'orgId', 'published'] as const)
      if (spec[k] !== undefined) {
        clauses.push(`\`${names[k]}\` = ?`);
        params.push(spec[k]);
      }
    if (spec.afterId !== undefined) {
      clauses.push('id > ?');
      params.push(spec.afterId);
    }
    if (spec.havingPublished)
      clauses.push('EXISTS (SELECT 1 FROM posts p WHERE p.user_id = users.id AND p.published = TRUE)');
    const limit = spec.take === undefined ? '' : ` LIMIT ${spec.take}`; // validated catalog integer, mysql2 DOUBLE binds cannot represent LIMIT
    const offset = spec.skip ? ` OFFSET ${spec.skip}` : '';
    // Native single-query controls for the original L2 and to-one shapes.
    // The window orders JSON_ARRAYAGG explicitly; its unspecified aggregate
    // input order is not used as a correctness guarantee.
    const decodeJsonRows = (value: unknown): Row[] => {
      const rows = decodeRaw(typeof value === 'string' ? JSON.parse(value) : value);
      return rows.map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => {
            if (value !== null && ['createdAt', 'updatedAt', 'lastLoginAt'].includes(key)) {
              assert.equal(typeof value, 'string', 'raw nested timestamp must be a string');
              assert.match(value as string, /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/);
              return [key, new Date((value as string).replace(' ', 'T') + 'Z')];
            }
            return [key, value];
          }),
        ),
      );
    };
    if (table === 'users' && spec.relation === 'posts') {
      const nested = await sqlRows(
        runner,
        `SELECT u.*,COALESCE(children.data,JSON_ARRAY()) AS posts FROM users u LEFT JOIN LATERAL (
        SELECT JSON_ARRAYAGG(JSON_OBJECT('id',p.id,'user_id',p.user_id,'org_id',p.org_id,'title',p.title,'content',p.content,'published',p.published,'view_count',p.view_count,'created_at',p.created_at,'updated_at',p.updated_at)) OVER (ORDER BY p.id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS data
        FROM posts p WHERE p.user_id=u.id ORDER BY p.id LIMIT 1
      ) children ON TRUE ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY u.id${limit}${offset}`,
        params,
      );
      return nested.map(({ posts, ...row }) => ({ ...row, posts: decodeJsonRows(posts) }));
    }
    if (table === 'posts' && spec.relation === 'user') {
      const nested = await sqlRows(
        runner,
        `SELECT p.*,JSON_OBJECT('id',u.id,'org_id',u.org_id,'email',u.email,'name',u.name,'role',u.role,'avatar_url',u.avatar_url,'last_login_at',u.last_login_at,'created_at',u.created_at) AS user FROM posts p LEFT JOIN users u ON u.id=p.user_id ORDER BY p.id${limit}${offset}`,
      );
      return nested.map(({ user, ...row }) => ({
        ...row,
        user: decodeJsonRows([typeof user === 'string' ? JSON.parse(user) : user])[0],
      }));
    }
    let rows = await sqlRows(
      runner,
      `SELECT * FROM \`${tableNames[table]}\`${clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''} ORDER BY ${spec.newest ? 'created_at DESC, id DESC' : 'id ASC'}${limit}${offset}`,
      params,
    );
    if (!rows.length || !spec.relation) return rows;
    const ids = rows.map((r) => r.id),
      marks = ids.map(() => '?').join(',');
    if (spec.relation === 'posts' || spec.relation === 'l3') {
      const posts = await sqlRows(runner, `SELECT * FROM posts WHERE user_id IN (${marks}) ORDER BY id`, ids);
      let comments: Row[] = [];
      const selected = rows.flatMap((u) => posts.filter((p) => p.userId === u.id).slice(0, spec.postLimit));
      if (spec.relation === 'l3' && selected.length)
        comments = await sqlRows(
          runner,
          `SELECT * FROM comments WHERE post_id IN (${selected.map(() => '?').join(',')}) ORDER BY id`,
          selected.map((p) => p.id),
        );
      rows = rows.map((u) => ({
        ...u,
        posts: posts
          .filter((p) => p.userId === u.id)
          .slice(0, spec.postLimit)
          .map((p) => (spec.relation === 'l3' ? { ...p, comments: comments.filter((c) => c.postId === p.id) } : p)),
      }));
    } else if (spec.relation === 'user') {
      const users = await sqlRows(
        runner,
        `SELECT * FROM users WHERE id IN (${rows.map(() => '?').join(',')}) ORDER BY id`,
        rows.map((p) => p.userId),
      );
      rows = rows.map((p) => ({ ...p, user: users.find((u) => u.id === p.userId) ?? null }));
    } else if (spec.relation === 'tags') {
      const links = await sqlRows(
        runner,
        `SELECT pt.post_id, t.* FROM post_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.post_id IN (${marks}) ORDER BY pt.post_id, t.id`,
        ids,
      );
      rows = rows.map((p) => ({ ...p, tags: links.filter((t) => t.postId === p.id).map(({ postId, ...tag }) => tag) }));
    } else {
      const counts = await sqlRows(
        runner,
        `SELECT user_id, COUNT(*) AS n FROM posts WHERE user_id IN (${marks}) GROUP BY user_id`,
        ids,
      );
      rows = rows.map((u) => ({ ...u, _count: { posts: Number(counts.find((c) => c.userId === u.id)?.n ?? 0) } }));
    }
    return rows;
  };
  const count = async (runner: Native, table: Table, userId?: number) =>
    Number(
      (
        await sqlRows(
          runner,
          `SELECT COUNT(*) AS n FROM \`${tableNames[table]}\`${userId === undefined ? '' : ' WHERE user_id = ?'}`,
          userId === undefined ? [] : [userId],
        )
      )[0]!.n,
    );
  const tx = async (fn: (conn: Native) => Promise<unknown>, isolation = false) => {
    const c = await pool.getConnection();
    try {
      if (isolation) await c.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await c.beginTransaction();
      try {
        const v = await fn(c);
        await c.commit();
        return v;
      } catch (error) {
        await c.rollback();
        throw error;
      }
    } finally {
      c.release();
    }
  };
  const returning = (sql: string, params: unknown[], table: string, column: string, key: unknown, deleted = false) =>
    tx(async (c) => {
      if (deleted) {
        const rows = await sqlRows(c, `SELECT * FROM \`${table}\` WHERE \`${column}\` = ? FOR UPDATE`, [key]);
        await c.execute(sql, params);
        return rows[0];
      }
      await c.execute(sql, params);
      return (await sqlRows(c, `SELECT * FROM \`${table}\` WHERE \`${column}\` = ?`, [key]))[0];
    });
  const adapter: Adapter = {
    name: 'Raw',
    protocol:
      'mysql2 execute (binary cached statements); single-query L2/to-one JSON controls, batched deeper/junction relations; transaction+reselect for returning',
    find: (t, s) => find(pool, t, s),
    count: (t, u) => count(pool, t, u),
    aggregate: async () => {
      const rows = await sqlRows(
        pool,
        'SELECT org_id, COUNT(*) AS count, AVG(view_count) AS avg_views FROM posts GROUP BY org_id HAVING COUNT(*) > 100 ORDER BY org_id',
      );
      return rows.map((r) => ({ orgId: r.orgId, count: Number(r.count), avgViews: Number(r.avg_views) }));
    },
    dashboard: async (transaction) => {
      const reads = [
        (c: Native) => find(c, 'users', { id: 1, take: 1 }).then((r) => r[0]),
        (c: Native) => count(c, 'posts', 1),
        (c: Native) => count(c, 'comments', 1),
        (c: Native) => find(c, 'posts', { userId: 1, newest: true, take: 5 }),
        (c: Native) => count(c, 'users'),
      ];
      if (transaction)
        return tx(async (c) => {
          const out = [];
          for (const read of reads) out.push(await read(c));
          return out;
        }, true);
      return Promise.all(reads.map((r) => r(pool)));
    },
    literalProbe: (value) =>
      returning(
        'INSERT INTO bench_writes (org_id,slug,label,created_at) VALUES (?,?,?,?)',
        [1, 'escape-probe', value, FIXTURE_TIME],
        'bench_writes',
        'slug',
        'escape-probe',
      ),
    ownership: () => poolOwnership(pool),
    settings: async () => ({
      configured: MYSQL2_SETTINGS,
      sampledSession: (await pool.query(MYSQL_SESSION_IDENTITY_SQL))[0],
    }),
    increment: () => returning('UPDATE posts SET view_count = view_count + 1 WHERE id = ?', [1], 'posts', 'id', 1),
    bulk: (rows) =>
      pool.execute(
        `INSERT INTO bench_writes (org_id,slug,label,amount,active,created_at) VALUES ${rows.map(() => '(?,?,?,?,?,?)').join(',')}`,
        bind(rows.flatMap((r) => [r.orgId, r.slug, r.label, r.amount, r.active, r.createdAt])),
      ),
    bulkCount: async (rows) => {
      const value = (await adapter.bulk(rows)) as Native;
      return { count: Number(value[0].affectedRows) };
    },
    update: (i) => returning('UPDATE bench_writes SET amount = ? WHERE id = ?', [i, 1], 'bench_writes', 'id', 1),
    upsert: (i) =>
      returning(
        'INSERT INTO bench_writes (org_id,slug,label,amount,created_at) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE amount = ?',
        [1, 'upsert', 'upsert', i, FIXTURE_TIME, i],
        'bench_writes',
        'slug',
        'upsert',
      ),
    delete: () =>
      returning('DELETE FROM bench_writes WHERE slug = ?', ['delete'], 'bench_writes', 'slug', 'delete', true),
    stream: async (mode, observe) => {
      if (mode !== 'native') return drain(adapter, observe);
      const c = await pool.getConnection();
      try {
        let n = 0;
        const raw: Native = c.connection;
        const stream = raw.query('SELECT * FROM comments ORDER BY id').stream({ highWaterMark: 1000 });
        for await (const row of stream) {
          observe?.(decodeRaw([row])[0]);
          n++;
        }
        return n;
      } finally {
        c.release();
      }
    },
    deepText: async () =>
      decodeRaw(
        (
          await pool.query(
            'SELECT * FROM posts WHERE org_id = ? AND published = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?',
            [1, true, 20, 9000],
          )
        )[0],
      ),
    warm: async () => {
      await pool.query('SELECT 1');
    },
    close: () => pool.end(),
  };
  return adapter;
}
