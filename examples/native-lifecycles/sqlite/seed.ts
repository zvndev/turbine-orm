import { defineSqliteSeed } from 'turbine-orm/sqlite/seed';

export default defineSqliteSeed(async (tx) => {
  await tx.raw`
    INSERT INTO users (id, display_name) VALUES (${2}, ${'Added by the seed'})
    ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name
  `;
  if (process.env.EXAMPLE_SEED_FAIL === '1') throw new Error('Requested seed rollback');
  const user = await tx.table<{ id: number; displayName: string }>('users').findUnique({ where: { id: 2 } });
  if (user?.displayName !== 'Added by the seed') throw new Error('Seed row was not stored');
});
