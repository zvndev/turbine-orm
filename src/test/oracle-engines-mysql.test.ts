/**
 * Cross-engine oracle battery: MySQL against Postgres. Scenarios, comparison
 * and allowlist live in `oracle/engines/`. Tables are created in the database
 * MYSQL_URL names, prefixed `oe_`.
 *
 * Run: DATABASE_URL=... MYSQL_URL=mysql://user:pass@host:3306/db npx tsx --test src/test/oracle-engines-mysql.test.ts
 */

import { skipGate } from './helpers.js';
import { mysqlHarness, postgresHarness } from './oracle/engines/harness.js';
import { registerEngineBattery } from './oracle/engines/run.js';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const MYSQL_URL = process.env.MYSQL_URL ?? '';
const oracleGate = skipGate(!DATABASE_URL, 'requires DATABASE_URL (Postgres is the oracle)');
const engineGate = skipGate(!MYSQL_URL, 'requires MYSQL_URL pointing at a MySQL 8+ database');

registerEngineBattery({
  engine: mysqlHarness(MYSQL_URL || 'mysql://unset@unset/unset'),
  oracle: postgresHarness(DATABASE_URL || 'postgres://unset/unset', 'oe_mysql'),
  runners: DATABASE_URL ? engineGate : oracleGate,
  repro: 'DATABASE_URL=... MYSQL_URL=... npx tsx --test src/test/oracle-engines-mysql.test.ts',
});
