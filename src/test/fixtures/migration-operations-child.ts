import { migrateDeploy } from '../../cli/migrate.js';
import { migrateMysqlDeploy } from '../../cli/mysql-migrate.js';
import { migrateSqliteDeploy } from '../../cli/sqlite-migrate.js';

const engine = process.env.MIGRATION_OPERATIONS_ENGINE;
const target = process.env.MIGRATION_OPERATIONS_URL!;
const dir = process.env.MIGRATION_OPERATIONS_DIR!;
const schema = process.env.MIGRATION_OPERATIONS_SCHEMA;
const run = engine === 'postgres' ? migrateDeploy : engine === 'mysql' ? migrateMysqlDeploy : migrateSqliteDeploy;
const result = await run(target, dir, { schema });
process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.errors.length) process.exitCode = 1;
