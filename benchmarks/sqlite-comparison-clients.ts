/** Native engine arms. Driver work and result decoding stay inside each measured call. */
import { DatabaseSync } from 'node:sqlite';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import BetterSqlite3 from 'better-sqlite3';
import * as stableOps from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as rcOps from 'drizzle-rc';
import { drizzle as drizzleRc } from 'drizzle-rc/better-sqlite3';
import * as stable from './sqlite-schema.js';
import * as candidate from './sqlite-schema-rc.js';
import { column, decodeRow, EPOCH, fields } from './sqlite-seed.js';

// The two incompatible Drizzle versions and generated models share this benchmark-only shape.
// biome-ignore lint/suspicious/noExplicitAny: driver-specific query objects are intentionally separate.
type Native = any;
export type Spec = {
  where?: Native;
  orderBy?: Native;
  limit?: number;
  offset?: number;
  with?: Native;
  select?: Native;
  cursor?: Native;
  relationLoadStrategy?: string;
};
export interface Lane {
  name: string;
  kind: string;
  db: Native;
  handle?: Native;
  find(table: string, spec?: Spec, one?: boolean): Native;
  count(table: string, where?: Native): Native;
  dashboard(transaction: boolean): Promise<unknown>;
  write(operation: string, i: number): Native;
  close(): Promise<void>;
}
export const handleAudit: {
  id: number;
  name: string;
  closed: boolean;
  transactionAtClose?: boolean;
  nativeClosed?: boolean;
}[] = [];
export const names = ['Turbine', 'Raw', 'Drizzle', 'Drizzle RC', 'Prisma 7'] as const;
const access: Record<string, string> = {
  bench_wide: 'benchWide',
  bench_writes: 'benchWrites',
  post_tags: 'postTags',
  bench_page: 'benchPage',
  bench_tiny: 'benchTiny',
  bench_parents: 'benchParents',
  bench_children: 'benchChildren',
};
const model: Record<string, string> = {
  users: 'user',
  posts: 'post',
  comments: 'comment',
  organizations: 'organization',
  tags: 'tag',
  bench_wide: 'benchWide',
  bench_writes: 'benchWrite',
  bench_page: 'benchPage',
  bench_tiny: 'benchTiny',
  bench_parents: 'benchParent',
  bench_children: 'benchChild',
};
const tableKey = (t: string) => access[t] ?? t;
export const bulkRows = Array.from({ length: 1000 }, (_, i) => ({
  orgId: (i % 5) + 1,
  slug: `bulk-${i}`,
  label: `Bulk row ${i}`,
  amount: i % 997,
  active: true,
  createdAt: new Date(EPOCH),
}));
export const recentOrder = [{ createdAt: 'desc' }, { id: 'desc' }];
const relation: Record<string, Record<string, [string, string, string, boolean]>> = {
  users: { posts: ['posts', 'id', 'userId', true] },
  posts: {
    comments: ['comments', 'id', 'postId', true],
    user: ['users', 'userId', 'id', false],
    postTags: ['post_tags', 'id', 'postId', true],
    tags: ['tags', 'id', 'id', true],
  },
  bench_parents: { children: ['bench_children', 'id', 'parent', true] },
  post_tags: { tag: ['tags', 'tagId', 'id', false] },
};
function decodeNested(table: string, row: Native, spec: Spec): Native {
  if (!row) return row;
  const out = decodeRow(table, row);
  if (spec.select) for (const k of Object.keys(out)) if (!spec.select[k]) delete out[k];
  for (const [key, s] of Object.entries(spec.with ?? {})) {
    if (key === '_count') {
      out[key] = typeof row[key] === 'string' ? JSON.parse(row[key]) : row[key];
      continue;
    }
    const [child, , , many] = relation[table]![key]!;
    const v = typeof row[key] === 'string' ? JSON.parse(row[key]) : row[key];
    out[key] = many
      ? v.map((r: Native) => decodeNested(child, r, s === true ? {} : (s as Spec)))
      : decodeNested(child, v, s === true ? {} : (s as Spec));
  }
  return out;
}
export function createRaw(db: DatabaseSync): Pick<Lane, 'find' | 'count' | 'write'> {
  const params: Native[] = [];
  function where(w: Native, alias: string, table: string): string {
    if (!w) return '1';
    return Object.entries(w)
      .map(([k, v]) => {
        if (k === 'AND' || k === 'OR')
          return `(${(Array.isArray(v) ? v : [v]).map((x) => where(x, alias, table)).join(k === 'AND' ? ' AND ' : ' OR ')})`;
        if (k === 'posts')
          return `EXISTS(SELECT 1 FROM posts f WHERE f.user_id=${alias}.id AND ${where((v as Native).some, 'f', 'posts')})`;
        const c = `${alias}.${column(k)}`;
        if (v === null) return `${c} IS NULL`;
        if (v && typeof v === 'object')
          return Object.entries(v)
            .map(([op, val]) => {
              if (val === null) return `${c} IS ${op === 'not' ? 'NOT ' : ''}NULL`;
              params.push(typeof val === 'boolean' ? Number(val) : val);
              return `${c} ${{ gt: '>', gte: '>=', lt: '<', lte: '<=', equals: '=', not: '!=' }[op]} ?`;
            })
            .join(' AND ');
        params.push(typeof v === 'boolean' ? Number(v) : v);
        return `${c}=?`;
      })
      .join(' AND ');
  }
  function query(table: string, s: Spec, alias: string, link = '', root = false): string {
    const cells = fields[table]!.filter((k) => !s.select || s.select[k]).flatMap((k) => [
      `'${k}'`,
      `${alias}.${column(k)}`,
    ]);
    for (const [key, childSpec] of Object.entries(s.with ?? {})) {
      if (key === '_count') {
        cells.push(`'_count'`, `json_object('posts',(SELECT count(*) FROM posts c WHERE c.user_id=${alias}.id))`);
        continue;
      }
      const [child, parentKey, childKey, many] = relation[table]![key]!;
      const sub = query(
        child,
        childSpec === true ? {} : (childSpec as Spec),
        `${alias}c`,
        key === 'tags'
          ? `EXISTS(SELECT 1 FROM post_tags j WHERE j.post_id=${alias}.id AND j.tag_id=${alias}c.id)`
          : `${alias}c.${column(childKey)}=${alias}.${column(parentKey)}`,
      );
      cells.push(
        `'${key}'`,
        many
          ? `json((SELECT coalesce(json_group_array(json(payload)),'[]') FROM (${sub})))`
          : `json((SELECT payload FROM (${sub}) LIMIT 1))`,
      );
    }
    const conditions = where(s.where, alias, table);
    const order = s.orderBy
      ? (Array.isArray(s.orderBy) ? s.orderBy : [s.orderBy])
          .flatMap((o: Native) =>
            Object.entries(o).map(
              ([k, v]) =>
                `${alias}.${column(k)} ${typeof v === 'string' ? v : (v as Native).sort} ${typeof v === 'object' ? `NULLS ${(v as Native).nulls}` : ''}`,
            ),
          )
          .join(',')
      : '';
    const width = fields[table]!.filter((k) => !s.select || s.select[k]).length * 2;
    const selection = root
      ? [
          ...fields[table]!.filter((k) => !s.select || s.select[k]).map((k) => `${alias}.${column(k)}`),
          ...Array.from(
            { length: (cells.length - width) / 2 },
            (_, i) => `${cells[width + i * 2 + 1]} AS ${cells[width + i * 2]!.replaceAll("'", '"')}`,
          ),
        ].join(',')
      : `json_object(${cells.join(',')}) AS payload`;
    return `SELECT ${selection} FROM ${table} ${alias} WHERE ${link ? `${link} AND ` : ''}${conditions}${order ? ` ORDER BY ${order}` : ''}${s.limit !== undefined ? ` LIMIT ${s.limit}` : ''}${s.offset ? ` OFFSET ${s.offset}` : ''}`;
  }
  const find = (table: string, s: Spec = {}, one = false) => {
    params.length = 0;
    if (s.with) {
      const sql = query(table, { ...s, ...(one ? { limit: 1 } : {}) }, 'r', '', true);
      const rows = db
        .prepare(sql)
        .all(...params)
        .map((r: Native) => decodeNested(table, r, s));
      return one ? (rows[0] ?? null) : rows;
    }
    const cond = where(s.where, 'r', table);
    const order = s.orderBy
      ? (Array.isArray(s.orderBy) ? s.orderBy : [s.orderBy])
          .flatMap((o: Native) =>
            Object.entries(o).map(
              ([k, v]) =>
                `${column(k)} ${typeof v === 'string' ? v : (v as Native).sort}${typeof v === 'object' ? ` NULLS ${(v as Native).nulls}` : ''}`,
            ),
          )
          .join(',')
      : '';
    const sql = `SELECT ${
      s.select
        ? Object.keys(s.select)
            .filter((k) => s.select[k])
            .map(column)
            .join(',')
        : '*'
    } FROM ${table} r WHERE ${cond}${order ? ` ORDER BY ${order}` : ''}${one ? ' LIMIT 1' : s.limit !== undefined ? ` LIMIT ${s.limit}` : ''}${s.offset ? ` OFFSET ${s.offset}` : ''}`;
    const rows = db
      .prepare(sql)
      .all(...params)
      .map((r: Native) => {
        const v = decodeRow(table, r);
        if (s.select) for (const k of Object.keys(v)) if (!s.select[k]) delete v[k];
        return v;
      });
    return one ? (rows[0] ?? null) : rows;
  };
  return {
    find,
    count: (table, w) => {
      params.length = 0;
      const sql = `SELECT count(*) n FROM ${table} r WHERE ${where(w, 'r', table)}`;
      return (db.prepare(sql).get(...params) as Native).n;
    },
    write: (op, i) => {
      if (op === 'increment')
        return decodeRow('posts', db.prepare('UPDATE posts SET view_count=view_count+1 WHERE id=1 RETURNING *').get()!);
      if (op === 'bulk') {
        const q = db.prepare(
          `INSERT INTO bench_writes(org_id,slug,label,amount,active,created_at) VALUES ${bulkRows.map(() => '(?,?,?,?,?,?)').join(',')} RETURNING *`,
        );
        return q
          .all(
            ...bulkRows.flatMap((r) => [
              r.orgId,
              r.slug,
              r.label,
              r.amount,
              Number(r.active),
              r.createdAt.toISOString(),
            ]),
          )
          .map((r) => decodeRow('bench_writes', r));
      }
      if (op === 'update')
        return decodeRow('bench_writes', db.prepare('UPDATE bench_writes SET amount=? WHERE id=1 RETURNING *').get(i)!);
      if (op === 'upsert')
        return decodeRow(
          'bench_writes',
          db
            .prepare(
              "INSERT INTO bench_writes(org_id,slug,label,amount) VALUES(1,'upsert','upsert',?) ON CONFLICT(slug) DO UPDATE SET amount=excluded.amount RETURNING *",
            )
            .get(i)!,
        );
      return decodeRow('bench_writes', db.prepare("DELETE FROM bench_writes WHERE slug='delete' RETURNING *").get()!);
    },
  };
}
function prismaSpec(s: Spec): Native {
  const { with: rels, limit, offset, relationLoadStrategy: _strategy, cursor, ...rest } = s;
  return {
    ...rest,
    ...(limit !== undefined ? { take: limit } : {}),
    ...(offset !== undefined ? { skip: offset } : {}),
    ...(cursor ? { cursor: { id: cursor.id }, skip: 1 } : {}),
    ...(rels
      ? {
          include: Object.fromEntries(
            Object.entries(rels).map(([k, v]) => [
              k,
              k === '_count' ? { select: v } : v === true ? true : prismaSpec(v as Spec),
            ]),
          ),
        }
      : {}),
  };
}
export async function openLane(
  name: string,
  file: string,
  options?: { sqliteBinding?: 'node:sqlite' | 'better-sqlite3' },
): Promise<Lane> {
  let db: Native, handle: Native;
  const lane: Lane = {
    name,
    kind:
      name === 'Turbine' && options?.sqliteBinding === 'better-sqlite3'
        ? 'better-sqlite3'
        : name === 'Turbine' || name === 'Raw'
          ? 'node:sqlite'
          : 'better-sqlite3',
    db: null,
    find: () => {
      throw new Error('Not initialized');
    },
    count: () => 0,
    dashboard: async () => [],
    write: () => 0,
    close: async () => {},
  };
  try {
    if (name === 'Turbine') {
      const { turbine, SCHEMA } = await import('./generated/sqlite-turbine/index.js');
      if (options?.sqliteBinding === 'better-sqlite3') {
        const { turbineBetterSqlite3 } = await import('turbine-orm/better-sqlite3');
        db = await turbineBetterSqlite3(file, SCHEMA, { logging: false, wal: true, foreignKeys: true });
      } else db = turbine(file, { logging: false, wal: true, foreignKeys: true });
      handle = db.pool.db;
      lane.close = async () => {
        await db.disconnect();
      };
      lane.find = (t, s = {}, one = false) => {
        if (t === 'bench_parents' && s.with?.children) {
          return db
            .table(t)
            .findMany({ ...s, with: { benchChildren: s.with.children } })
            .then((rows: Native[]) => rows.map(({ benchChildren, ...r }) => ({ ...r, children: benchChildren })));
        }
        return db.table(t)[one ? 'findUnique' : 'findMany'](s);
      };
      lane.count = (t, w) => db.table(t).count(w ? { where: w } : {});
      lane.write = (op, i) => {
        if (op === 'increment')
          return db.table('posts').update({ where: { id: 1 }, data: { viewCount: { increment: 1 } } });
        const q = db.table('bench_writes');
        if (op === 'bulk') return q.createMany({ data: bulkRows });
        if (op === 'update') return q.update({ where: { id: 1 }, data: { amount: i } });
        if (op === 'upsert')
          return q.upsert({
            where: { slug: 'upsert' },
            create: { orgId: 1, slug: 'upsert', label: 'upsert', amount: i },
            update: { amount: i },
          });
        return q.delete({ where: { slug: 'delete' } });
      };
    } else if (name === 'Raw') {
      handle = new DatabaseSync(file);
      lane.close = async () => handle.close();
      handle.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON');
      Object.assign(lane, createRaw(handle));
      lane.close = async () => handle.close();
      db = handle;
    } else if (name === 'Prisma 7') {
      const { PrismaClient } = await import('./generated/prisma-sqlite/index.js');
      const factory = new PrismaBetterSqlite3({ url: `file:${file}` }, { timestampFormat: 'iso8601' });
      const connect = factory.connect.bind(factory);
      factory.connect = async () => {
        const adapter = await connect();
        handle = (adapter as Native).client;
        return adapter;
      };
      db = new PrismaClient({ adapter: factory });
      lane.close = () => db.$disconnect();
      await db.$connect();
      await db.$queryRawUnsafe('PRAGMA journal_mode=WAL');
      await db.$executeRawUnsafe('PRAGMA synchronous=FULL');
      await db.$executeRawUnsafe('PRAGMA foreign_keys=ON');
      lane.find = (t, s = {}, one = false) => db[model[t]!][one ? 'findUnique' : 'findMany'](prismaSpec(s));
      lane.count = (t, w) => db[model[t]!].count(w ? { where: w } : {});
      lane.write = (op, i) => {
        if (op === 'increment') return db.post.update({ where: { id: 1 }, data: { viewCount: { increment: 1 } } });
        const q = db.benchWrite;
        if (op === 'bulk') return q.createManyAndReturn({ data: bulkRows });
        if (op === 'update') return q.update({ where: { id: 1 }, data: { amount: i } });
        if (op === 'upsert')
          return q.upsert({
            where: { slug: 'upsert' },
            create: { orgId: 1, slug: 'upsert', label: 'upsert', amount: i },
            update: { amount: i },
          });
        return q.delete({ where: { slug: 'delete' } });
      };
    } else {
      const rc = name === 'Drizzle RC',
        schema: Native = rc ? candidate : stable,
        ops: Native = rc ? rcOps : stableOps;
      handle = new BetterSqlite3(file);
      lane.close = async () => handle.close();
      handle.pragma('journal_mode = WAL');
      handle.pragma('synchronous = FULL');
      handle.pragma('foreign_keys = ON');
      db = rc
        ? drizzleRc({ client: handle, relations: candidate.relations, jit: true })
        : drizzle(handle, { schema: stable });
      lane.close = async () => handle.close();
      function expression(table: string, w: Native): Native {
        if (!w) return undefined;
        const t = schema[tableKey(table)];
        return ops.and(
          ...Object.entries(w).map(([k, v]) => {
            if (k === 'AND' || k === 'OR')
              return ops[k === 'AND' ? 'and' : 'or'](...(Array.isArray(v) ? v : [v]).map((x) => expression(table, x)));
            if (k === 'posts')
              return ops.exists(
                db
                  .select({ one: ops.sql`1` })
                  .from(schema.posts)
                  .where(ops.and(ops.eq(schema.posts.userId, t.id), expression('posts', (v as Native).some))),
              );
            if (v === null) return ops.isNull(t[k]);
            if (v && typeof v === 'object')
              return ops.and(
                ...Object.entries(v).map(([op, x]) =>
                  x === null
                    ? ops.isNotNull(t[k])
                    : ops[{ gt: 'gt', gte: 'gte', lt: 'lt', lte: 'lte', equals: 'eq', not: 'ne' }[op]!](t[k], x),
                ),
              );
            return ops.eq(t[k], v);
          }),
        );
      }
      function rcWhere(w: Native): Native {
        if (Array.isArray(w)) return w.map(rcWhere);
        if (w === null) return { isNull: true };
        if (typeof w !== 'object') return w;
        return Object.fromEntries(
          Object.entries(w).map(([k, v]) => [
            k,
            k === 'posts' && v && typeof v === 'object' && 'some' in v ? rcWhere((v as Native).some) : rcWhere(v),
          ]),
        );
      }
      function convert(table: string, s: Spec): Native {
        const { with: rels, where, orderBy, select, relationLoadStrategy: _strategy, ...rest } = s;
        const orders = orderBy ? (Array.isArray(orderBy) ? orderBy : [orderBy]) : [];
        const ordering = (t: Native) =>
          orders.flatMap((o: Native) =>
            Object.entries(o).map(([k, v]) =>
              typeof v === 'object'
                ? ops.sql`${t[k]} ${ops.sql.raw((v as Native).sort)} NULLS ${ops.sql.raw((v as Native).nulls)}`
                : ops[v as string](t[k]),
            ),
          );
        return {
          ...rest,
          ...(where ? { where: rc ? rcWhere(where) : expression(table, where) } : {}),
          ...(orderBy ? { orderBy: rc ? (t: Native) => ordering(t) : ordering(schema[tableKey(table)]) } : {}),
          ...(select ? { columns: select } : {}),
          ...(rels
            ? {
                with: Object.fromEntries(
                  Object.entries(rels).map(([k, v]) => [
                    k,
                    v === true ? true : convert(relation[table]![k]![0], v as Spec),
                  ]),
                ),
              }
            : {}),
        };
      }
      lane.find = (t, s = {}, one = false) => db.query[tableKey(t)][one ? 'findFirst' : 'findMany'](convert(t, s));
      lane.count = (t, w) => db.select({ n: ops.count() }).from(schema[tableKey(t)]).where(expression(t, w)).get().n;
      lane.write = (op, i) => {
        if (op === 'increment')
          return db
            .update(schema.posts)
            .set({ viewCount: ops.sql`${schema.posts.viewCount}+1` })
            .where(ops.eq(schema.posts.id, 1))
            .returning()
            .get();
        const t = schema.benchWrites;
        if (op === 'bulk') return db.insert(t).values(bulkRows).returning().all();
        if (op === 'update') return db.update(t).set({ amount: i }).where(ops.eq(t.id, 1)).returning().get();
        if (op === 'upsert')
          return db
            .insert(t)
            .values({ orgId: 1, slug: 'upsert', label: 'upsert', amount: i })
            .onConflictDoUpdate({ target: t.slug, set: { amount: i } })
            .returning()
            .get();
        return db.delete(t).where(ops.eq(t.slug, 'delete')).returning().get();
      };
      // All calls execute synchronously before the transaction callback returns.
      lane.dashboard = async (transaction) => {
        const reads = (d: Native) => [
          rc
            ? d.query.users.findFirst(convert('users', { where: { id: 1 } })).sync()
            : d.query.users.findFirst(convert('users', { where: { id: 1 } })).sync(),
          d.select({ n: ops.count() }).from(schema.posts).where(ops.eq(schema.posts.userId, 1)).get().n,
          d.select({ n: ops.count() }).from(schema.comments).where(ops.eq(schema.comments.userId, 1)).get().n,
          d.query.posts.findMany(convert('posts', { where: { userId: 1 }, orderBy: recentOrder, limit: 5 })).sync(),
          d.select({ n: ops.count() }).from(schema.users).get().n,
        ];
        return transaction
          ? db.transaction((tx: Native) => {
              if (!handle.inTransaction) throw new Error('Missing native transaction');
              return reads(tx);
            })
          : reads(db);
      };
    }
    lane.db = db;
    lane.handle = handle;
    const audit = { id: handleAudit.length + 1, name, closed: false, transactionAtClose: false, nativeClosed: false };
    handleAudit.push(audit);
    const close = lane.close;
    lane.close = async () => {
      audit.transactionAtClose = !!(handle.isTransaction ?? handle.inTransaction);
      await close();
      audit.nativeClosed = (handle.isOpen ?? handle.open) === false;
      audit.closed = true;
      if (!audit.nativeClosed || audit.transactionAtClose) throw new Error(`Native handle cleanup failed: ${name}`);
    };
    if (name === 'Turbine')
      lane.dashboard = (transaction) => {
        const queries = [
          db.table('users').buildFindUnique({ where: { id: 1 } }),
          db.table('posts').buildCount({ where: { userId: 1 } }),
          db.table('comments').buildCount({ where: { userId: 1 } }),
          db.table('posts').buildFindMany({ where: { userId: 1 }, orderBy: recentOrder, limit: 5 }),
          db.table('users').buildCount(),
        ];
        return transaction ? db.$transaction(queries) : db.pipeline(queries, { transactional: false });
      };
    if (name === 'Raw')
      lane.dashboard = async (transaction) => {
        if (transaction) db.exec('BEGIN');
        try {
          return [
            lane.find('users', { where: { id: 1 } }, true),
            lane.count('posts', { userId: 1 }),
            lane.count('comments', { userId: 1 }),
            lane.find('posts', { where: { userId: 1 }, orderBy: recentOrder, limit: 5 }),
            lane.count('users'),
          ];
        } finally {
          if (transaction) db.exec('ROLLBACK');
        }
      };
    if (name === 'Prisma 7')
      lane.dashboard = async (transaction) => {
        const reads = () => [
          db.user.findUnique({ where: { id: 1 } }),
          db.post.count({ where: { userId: 1 } }),
          db.comment.count({ where: { userId: 1 } }),
          db.post.findMany({ where: { userId: 1 }, orderBy: recentOrder, take: 5 }),
          db.user.count(),
        ];
        return transaction ? db.$transaction(reads()) : Promise.all(reads());
      };
    return lane;
  } catch (error) {
    await lane.close();
    throw error;
  }
}
export async function openLanes(file: string): Promise<Lane[]> {
  const lanes: Lane[] = [];
  try {
    for (const name of names) lanes.push(await openLane(name, file));
    return lanes;
  } catch (error) {
    for (const lane of lanes.reverse()) await lane.close();
    throw error;
  }
}
export async function closeLanes(lanes: Lane[]): Promise<string[]> {
  const closed: string[] = [],
    errors: unknown[] = [];
  for (const lane of [...lanes].reverse())
    try {
      await lane.close();
      closed.push(lane.name);
    } catch (e) {
      errors.push(e);
    }
  if (errors.length) throw new AggregateError(errors, 'SQLite lane cleanup failed');
  return closed;
}

export function relationCounts(lane: Lane): Native {
  if (lane.name === 'Turbine')
    return lane.find('users', { limit: 100, orderBy: { id: 'asc' }, with: { _count: { posts: true } } });
  if (lane.name === 'Prisma 7')
    return lane.db.user.findMany({
      take: 100,
      orderBy: { id: 'asc' },
      include: { _count: { select: { posts: true } } },
    });
  if (lane.name === 'Raw')
    return lane.find('users', { limit: 100, orderBy: { id: 'asc' }, with: { _count: { posts: true } } });
  const rc = lane.name === 'Drizzle RC',
    s: Native = rc ? candidate : stable,
    o: Native = rc ? rcOps : stableOps;
  const cols = Object.fromEntries(fields.users!.map((k) => [k, s.users[k]]));
  return lane.db
    .select({
      ...cols,
      postCount: o.sql`(SELECT count(*) FROM posts WHERE posts.user_id=${o.sql.raw('"users"."id"')})`,
    })
    .from(s.users)
    .orderBy(o.asc(s.users.id))
    .limit(100)
    .all()
    .map(({ postCount, ...row }: Native) => ({ ...row, _count: { posts: postCount } }));
}
export async function aggregate(lane: Lane): Promise<unknown> {
  if (lane.name === 'Turbine')
    return lane.db.table('posts').groupBy({
      by: ['orgId'],
      _count: true,
      _avg: { viewCount: true },
      having: { _count: { gt: 100 } },
      orderBy: { orgId: 'asc' },
    });
  if (lane.name === 'Prisma 7')
    return lane.db.post.groupBy({
      by: ['orgId'],
      _count: true,
      _avg: { viewCount: true },
      having: { orgId: { _count: { gt: 100 } } },
      orderBy: { orgId: 'asc' },
    });
  let rows: Native;
  if (lane.name === 'Raw')
    rows = lane.db
      .prepare(
        'SELECT org_id orgId,count(*) c,avg(view_count) a FROM posts GROUP BY org_id HAVING count(*)>100 ORDER BY org_id',
      )
      .all();
  else {
    const rc = lane.name === 'Drizzle RC',
      s: Native = rc ? candidate : stable,
      o: Native = rc ? rcOps : stableOps;
    rows = lane.db
      .select({ orgId: s.posts.orgId, c: o.count(), a: o.avg(s.posts.viewCount) })
      .from(s.posts)
      .groupBy(s.posts.orgId)
      .having(o.gt(o.count(), 100))
      .orderBy(o.asc(s.posts.orgId))
      .all();
  }
  return rows.map((r: Native) => ({ orgId: r.orgId, _count: r.c, _avg: { viewCount: Number(r.a) } }));
}

/** Untimed statement observation of the exact dashboard call; original methods are restored. */
export async function auditDashboard(
  lane: Lane,
  transaction: boolean,
  executeTransaction = transaction,
): Promise<unknown> {
  const h = lane.handle,
    events: { sql: string; method: string; transaction: boolean }[] = [];
  const prepare = h.prepare,
    exec = h.exec;
  h.prepare = function (sql: string, ...args: Native[]) {
    const stmt = prepare.call(this, sql, ...args);
    for (const method of ['get', 'all', 'run', 'iterate'])
      if (typeof stmt[method] === 'function') {
        const fn = stmt[method];
        stmt[method] = function (...values: Native[]) {
          events.push({ sql, method, transaction: !!(h.isTransaction ?? h.inTransaction) });
          return fn.apply(this, values);
        };
      }
    return stmt;
  };
  h.exec = function (sql: string, ...args: Native[]) {
    events.push({ sql, method: 'exec', transaction: !!(h.isTransaction ?? h.inTransaction) });
    return exec.call(this, sql, ...args);
  };
  try {
    await lane.dashboard(executeTransaction);
    const reads = events.filter((e) => /^\s*(?:SELECT|WITH)\b/i.test(e.sql));
    if (reads.length !== 5 || reads.some((e) => e.transaction !== transaction))
      throw new Error(`Native dashboard transaction scope mismatch: ${lane.name}: ${JSON.stringify(events)}`);
    if (h.isTransaction ?? h.inTransaction) throw new Error(`Dashboard left native transaction open: ${lane.name}`);
    return { arm: lane.name, transaction, events };
  } finally {
    h.prepare = prepare;
    h.exec = exec;
  }
}
