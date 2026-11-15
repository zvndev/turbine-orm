import type { turbine } from './generated/turbine/index.js';

// Compiled in the isolated consumer; never called by the app.
export async function checkGeneratedTypes(db: Awaited<ReturnType<typeof turbine>>) {
  // @ts-expect-error Generated accessors reject an unknown field.
  await db.users.findMany({ select: { missingField: true } });
  // @ts-expect-error Generated filters preserve the integer key type.
  await db.users.findMany({ where: { id: 'wrong type' } });
}

export function checkAsyncFactory(pending: ReturnType<typeof turbine>) {
  // @ts-expect-error MySQL construction is asynchronous; await it first.
  pending.users.findMany();
}
