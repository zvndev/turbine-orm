import type { TurbineClient } from './generated/index.js';

// Checked against each actual archive's generated public client, never the
// repository source declarations. A missing type restriction fails tsc.
export function typeControls(db: TurbineClient) {
  // @ts-expect-error no invented model field
  db.users.findMany({ select: { invented: true } });
  // @ts-expect-error no invented relation
  db.users.findMany({ with: { invented: true } });
  // @ts-expect-error bigint identifiers use the generated numeric input type
  db.users.findUnique({ where: { id: 'not-an-id' } });
  // @ts-expect-error amount is numeric
  db.benchWrites.update({ where: { id: 1 }, data: { amount: 'wrong' } });
}
