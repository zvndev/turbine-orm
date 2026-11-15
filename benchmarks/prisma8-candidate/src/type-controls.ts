import type { Candidate } from './candidate.js';

export async function typeControls(db: Candidate) {
  const selected = await db.orm.public.User.select('id', 'email').limit(1).all();
  const id: bigint | undefined = selected[0]?.id;
  const email: string | undefined = selected[0]?.email;
  // @ts-expect-error projection must omit unselected scalars
  selected[0]?.name;
  // @ts-expect-error unknown model must be rejected by the generated contract
  db.orm.public.MissingModel.all();
  // @ts-expect-error PK uses bigint, not lossy number
  db.orm.public.User.whereUnique({ id: 1 }).first();
  // @ts-expect-error unique lookup does not accept a nonunique name
  db.orm.public.User.whereUnique({ name: 'User 1' }).first();
  // @ts-expect-error unknown relation is not part of generated contract
  db.orm.public.User.include('missingRelation').all();
  // @ts-expect-error PostgreSQL ORM scalar update cannot stand in for atomic increment
  db.orm.public.Post.whereUnique({ id: 1n }).update({ viewCount: { increment: 1 } });
  return { id, email };
}
