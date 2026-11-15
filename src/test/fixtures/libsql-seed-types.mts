import type { TransactionClient } from 'turbine-orm';
import { defineLibsqlSeed, type LibsqlSeedClient, runLibsqlSeed } from 'turbine-orm/libsql/seed';

const fn = defineLibsqlSeed(async (tx) => {
  const exact: TransactionClient = tx;
  const back: LibsqlSeedClient = exact;
  await back.table<{ id: number; label: string }>('items').create({ data: { id: 1, label: 'typed' } });
  // @ts-expect-error Transaction callback handles do not own the client.
  await tx.disconnect();
  // @ts-expect-error The typed table requires a numeric id.
  await tx.table<{ id: number }>('items').create({ data: { id: 'wrong' } });
});
const result: Promise<void> = runLibsqlSeed('file:local.db', { tables: {}, enums: {} }, fn);
void result;
