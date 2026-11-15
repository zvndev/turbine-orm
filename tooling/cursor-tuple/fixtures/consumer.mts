import { QueryInterface, type FindManyArgs, type SchemaMetadata, type PgCompatPool } from 'turbine-orm';
interface Row { id: number; score: number }
const args: FindManyArgs<Row> = { cursorPredicate: 'tuple', cursor: { id: 1, score: 2 }, orderBy: { score: 'asc' } };
const legacy: FindManyArgs<Row> = { ...args, cursorPredicate: 'lexicographic' };
// @ts-expect-error closed opt-in contract
const invalid: FindManyArgs<Row> = { cursorPredicate: 'automatic' };
declare const schema: SchemaMetadata;
declare const pool: PgCompatPool;
const query = new QueryInterface<Row>(pool, 'items', schema);
query.buildFindMany(args);
query.findMany(legacy);
query.findFirst(args);
query.findManyStream(args);
query.findManyStreamBatches(args);
function generic<T extends object>(q: QueryInterface<T>, a: FindManyArgs<T>) { return q.buildFindMany(a); }
void generic; void invalid;
