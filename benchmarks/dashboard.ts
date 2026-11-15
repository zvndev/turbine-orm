/** Shared workload policy: callers bind the same reads to their native APIs. */
import type { DeferredQuery, PipelineResults } from 'turbine-orm';
import type { TurbineClient } from '../generated/turbine/index.js';

export type DashboardMode = 'independent' | 'transaction';
export const dashboardOrder = [{ createdAt: 'desc' }, { id: 'desc' }] as const;

/** The rest-parameter pipeline overload defaults to a transaction; select the policy explicitly. */
export function turbineDashboard<T extends readonly DeferredQuery<unknown>[]>(
  db: Pick<TurbineClient, 'pipeline' | '$transaction'>,
  queries: readonly [...T],
  mode: DashboardMode,
): Promise<PipelineResults<T>> {
  return mode === 'independent'
    ? db.pipeline(queries, { transactional: false })
    : db.$transaction(queries, { isolationLevel: 'ReadCommitted' });
}

export interface DashboardReads {
  user(): Promise<unknown>;
  postCount(): Promise<unknown>;
  commentCount(): Promise<unknown>;
  recentPosts(): Promise<unknown>;
  userCount(): Promise<unknown>;
}

export async function dashboardReads(reads: DashboardReads, mode: DashboardMode): Promise<unknown[]> {
  if (mode === 'independent') {
    return Promise.all([reads.user(), reads.postCount(), reads.commentCount(), reads.recentPosts(), reads.userCount()]);
  }
  // Transaction-bound reads remain on their pinned connection and in order.
  return [
    await reads.user(),
    await reads.postCount(),
    await reads.commentCount(),
    await reads.recentPosts(),
    await reads.userCount(),
  ];
}

export const dashboardSql = [
  'SELECT * FROM users WHERE id = $1',
  'SELECT count(*) FROM posts WHERE user_id = $1',
  'SELECT count(*) FROM comments WHERE user_id = $1',
  'SELECT * FROM posts WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 5',
  'SELECT count(*) FROM users',
] as const;

export interface DashboardConnection {
  query(sql: string, values?: unknown[]): Promise<unknown>;
  release(): void;
}
export interface DashboardPool {
  query(sql: string, values?: unknown[]): Promise<unknown>;
  connect(): Promise<DashboardConnection>;
}

function sqlReads(db: Pick<DashboardPool, 'query'>): DashboardReads {
  return {
    user: () => db.query(dashboardSql[0], [1]),
    postCount: () => db.query(dashboardSql[1], [1]),
    commentCount: () => db.query(dashboardSql[2], [1]),
    recentPosts: () => db.query(dashboardSql[3], [1]),
    userCount: () => db.query(dashboardSql[4]),
  };
}

export async function rawDashboard(pool: DashboardPool, mode: DashboardMode): Promise<unknown[]> {
  if (mode === 'independent') return dashboardReads(sqlReads(pool), mode);
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    const result = await dashboardReads(sqlReads(client), mode);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
