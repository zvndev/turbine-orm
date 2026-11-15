import { ValidationError } from '../errors.js';

/** Native libSQL bindings after Turbine's SQLite value normalization. */
export type LibsqlValue = null | string | number | bigint | Uint8Array | ArrayBuffer;
export interface LibsqlStatement {
  sql: string;
  args?: Record<string, LibsqlValue>;
}
export interface LibsqlResultSet {
  columns: string[];
  columnTypes: string[];
  rows: { [index: number]: unknown }[];
  rowsAffected: number;
  lastInsertRowid?: bigint;
}

export function parameter(value: unknown): LibsqlValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1n : 0n;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ValidationError('libSQL bindings require finite numbers.');
    return Number.isSafeInteger(value) && !Object.is(value, -0) ? BigInt(value) : value;
  }
  if (typeof value === 'string' || typeof value === 'bigint') return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return value;
  const json = JSON.stringify(value);
  if (json === undefined) throw new ValidationError('Unsupported libSQL parameter value.');
  return json;
}

export function scalar(value: unknown): unknown {
  if (typeof value === 'bigint') {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : value.toString();
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return value;
}

export function decodeBoolean(value: unknown): unknown {
  return value === 1 || value === 1n || value === '1'
    ? true
    : value === 0 || value === 0n || value === '0'
      ? false
      : value;
}

export function decodeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function rows(result: LibsqlResultSet): Record<string, unknown>[] {
  return result.rows.map((native) => {
    const row: Record<string, unknown> = {};
    for (let index = 0; index < result.columns.length; index++) {
      const type = result.columnTypes[index] ?? '';
      let value = scalar(native[index]);
      if (/bool/i.test(type)) value = decodeBoolean(value);
      else if (/^jsonb?$/i.test(type)) value = decodeJson(value);
      Object.defineProperty(row, result.columns[index]!, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return row;
  });
}
