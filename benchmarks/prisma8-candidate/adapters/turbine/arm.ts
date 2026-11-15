import type { PgCompatPool } from 'turbine-orm';
import { policy } from './definition.js';
import { installDriver } from './driver.mjs';
import { TurbineClient } from './generated/index.js';

type DashboardContext = Pick<TurbineClient, 'users' | 'posts' | 'comments'>;

function dashboardReads(db: DashboardContext) {
  return [
    () => db.users.findUnique({ where: { id: 1 } }),
    () => db.posts.count({ where: { userId: 1 } }),
    () => db.comments.count({ where: { userId: 1 } }),
    () => db.posts.findMany({ where: { userId: 1 }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], limit: 5 }),
    () => db.users.count(),
  ];
}

async function dashboard(db: TurbineClient, route: string) {
  if (route === 'independent') return Promise.all(dashboardReads(db).map((read) => read()));
  const sequential = async (context: DashboardContext) => {
    const values: unknown[] = [];
    for (const read of dashboardReads(context)) values.push(await read());
    return values;
  };
  if (route === 'sequential') return sequential(db);
  if (route === 'transaction') return db.$transaction(sequential);
  throw new Error(`Unsupported dashboard route: ${route}`);
}

function headline(db: TurbineClient, n: number, i: number) {
  switch (n) {
    case 0:
      return db.users.findMany({ limit: 100, orderBy: { id: 'asc' } });
    case 1:
      return db.users.findMany({ limit: 50, orderBy: { id: 'asc' }, with: { posts: { orderBy: { id: 'asc' } } } });
    case 2:
      return db.users.findMany({
        limit: 10,
        orderBy: { id: 'asc' },
        with: { posts: { limit: 5, orderBy: { id: 'asc' }, with: { comments: { orderBy: { id: 'asc' } } } } },
      });
    case 3:
      return db.users.findUnique({ where: { id: 1 } });
    case 4:
      return db.users.findUnique({
        where: { id: 1 },
        with: { posts: { orderBy: { id: 'asc' }, with: { comments: { orderBy: { id: 'asc' } } } } },
      });
    case 5:
      return db.users.count();
    case 6:
      return db.comments.findMany({ orderBy: { id: 'asc' } });
    case 9:
      return dashboard(db, 'transaction');
    case 10:
      return db.users.findUnique({ where: { id: (i % 50) + 1 } });
    default:
      throw new Error(`Headline row not admitted by buffered candidate: ${n}`);
  }
}

async function extended(db: TurbineClient, id: string, i: number) {
  switch (id) {
    case 'comments-5000':
      return db.comments.findMany({ limit: 5000, orderBy: { id: 'asc' } });
    case 'comments-50000':
      return db.comments.findMany({ orderBy: { id: 'asc' } });
    case 'wide-1000':
      return db.benchWide.findMany({ limit: 1000, orderBy: { id: 'asc' } });
    case 'list-page3':
    case 'list-deep':
      return db.posts.findMany({
        where: { orgId: 1, published: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        limit: 20,
        offset: id === 'list-page3' ? 40 : 9000,
      });
    case 'to-one':
      return db.posts.findMany({ limit: 500, orderBy: { id: 'asc' }, with: { user: true } });
    case 'many-to-many':
      return db.posts.findMany({ limit: 200, orderBy: { id: 'asc' }, with: { tags: { orderBy: { id: 'asc' } } } });
    case 'relation-count': {
      const rows = await db.users.findMany({ limit: 100, orderBy: { id: 'asc' }, with: { _count: { posts: true } } });
      return rows.map((row) => ({ ...row, _count: { posts: String(row._count.posts) } }));
    }
    case 'relation-filter':
      return db.users.findMany({ limit: 100, orderBy: { id: 'asc' }, where: { posts: { some: { published: true } } } });
    case 'group-by': {
      const rows = await db.posts.groupBy({
        by: ['orgId'],
        _count: true,
        _avg: { viewCount: true },
        having: { _count: { gt: 100 } },
        orderBy: { orgId: 'asc' },
      });
      return rows.map((row) => ({ orgId: row.orgId, c: row._count, avgViews: row._avg.viewCount }));
    }
    case 'create-many':
      return (
        await db.benchWrites.createMany({
          data: Array.from({ length: 1000 }, (_, n) => ({
            orgId: (n % 5) + 1,
            slug: `bulk-${n}`,
            label: `Bulk row ${n}`,
            amount: n % 997,
            active: true,
            createdAt: new Date('2023-11-14T22:13:20.000Z'),
          })),
        })
      ).sort((a, b) => a.id - b.id);
    case 'update':
      return db.benchWrites.update({ where: { id: 1 }, data: { amount: i } });
    case 'upsert':
      return db.benchWrites.upsert({
        where: { slug: 'upsert-target' },
        create: {
          orgId: 1,
          slug: 'upsert-target',
          label: 'new',
          amount: i,
          active: true,
          createdAt: new Date('2023-11-14T22:13:20.000Z'),
        },
        update: { amount: i },
      });
    case 'delete':
      return db.benchWrites.delete({ where: { slug: 'delete-target' } });
    default:
      throw new Error(`Extended row not admitted by buffered candidate: ${id}`);
  }
}

export function createArm({ pool, runtime, driver }: { pool: PgCompatPool; runtime: string; driver: string }) {
  installDriver(pool, runtime, driver);
  if (process.env.TURBINE_DISABLE_PREPARED === '1')
    throw new Error('Prepared policy conflicts with TURBINE_DISABLE_PREPARED');
  const db = new TurbineClient({
    pool,
    logging: false,
    warnOnUnlimited: false,
    preparedStatements: true,
    diagnostics: policy.diagnostics,
    relationLoadStrategy: 'join',
    defaultLimit: undefined,
    utcTimestamps: true,
  });
  if (db.pool !== pool) throw new Error('Turbine did not preserve the supplied pool');
  let closed = false;
  const open = () => {
    if (closed) throw new Error('Turbine comparator is closed');
  };
  return {
    pool,
    policy,
    runHeadline(n: number, i = 0) {
      open();
      return headline(db, n, i);
    },
    runExtended(id: string, i = 0) {
      open();
      return extended(db, id, i);
    },
    dashboard(route: string) {
      open();
      return dashboard(db, route);
    },
    async *stream() {
      open();
      // This intentionally awaits a complete buffered findMany. The optional
      // producer has no native Turbine cursor route or portal-proof seam.
      yield* await db.comments.findMany({ orderBy: { id: 'asc' } });
    },
    async close() {
      if (!closed) {
        closed = true;
        await db.disconnect();
      }
    },
  };
}
