import { evalSchema } from './schema-meta.js';
import { evalClient, closeClient } from './execute.js';
const s = await evalSchema();
const db = evalClient(s);
const t = (n: string) => db.table(n) as any;
async function probe(label: string, fn: () => Promise<unknown>) {
  try { const r = await fn(); console.log(`ACCEPTS  ${label.padEnd(44)} ${JSON.stringify(r).slice(0,70)}`); }
  catch (e: any) { console.log(`REJECTS  ${label.padEnd(44)} ${e.code}: ${String(e.message).slice(0,70)}`); }
}
console.log('--- snake_case key, same column, different arg positions ---');
await probe('where   { ledger_handle: ... }', () => t('affineurs').count({ where: { ledger_handle: 'aff-001' } }));
await probe('select  { ledger_handle: true }', () => t('affineurs').findMany({ limit:1, select: { ledger_handle: true } }));
await probe('omit    { ledger_handle: true }', () => t('affineurs').findMany({ limit:1, omit: { ledger_handle: true } }));
await probe('orderBy { ledger_handle: asc }', () => t('affineurs').findMany({ limit:1, select:{id:true}, orderBy: { ledger_handle: 'asc' } }));
await probe('distinct [ledger_handle]', () => t('affineurs').findMany({ distinct: ['ledger_handle'], select:{id:true}, limit:1 }));
await probe('groupBy by [rind_style]', () => t('cheese_wheels').groupBy({ by: ['rind_style'], _count: { id: true } }));
await probe('aggregate _avg { aroma_score }', () => t('ripening_checks').aggregate({ _avg: { aroma_score: true } }));
await probe('aggregate _count { id }', () => t('ripening_checks').aggregate({ _count: { id: true } }));
await probe('cursor  { ledger_handle }', () => t('affineurs').findMany({ limit:1, select:{id:true}, orderBy:{ledgerHandle:'asc'}, cursor: { ledger_handle: 'aff-001' } }));
console.log('--- camelCase control (all should accept) ---');
await probe('orderBy { ledgerHandle: asc }', () => t('affineurs').findMany({ limit:1, select:{id:true}, orderBy: { ledgerHandle: 'asc' } }));
await probe('groupBy by [rindStyle]', () => t('cheese_wheels').groupBy({ by: ['rindStyle'], _count: { id: true } }));
await probe('aggregate _avg { aromaScore }', () => t('ripening_checks').aggregate({ _avg: { aromaScore: true } }));
await closeClient();
