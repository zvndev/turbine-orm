import type { TransactionClient } from 'turbine-orm';
import { defineLibsqlSeed, type LibsqlSeedClient, runLibsqlSeed } from 'turbine-orm/libsql/seed';

const fn = defineLibsqlSeed(async (tx) => {
  const exact: TransactionClient = tx;
  const back: LibsqlSeedClient = exact;
  await back.$transaction(async (inner) => {
    await inner.raw`SELECT ${1}`;
  });
  // @ts-expect-error Transaction callback handles do not own the client.
  await tx.disconnect();
});
const result: Promise<void> = runLibsqlSeed('file:local.db', { tables: {}, enums: {} }, fn);
void result;
