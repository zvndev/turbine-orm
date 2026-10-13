/**
 * Cross-engine oracle battery: SQL Server against Postgres. Scenarios,
 * comparison and allowlist live in `oracle/engines/`. Tables are created in the
 * database MSSQL_URL names, prefixed `oe_`.
 *
 * Run: DATABASE_URL=... MSSQL_URL=mssql://sa:pass@host:1433/db npx tsx --test src/test/oracle-engines-mssql.test.ts
 */

import { skipGate } from './helpers.js';
import { mssqlHarness, postgresHarness } from './oracle/engines/harness.js';
import { registerEngineBattery } from './oracle/engines/run.js';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const MSSQL_URL = process.env.MSSQL_URL ?? '';
const oracleGate = skipGate(!DATABASE_URL, 'requires DATABASE_URL (Postgres is the oracle)');
const engineGate = skipGate(!MSSQL_URL, 'requires MSSQL_URL pointing at a SQL Server 2016+ database');

registerEngineBattery({
  engine: mssqlHarness(MSSQL_URL),
  oracle: postgresHarness(DATABASE_URL || 'postgres://unset/unset', 'oe_mssql'),
  runners: DATABASE_URL ? engineGate : oracleGate,
  repro: 'DATABASE_URL=... MSSQL_URL=... npx tsx --test src/test/oracle-engines-mssql.test.ts',
});
