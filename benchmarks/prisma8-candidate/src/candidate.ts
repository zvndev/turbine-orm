import postgres, { type PostgresTransactionContext } from '@prisma/orm-postgres/runtime';
import { contractFromJson } from '@prisma/orm-postgres/static';
import type pg from 'pg';
import type { Contract } from '../fixture/contract.d.js';
import contractJson from '../fixture/contract.json' with { type: 'json' };

export const contract = contractFromJson<Contract>(contractJson);
export const batchSize = 1000;
export function candidate(pool: pg.Pool | pg.Client, cursor = false) {
  return postgres({ contract, pg: pool, verifyMarker: false, ...(cursor ? { cursor: { batchSize } } : {}) });
}
export type Candidate = ReturnType<typeof candidate>;
type QueryContext = Pick<Candidate, 'orm'> | PostgresTransactionContext<Contract>;

// Each of these five reads is independent. Transactions use the same functions sequentially.
export function dashboardReads(db: QueryContext) {
  const { User, Post, Comment } = db.orm.public;
  return [
    () => User.whereUnique({ id: 1n }).first(),
    async () => (await Post.where({ userId: 1n }).aggregate((a) => ({ n: a.countBigInt() }))).n,
    async () => (await Comment.where({ userId: 1n }).aggregate((a) => ({ n: a.countBigInt() }))).n,
    () =>
      Post.where({ userId: 1n })
        .orderBy([(p) => p.createdAt.desc(), (p) => p.id.desc()])
        .limit(5)
        .all(),
    async () => (await User.aggregate((a) => ({ n: a.countBigInt() }))).n,
  ];
}
export async function dashboard(db: Candidate, route: 'independent' | 'sequential' | 'transaction') {
  if (route === 'independent') return Promise.all(dashboardReads(db).map((read) => read()));
  const sequential = async (context: QueryContext) => {
    const result: unknown[] = [];
    for (const read of dashboardReads(context)) result.push(await read());
    return result;
  };
  return route === 'transaction' ? db.transaction(sequential) : sequential(db);
}

export function headline(db: Candidate, index: number, i = 0): PromiseLike<unknown> {
  const { User, Comment } = db.orm.public;
  switch (index) {
    case 0:
      return User.orderBy((u) => u.id.asc())
        .limit(100)
        .all();
    case 1:
      return User.orderBy((u) => u.id.asc())
        .limit(50)
        .include('posts', (p) => p.orderBy((p) => p.id.asc()))
        .all();
    case 2:
      return User.orderBy((u) => u.id.asc())
        .limit(10)
        .include('posts', (p) =>
          p
            .orderBy((p) => p.id.asc())
            .limit(5)
            .include('comments', (c) => c.orderBy((c) => c.id.asc())),
        )
        .all();
    case 3:
      return User.whereUnique({ id: 1n }).first();
    case 4:
      return User.whereUnique({ id: 1n })
        .include('posts', (p) => p.orderBy((p) => p.id.asc()).include('comments', (c) => c.orderBy((c) => c.id.asc())))
        .first();
    case 5:
      return User.aggregate((a) => ({ n: a.countBigInt() })).then((r) => r.n);
    case 6:
      return Comment.orderBy((c) => c.id.asc()).all();
    case 9:
      return dashboard(db, 'transaction');
    case 10:
      return User.whereUnique({ id: BigInt((i % 50) + 1) }).first();
    default:
      throw new Error(`Prisma8 typed ORM route refused for headline index ${index}`);
  }
}

export function extended(db: Candidate, id: string, i = 0): PromiseLike<unknown> {
  const { User, Post, Comment, BenchWide, BenchWrite } = db.orm.public;
  switch (id) {
    case 'comments-5000':
      return Comment.orderBy((c) => c.id.asc())
        .limit(5000)
        .all();
    case 'comments-50000':
      return Comment.orderBy((c) => c.id.asc()).all();
    case 'wide-1000':
      return BenchWide.orderBy((r) => r.id.asc())
        .limit(1000)
        .all();
    case 'list-page3':
    case 'list-deep':
      return Post.where({ orgId: 1n, published: true })
        .orderBy([(p) => p.createdAt.desc(), (p) => p.id.desc()])
        .offset(id === 'list-page3' ? 40 : 9000)
        .limit(20)
        .all();
    case 'to-one':
      return Post.orderBy((p) => p.id.asc())
        .limit(500)
        .include('user')
        .all();
    case 'many-to-many':
      return Post.orderBy((p) => p.id.asc())
        .limit(200)
        .include('postTags', (j) => j.orderBy((j) => j.tagId.asc()).include('tag'))
        .all();
    case 'relation-count':
      return User.orderBy((u) => u.id.asc())
        .limit(100)
        .include('posts', (p) => p.count())
        .all()
        .then((rows) => rows.map(({ posts, ...row }) => ({ ...row, _count: { posts: String(posts) } })));
    case 'relation-filter':
      return User.where((u) => u.posts.some({ published: true }))
        .orderBy((u) => u.id.asc())
        .limit(100)
        .all();
    case 'group-by':
      return Post.groupBy('orgId')
        .having((a) => a.count().gt(100))
        .orderBy((g) => g.orgId.asc())
        .aggregate((a) => ({ c: a.countBigInt(), avgViews: a.avg('viewCount') }));
    case 'create-many':
      return BenchWrite.createAll(
        Array.from({ length: 1000 }, (_, n) => ({
          orgId: BigInt((n % 5) + 1),
          slug: `bulk-${n}`,
          label: `Bulk row ${n}`,
          amount: n % 997,
          active: true,
          createdAt: new Date('2023-11-14T22:13:20.000Z'),
        })),
      );
    case 'update':
      return BenchWrite.whereUnique({ id: 1n }).update({ amount: i });
    case 'upsert':
      return BenchWrite.upsert({
        create: {
          orgId: 1n,
          slug: 'upsert-target',
          label: 'new',
          amount: i,
          active: true,
          createdAt: new Date('2023-11-14T22:13:20.000Z'),
        },
        update: { amount: i },
        conflictOn: { slug: 'upsert-target' },
      });
    case 'delete':
      return BenchWrite.whereUnique({ slug: 'delete-target' }).delete();
    default:
      throw new Error(`Prisma8 extended route refused: ${id}`);
  }
}
