// Benchmark-only compiler. The caller must prove non-nullness in the filtered
// domain and supply a database-backed unique suffix; this is not schema inference.
export function quote(column) {
  if (typeof column !== 'string' || !column || column.includes('\u0000')) throw new TypeError('Invalid column identifier');
  return `"${column.replaceAll('"', '""')}"`;
}

export function compileTuple({ keys, cursor, uniqueSuffix, start = 1 }) {
  const refuse = (reason) => ({ supported: false, reason });
  if (!Array.isArray(keys) || keys.length === 0) return refuse('Nonempty sort keys required');
  if (!Number.isSafeInteger(start) || start < 1) return refuse('Positive parameter start required');
  if (start + keys.length - 1 > 65535) return refuse('PostgreSQL parameter limit exceeded');
  if (Array.from(keys).some((k, i) => !Object.hasOwn(keys, i) || !k || typeof k.column !== 'string' || !k.column || k.column.includes('\u0000'))) return refuse('Plain column keys required');
  if (new Set(keys.map((k) => k.column)).size !== keys.length) return refuse('Duplicate sort key');
  if (keys.some((k) => k.nullable !== false)) return refuse('Non-null filtered-domain proof required for every key');
  if (keys.some((k) => !['asc', 'desc'].includes(k.direction))) return refuse('Explicit direction required');
  if (keys.some((k) => k.direction !== keys[0].direction)) return refuse('Mixed directions require expanded lexicographic semantics');
  if (!Array.isArray(uniqueSuffix) || uniqueSuffix.length === 0 || uniqueSuffix.length > keys.length ||
    Array.from(uniqueSuffix).some((column, i) => !Object.hasOwn(uniqueSuffix, i) || typeof column !== 'string') ||
    uniqueSuffix.some((column, i) => column !== keys[keys.length - uniqueSuffix.length + i].column)) return refuse('Database-backed unique suffix required');
  if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor) ||
    keys.some((k) => !Object.hasOwn(cursor, k.column) || cursor[k.column] == null)) return refuse('Complete non-null cursor required');
  const params = keys.map((k) => cursor[k.column]);
  if (params.some((v) => !(typeof v === 'string' || typeof v === 'boolean' || typeof v === 'bigint' ||
    (typeof v === 'number' && Number.isFinite(v))))) return refuse('Only finite scalar cursor values supported');
  return { supported: true, sql: `(${keys.map((k) => quote(k.column)).join(', ')}) ${keys[0].direction === 'asc' ? '>' : '<'} (${keys.map((_, i) => `$${start + i}`).join(', ')})`, params };
}
