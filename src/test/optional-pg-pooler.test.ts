import { turbineNeonWs, withNeonWs } from '../neon-ws.js';
import { createNotificationHub } from '../notification-hub.js';
import { poolerContract } from './fixtures/pg-pooler/contract.mjs';
import { skipGate } from './helpers.js';

const native = skipGate(
  !process.env.PG_POOLER_SESSION_URL ||
    !process.env.PG_POOLER_TRANSACTION_URL ||
    !process.env.PG_POOLER_DIRECT_URL ||
    !process.env.PG_POOLER_ADMIN_URL,
  'PGBOUNCER_URL contract requires PG_POOLER_SESSION_URL, PG_POOLER_TRANSACTION_URL, PG_POOLER_DIRECT_URL and PG_POOLER_ADMIN_URL (real session and transaction PgBouncer)',
);

native.it('optional PostgreSQL real pooler contracts (source)', { timeout: 60_000 }, async (test) => {
  await poolerContract({ createNotificationHub, turbineNeonWs, withNeonWs }, test, 'source');
});
