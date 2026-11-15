/** Preserve ReturnType annotations on ordinary relation-table wrappers. */
import type { QueryInterface, RelationDescriptor } from '../query/index.js';

interface Row {
  id: number;
  name: string;
}
interface Relations {
  children: RelationDescriptor<{ id: number }, 'many'>;
}
declare const rows: QueryInterface<Row, Relations>;

export function selected(): ReturnType<typeof rows.findMany> {
  return rows.findMany({ select: { id: true } });
}
export function omitted(): ReturnType<typeof rows.findFirst> {
  return rows.findFirst({ omit: { name: true } });
}
export function deferred(): ReturnType<typeof rows.buildFindMany> {
  return rows.buildFindMany({ select: { id: true } });
}
export function fullRow(): ReturnType<typeof rows.findMany> {
  return rows.findMany();
}
