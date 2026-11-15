import type pg from 'pg';
import { bulkRows } from '../canonical/extended-equivalence.js';

type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient;
export function dates(value: unknown, field = ''): unknown {
  if (value === null || value instanceof Date) return value;
  if (
    typeof value === 'string' &&
    /^(created_at|updated_at|last_login_at|createdAt|updatedAt|lastLoginAt|d0[123])$/.test(field)
  ) {
    const d = new Date(value);
    if (!Number.isFinite(d.getTime())) throw new Error(`Invalid timestamp: ${field}`);
    return d;
  }
  if (Array.isArray(value)) return value.map((r) => dates(r));
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, dates(v, k)]));
  return value;
}
async function rows(db: Queryable, sql: string, values: unknown[] = []) {
  return dates((await db.query(sql, values)).rows);
}
const comments = `(SELECT coalesce(json_agg(c ORDER BY c.id), '[]') FROM comments c WHERE c.post_id = p.id)`;
function nested(deep = false, postLimit?: number, unique = false) {
  return `SELECT u.*, (SELECT coalesce(json_agg(x ORDER BY x.id), '[]') FROM
    (SELECT p.* ${deep ? `, ${comments} AS comments` : ''} FROM posts p WHERE p.user_id=u.id
    ORDER BY p.id ${postLimit === undefined ? '' : 'LIMIT $2'}) x) AS posts
    FROM users u ${unique ? 'WHERE u.id=1' : ''} ORDER BY u.id LIMIT $1`;
}
export function rawDashboardReads(db: Queryable) {
  return [
    async () => (await db.query('SELECT * FROM users WHERE id=$1', [1])).rows[0],
    async () => (await db.query('SELECT count(*) AS n FROM posts WHERE user_id=$1', [1])).rows[0].n,
    async () => (await db.query('SELECT count(*) AS n FROM comments WHERE user_id=$1', [1])).rows[0].n,
    async () =>
      (await db.query('SELECT * FROM posts WHERE user_id=$1 ORDER BY created_at DESC, id DESC LIMIT 5', [1])).rows,
    async () => (await db.query('SELECT count(*) AS n FROM users')).rows[0].n,
  ];
}
export async function rawDashboard(db: pg.Pool, route: 'independent' | 'sequential' | 'transaction') {
  if (route === 'independent') return Promise.all(rawDashboardReads(db).map((read) => read()));
  const client = route === 'transaction' ? await db.connect() : undefined;
  try {
    if (client) await client.query('BEGIN');
    const result: unknown[] = [];
    for (const read of rawDashboardReads(client ?? db)) result.push(await read());
    if (client) await client.query('COMMIT');
    return result;
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    throw error;
  } finally {
    client?.release();
  }
}
export async function rawHeadline(db: pg.Pool, index: number, i = 0): Promise<unknown> {
  switch (index) {
    case 0:
      return rows(db, 'SELECT * FROM users ORDER BY id LIMIT 100');
    case 1:
      return rows(db, nested(), [50]);
    case 2:
      return rows(db, nested(true, 5), [10, 5]);
    case 3:
      return (await db.query('SELECT * FROM users WHERE id=$1', [1])).rows[0];
    case 4:
      return ((await rows(db, nested(true, undefined, true), [1])) as unknown[])[0];
    case 5:
      return (await db.query('SELECT count(*) AS n FROM users')).rows[0].n;
    case 6:
      return rows(db, 'SELECT * FROM comments ORDER BY id');
    case 7:
      return (await db.query('UPDATE posts SET view_count=view_count+1 WHERE id=$1 RETURNING *', [1])).rows[0];
    case 9:
      return rawDashboard(db, 'transaction');
    case 10:
      return (await db.query('SELECT * FROM users WHERE id=$1', [(i % 50) + 1])).rows[0];
    default:
      throw new Error(`Raw route refused for headline index ${index}`);
  }
}
export async function rawExtended(db: pg.Pool, id: string, i = 0): Promise<unknown> {
  switch (id) {
    case 'comments-5000':
      return rows(db, 'SELECT * FROM comments ORDER BY id LIMIT 5000');
    case 'comments-50000':
      return rows(db, 'SELECT * FROM comments ORDER BY id');
    case 'wide-1000':
      return rows(db, 'SELECT * FROM bench_wide ORDER BY id LIMIT 1000');
    case 'list-page3':
    case 'list-deep':
      return rows(
        db,
        'SELECT * FROM posts WHERE org_id=$1 AND published=true ORDER BY created_at DESC, id DESC LIMIT 20 OFFSET $2',
        [1, id === 'list-page3' ? 40 : 9000],
      );
    case 'to-one':
      return rows(
        db,
        'SELECT p.*, (SELECT row_to_json(u) FROM users u WHERE u.id=p.user_id) AS "user" FROM posts p ORDER BY p.id LIMIT 500',
      );
    case 'many-to-many':
      return rows(
        db,
        `SELECT p.*, (SELECT json_agg(t ORDER BY t.id) FROM post_tags j JOIN tags t ON t.id=j.tag_id WHERE j.post_id=p.id) AS tags FROM posts p ORDER BY p.id LIMIT 200`,
      );
    case 'relation-count':
      return rows(
        db,
        'SELECT u.*, json_build_object(\'posts\', (SELECT count(*)::text FROM posts p WHERE p.user_id=u.id)) AS "_count" FROM users u ORDER BY u.id LIMIT 100',
      );
    case 'relation-filter':
      return rows(
        db,
        'SELECT u.* FROM users u WHERE EXISTS (SELECT 1 FROM posts p WHERE p.user_id=u.id AND p.published) ORDER BY u.id LIMIT 100',
      );
    case 'group-by':
      return rows(
        db,
        'SELECT org_id AS "orgId", count(*) AS c, avg(view_count) AS "avgViews" FROM posts GROUP BY org_id HAVING count(*)>100 ORDER BY org_id',
      );
    case 'create-many':
      return rows(
        db,
        `INSERT INTO bench_writes(org_id,slug,label,amount,active,created_at)
      SELECT * FROM unnest($1::bigint[],$2::text[],$3::text[],$4::int[],$5::boolean[],$6::timestamptz[]) RETURNING *`,
        [
          bulkRows.map((r) => r.orgId),
          bulkRows.map((r) => r.slug),
          bulkRows.map((r) => r.label),
          bulkRows.map((r) => r.amount),
          bulkRows.map((r) => r.active),
          bulkRows.map((r) => r.createdAt),
        ],
      );
    case 'update':
      return (await db.query('UPDATE bench_writes SET amount=$1 WHERE id=$2 RETURNING *', [i, 1])).rows[0];
    case 'upsert':
      return (
        await db.query(
          `INSERT INTO bench_writes(org_id,slug,label,amount,active,created_at) VALUES(1,$1,'new',$2,true,$3)
      ON CONFLICT(slug) DO UPDATE SET amount=excluded.amount RETURNING *`,
          ['upsert-target', i, new Date('2023-11-14T22:13:20Z')],
        )
      ).rows[0];
    case 'delete':
      return (await db.query('DELETE FROM bench_writes WHERE slug=$1 RETURNING *', ['delete-target'])).rows[0];
    default:
      throw new Error(`Raw extended route refused: ${id}`);
  }
}
