import { UnsupportedFeatureError, ValidationError } from '../errors.js';
import { scanPlaceholders } from '../sql-placeholders.js';
import { findTransactionControl } from '../transaction-control.js';

export function unsupportedD1(feature: string): never {
  throw new UnsupportedFeatureError(
    feature,
    'd1',
    'D1 exposes prepared statements and native transactional batches, not a pinned SQL session. ' +
      'Use $batch for independent deferred statements; manage schema changes with D1 tooling.',
  );
}

/** Mask SQLite literals, identifiers and comments without changing offsets. */
function codeOnly(sql: string): string {
  const chars = sql.split('');
  let i = 0;
  while (i < sql.length) {
    const start = i;
    const c = sql[i];
    if (c === '-' && sql[i + 1] === '-') {
      i += 2;
      while (i < sql.length && sql[i] !== '\n') i++;
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) throw new ValidationError('D1 SQL has an unterminated comment.');
      i = end + 2;
    } else if (c === "'" || c === '"' || c === '`' || c === '[') {
      const end = c === '[' ? ']' : c;
      i++;
      let closed = false;
      while (i < sql.length) {
        if (sql[i++] !== end) continue;
        if (end !== ']' && sql[i] === end) {
          i++;
          continue;
        }
        closed = true;
        break;
      }
      if (!closed) throw new ValidationError('D1 SQL has an unterminated quoted value or identifier.');
    } else {
      i++;
      continue;
    }
    chars.fill(' ', start, i);
  }
  return chars.join('');
}

/** One data statement only. Validate the whole batch before preparing any member. */
export function d1StatementSql(sql: string, count: number): string {
  if (typeof sql !== 'string' || sql.trim() === '' || sql.includes('\u0000')) {
    throw new ValidationError('D1 requires non-empty SQL text without NUL bytes.');
  }
  const code = codeOnly(sql);
  const segments = code.split(';');
  if (segments.length > 2 || (segments.length === 2 && segments[1]!.trim() !== '')) {
    throw new ValidationError('D1 accepts one prepared data statement per item. Use $batch for multiple statements.');
  }
  const control = findTransactionControl(sql, 'sqlite');
  if (control[0]) unsupportedD1(`Raw ${control[0].label}`);
  if (!/^\s*(SELECT|WITH|INSERT|UPDATE|DELETE|EXPLAIN)\b/i.test(code)) {
    unsupportedD1('Schema, migration or session SQL through the D1 adapter');
  }
  if (!Number.isSafeInteger(count) || count < 0 || count > 100) {
    throw new ValidationError('D1 permits at most 100 bound parameters per statement.');
  }
  if (/[:@$][A-Za-z_]/.test(code)) {
    throw new ValidationError('D1 accepts numbered $1 or ?1 placeholders, not named placeholders.');
  }
  let out = '';
  let last = 0;
  let highest = 0;
  for (const token of scanPlaceholders(sql, 'sqlite')) {
    let end = token.end;
    if (token.kind === 'question') {
      while (/\d/.test(sql[end] ?? '')) end++;
    }
    const digits = token.kind === 'question' ? sql.slice(token.end, end) : token.name;
    const index = Number(digits);
    if (!digits || !Number.isSafeInteger(index) || index < 1 || index > count) {
      throw new ValidationError('D1 placeholders must be numbered $1 or ?1 and name a supplied parameter.');
    }
    highest = Math.max(highest, index);
    out += `${sql.slice(last, token.start)}?${index}`;
    last = end;
  }
  if (highest !== count) throw new ValidationError('D1 parameter count does not match the numbered placeholders.');
  return out + sql.slice(last);
}

/** D1 binds JS numbers, not BigInt. Never silently round an exact integer. */
export function d1Param(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new ValidationError(
        'D1 numeric bindings require finite numbers and safe integers; use text for exact large integers.',
      );
    }
    return value;
  }
  if (typeof value === 'bigint') {
    const number = Number(value);
    if (!Number.isSafeInteger(number)) {
      throw new ValidationError('D1 cannot bind an exact BigInt outside the JavaScript safe-integer range; use text.');
    }
    return number;
  }
  if (typeof value === 'string') return value;
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new ValidationError('D1 cannot bind an invalid Date.');
    return value.toISOString();
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value).slice().buffer;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice().buffer;
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      throw new ValidationError('D1 object bindings must be JSON serializable.');
    }
  }
  throw new ValidationError('Unsupported D1 bound value. Use null, a scalar, Date, bytes or JSON.');
}
