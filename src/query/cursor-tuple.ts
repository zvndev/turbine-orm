import { UnsupportedFeatureError, ValidationError } from '../errors.js';
import type { TableMetadata } from '../schema.js';
import { isPlainRecord } from './filters.js';

/** Array iteration must never accept holes or inherited indexed values as proof. */
function dense(value: unknown, accepts: (element: unknown) => boolean): value is unknown[] {
  if (!Array.isArray(value)) return false;
  for (let i = 0; i < value.length; i++) {
    if (!Object.hasOwn(value, i) || !accepts(value[i])) return false;
  }
  return true;
}

function objectField(value: unknown, key: string): unknown {
  return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}

const columnName = (value: unknown): value is string => typeof value === 'string' && value !== '';
const keyColumns = (value: unknown): boolean => dense(value, columnName);

/** Validate raw schema key shapes before the ordinary key planner can read them. */
export function assertTupleCursorMetadata(meta: TableMetadata): void {
  if (
    !keyColumns(meta.primaryKey) ||
    !dense(meta.uniqueColumns, keyColumns) ||
    !dense(meta.columns, (c) => columnName(objectField(c, 'name'))) ||
    !dense(meta.indexes, (i) => keyColumns(objectField(i, 'columns')))
  ) {
    refuseTupleCursor('Dense typed proof arrays required.');
  }
}

/** Validate the additive mode at the shared SQL/PowQL argument seam. */
export function assertCursorPredicateOption(args: Record<string, unknown>, supported: boolean): void {
  const mode = args.cursorPredicate;
  if (mode === undefined || mode === 'lexicographic') return;
  if (mode !== 'tuple') throw new ValidationError('`cursorPredicate` takes "lexicographic" or "tuple".');
  const cursor = args.cursor;
  if (!isPlainRecord(cursor) || !Object.values(cursor).some((v) => v !== undefined)) {
    throw new ValidationError('`cursorPredicate: "tuple"` requires a nonempty `cursor`.');
  }
  if (!supported) refuseTupleCursor('Unsupported dialect.');
  if (args.orderBy !== undefined) {
    const orders = Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy];
    if (!dense(orders, (o) => !!o && typeof o === 'object' && !Array.isArray(o))) {
      throw new ValidationError('Tuple orderBy needs dense objects.');
    }
    for (const order of orders) {
      for (const value of Object.values(order as Record<string, unknown>))
        if (value !== undefined) assertTupleOrder(value);
    }
  }
}

export function refuseTupleCursor(reason: string): never {
  throw new UnsupportedFeatureError('Tuple cursor', 'current dialect', reason);
}

/** Only builtin scalar btree domains, never user-defined types or expressions. */
const SCALARS =
  /^(?:int[248]|smallint|integer|bigint|serial|bigserial|float[48]|real|double precision|numeric|decimal|text|varchar|character(?: varying)?|char|bpchar|uuid|bool(?:ean)?|date|timestamp(?:tz| with(?:out)? time zone)?)(?![\s\S])/i;

/** One validated effective order supplies SQL, collection and the cache signature. */
export function tupleCursorFingerprint(
  meta: TableMetadata,
  terms: readonly { column: string; desc: boolean }[],
  cursor: ReadonlyMap<string, unknown>,
  args: { offset?: unknown; distinct?: unknown; orderBy?: unknown },
  inclusive: boolean,
  enums?: Readonly<Record<string, readonly string[]>>,
): string {
  // A standalone index may omit expressions or use a different collation.
  // Only canonical constraint keys establish this optional predicate's proof.
  const keys = [meta.primaryKey, ...meta.uniqueColumns];
  if (
    !dense(terms, (t) => columnName(objectField(t, 'column')) && typeof objectField(t, 'desc') === 'boolean') ||
    !dense(keys, keyColumns)
  ) {
    refuseTupleCursor('Dense typed proof arrays required.');
  }
  if (terms.some((t) => !cursor.has(t.column))) {
    throw new ValidationError('Cursor must include all effective order columns.');
  }
  if (inclusive || args.offset !== undefined || args.distinct !== undefined) {
    refuseTupleCursor('Use an exclusive cursor without offset/distinct.');
  }
  if (!terms.length || terms.some((t) => t.desc !== terms[0]!.desc)) {
    refuseTupleCursor('Use one order direction.');
  }
  const facts = terms.map((t) => {
    const c = meta.columns.find((c) => c.name === t.column);
    const primary = meta.primaryKey.includes(t.column);
    if (!c || (!primary && c.nullable !== false)) {
      refuseTupleCursor('Ordered columns need NOT NULL/PK proof.');
    }
    if (c.isArray || c.pgTypeSchema || typeof c.pgType !== 'string' || !SCALARS.test(c.pgType) || enums?.[c.pgType]) {
      refuseTupleCursor('Order by builtin scalar columns.');
    }
    const v = cursor.get(t.column);
    if (typeof v === 'number' && !Number.isFinite(v)) {
      throw new ValidationError('Tuple cursor numbers must be finite.');
    }
    if (v === null || (!['string', 'number', 'bigint', 'boolean'].includes(typeof v) && !(v instanceof Date))) {
      refuseTupleCursor('Use non-null scalar cursor values.');
    }
    return [t.column, t.desc, c.pgType, primary];
  });
  const suffix = keys.find(
    (k) => k.length > 0 && k.length <= terms.length && terms.slice(-k.length).every((t) => k.includes(t.column)),
  );
  if (!suffix) refuseTupleCursor('End the order with a proven unique key.');
  return `tuple:${JSON.stringify([facts, suffix])}`;
}

/** Refuse ordering extensions that the ordinary column renderer would ignore. */
export function assertTupleOrder(value: unknown): void {
  let sort = value;
  let plain = typeof value === 'string';
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const spec = value as Record<string, unknown>;
    if (spec.nulls !== undefined && spec.nulls !== 'first' && spec.nulls !== 'last') {
      throw new ValidationError('`nulls` takes "first" or "last".');
    }
    plain = Object.keys(spec).every((key) => key === 'sort' || key === 'nulls');
    sort = spec.sort;
  }
  if (!plain) refuseTupleCursor('Use column ordering without expressions/collation.');
  if (sort !== 'asc' && sort !== 'desc') throw new ValidationError('Tuple sort takes "asc" or "desc".');
}
