import * as stable from 'drizzle-orm';
import * as rc from 'drizzle-rc';
import { arms, decodeRaw, rawRead, selectedUsers, writeData, writeSql } from './optional-sqlite-contract.mjs';
import * as stableSchema from './sqlite-schema.ts';
import * as rcSchema from './sqlite-schema-rc.ts';

export function lanesFor(raw, turbine, drizzle, drizzleRc, prisma) {
  const drizzleLane = (db, sql, schema) => async (operation) => {
    const { users, benchTiny, benchWrites } = schema;
    if (operation === 'nullable-17') return db.select().from(benchTiny).orderBy(sql.asc(benchTiny.id));
    if (operation === 'flat-100' || operation === 'pk-1') {
      const selection = Object.fromEntries(Object.keys(selectedUsers).map((key) => [key, users[key]]));
      const query = db.select(selection).from(users).orderBy(sql.asc(users.id));
      const rows = operation === 'pk-1' ? await query.where(sql.eq(users.id, 1)).limit(1) : await query.limit(100);
      return operation === 'pk-1' ? rows[0] : rows;
    }
    const query =
      operation === 'insert-returning'
        ? db.insert(benchWrites).values(writeData)
        : operation === 'update-returning'
          ? db.update(benchWrites).set({ label: 'updated' }).where(sql.eq(benchWrites.id, 1))
          : db.delete(benchWrites).where(sql.eq(benchWrites.id, 1));
    return (await query.returning())[0];
  };
  return [
    {
      name: arms[0],
      run: async (operation) =>
        decodeRaw(
          operation,
          await raw(
            rawRead[operation] ??
              (operation === 'insert-returning'
                ? `${writeSql} RETURNING *`
                : operation === 'update-returning'
                  ? "UPDATE bench_writes SET label='updated' WHERE id=1 RETURNING *"
                  : 'DELETE FROM bench_writes WHERE id=1 RETURNING *'),
          ),
        ),
    },
    {
      name: arms[1],
      run: async (operation) => {
        if (operation === 'flat-100')
          return turbine.users.findMany({ select: selectedUsers, orderBy: { id: 'asc' }, limit: 100 });
        if (operation === 'pk-1') return turbine.users.findUnique({ where: { id: 1 }, select: selectedUsers });
        if (operation === 'nullable-17') return turbine.table('bench_tiny').findMany({ orderBy: { id: 'asc' } });
        const table = turbine.table('bench_writes');
        if (operation === 'insert-returning') return table.create({ data: writeData });
        if (operation === 'update-returning') return table.update({ where: { id: 1 }, data: { label: 'updated' } });
        return table.delete({ where: { id: 1 } });
      },
    },
    { name: arms[2], run: drizzleLane(drizzle, stable, stableSchema) },
    { name: arms[3], run: drizzleLane(drizzleRc, rc, rcSchema) },
    {
      name: arms[4],
      run: async (operation) => {
        if (operation === 'flat-100')
          return prisma.user.findMany({ select: selectedUsers, orderBy: { id: 'asc' }, take: 100 });
        if (operation === 'pk-1') return prisma.user.findUnique({ where: { id: 1 }, select: selectedUsers });
        if (operation === 'nullable-17') return prisma.benchTiny.findMany({ orderBy: { id: 'asc' } });
        if (operation === 'insert-returning') return prisma.benchWrite.create({ data: writeData });
        if (operation === 'update-returning')
          return prisma.benchWrite.update({ where: { id: 1 }, data: { label: 'updated' } });
        return prisma.benchWrite.delete({ where: { id: 1 } });
      },
    },
  ];
}

export function resetFor(raw) {
  return async (operation) => {
    if (operation === 'inspect')
      return (await raw('SELECT * FROM bench_writes ORDER BY id')).map((row) => decodeRaw('insert-returning', [row]));
    await raw('DELETE FROM bench_writes');
    if (operation === 'update-returning' || operation === 'delete-returning') await raw(writeSql);
    if (operation === 'delete-returning') await raw("UPDATE bench_writes SET label='updated' WHERE id=1");
  };
}
