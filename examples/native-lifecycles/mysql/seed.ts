import { defineMysqlSeed } from 'turbine-orm/mysql/seed';

export default defineMysqlSeed(async (tx) => {
  const users = tx.table<{ id: number; displayName: string }>('users');
  await users.upsert({
    where: { id: 2 },
    create: { id: 2, displayName: 'Added by the seed' },
    update: { displayName: 'Added by the seed' },
  });
  if (process.env.EXAMPLE_SEED_FAIL === '1') throw new Error('Requested seed rollback');
  const user = await users.findUnique({ where: { id: 2 } });
  if (user?.displayName !== 'Added by the seed') throw new Error('Seed row was not stored');
});
