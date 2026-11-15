// Run after `npm run build`: npx tsx examples/sql-fragments.ts
// Compilation only. An application can execute the result with db.rawUnsafe.
import { postgresDialect } from 'turbine-orm';
import { compile, identifier, join, sql } from 'turbine-orm/sql';

const ids = [10, 20];
const scope = sql`${identifier('u', 'organization_id')} = ${7}`;
const selectedIds = ids.length ? sql`${identifier('u', 'id')} IN (${join(ids)})` : sql`1 = 0`;
const query = sql`SELECT ${identifier('u', 'id')} FROM ${identifier('public', 'users')} AS u WHERE ${join([scope, selectedIds], sql` AND `)}`;

console.log(compile(query, postgresDialect));
