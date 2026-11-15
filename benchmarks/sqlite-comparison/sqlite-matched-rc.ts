/** Additional RC node:sqlite arm. The original better-sqlite3 catalog stays intact. */
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-rc/node-sqlite';
import * as ops from 'drizzle-rc';
import * as schema from '../sqlite-schema-rc.js';
import { bulkRows, recentOrder, type Lane, type Spec } from '../sqlite-comparison-clients.js';

// The two RC bindings expose the same query API with distinct driver types.
// biome-ignore lint/suspicious/noExplicitAny: benchmark-only driver comparison.
type Native = any;
const key = (table: string) => table.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const targets: Record<string, Record<string, string>> = {
  users: { posts: 'posts' },
  posts: { user: 'users', comments: 'comments', tags: 'tags', postTags: 'post_tags' },
  post_tags: { tag: 'tags' },
};
function where(w: Native): Native {
  if (Array.isArray(w)) return w.map(where);
  if (w === null) return { isNull: true };
  if (typeof w !== 'object') return w;
  return Object.fromEntries(
    Object.entries(w).map(([k, v]) => [
      k,
      k === 'posts' && v && typeof v === 'object' && 'some' in v ? where(v.some) : where(v),
    ]),
  );
}
function convert(table: string, spec: Spec): Native {
  const { with: rels, where: filter, orderBy, select, relationLoadStrategy: _strategy, ...rest } = spec;
  return {
    ...rest,
    ...(filter ? { where: where(filter) } : {}),
    ...(orderBy
      ? {
          orderBy: (t: Native) =>
            (Array.isArray(orderBy) ? orderBy : [orderBy]).flatMap((o: Native) =>
              Object.entries(o).map(([k, v]) =>
                typeof v === 'object'
                  ? ops.sql`${t[k]} ${ops.sql.raw((v as Native).sort)} NULLS ${ops.sql.raw((v as Native).nulls)}`
                  : v === 'desc'
                    ? ops.desc(t[k])
                    : ops.asc(t[k]),
              ),
            ),
        }
      : {}),
    ...(select ? { columns: select } : {}),
    ...(rels
      ? {
          with: Object.fromEntries(
            Object.entries(rels).map(([k, v]) => [k, v === true ? true : convert(targets[table]![k]!, v as Spec)]),
          ),
        }
      : {}),
  };
}
export function openMatchedRc(file: string): Lane {
  const handle = new DatabaseSync(file);
  try {
    handle.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON');
    const db: Native = drizzle({ client: handle, relations: schema.relations, jit: true });
    const count = (d: Native, table: string, filter?: Native) => {
      const t = (schema as Native)[key(table)];
      return d
        .select({ n: ops.count() })
        .from(t)
        .where(filter ? ops.and(...Object.entries(filter).map(([k, v]) => ops.eq(t[k], v))) : undefined)
        .get().n;
    };
    return {
      name: 'Drizzle RC',
      kind: 'node:sqlite',
      db,
      handle,
      find: (t, spec = {}, one = false) => db.query[key(t)][one ? 'findFirst' : 'findMany'](convert(t, spec)),
      count: (t, filter) => count(db, t, filter),
      dashboard: async (transaction) => {
        const reads = (d: Native) => [
          d.query.users.findFirst(convert('users', { where: { id: 1 } })).sync(),
          count(d, 'posts', { userId: 1 }),
          count(d, 'comments', { userId: 1 }),
          d.query.posts.findMany(convert('posts', { where: { userId: 1 }, orderBy: recentOrder, limit: 5 })).sync(),
          count(d, 'users'),
        ];
        return transaction
          ? db.transaction((tx: Native) => {
              if (!handle.isTransaction) throw new Error('Missing native transaction');
              return reads(tx);
            })
          : reads(db);
      },
      write: (operation, i) => {
        if (operation !== 'bulk')
          throw new Error('Matched adapter only includes the requested full-returning bulk write');
        return db.insert(schema.benchWrites).values(bulkRows).returning().all();
      },
      close: async () => {
        handle.close();
      },
    };
  } catch (error) {
    handle.close();
    throw error;
  }
}
