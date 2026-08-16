/**
 * Canonicalisation and deep comparison.
 *
 * "Pass" means the model's rows are EQUAL to the reference rows, not similar.
 * The only latitude given is ordering, and only where the task did not ask for
 * an order: an unordered SQL result has no defined row order, so comparing it
 * order-sensitively would score the planner rather than the model. Each task
 * declares how much order is part of its answer.
 */

export type OrderMode =
  /** No order was requested anywhere: sort every array before comparing. */
  | 'none'
  /** Top-level order was requested; nested relation arrays were not. */
  | 'top'
  /** Order was requested at every level: compare positionally throughout. */
  | 'deep';

/**
 * Normalise a value into something JSON-comparable and stable.
 *
 * Dates become ISO strings (a Date and its ISO string are the same answer),
 * bigints become strings (json_agg counts arrive as either depending on path),
 * and `undefined` properties are dropped so "absent" and "explicitly
 * undefined" are one thing.
 */
export function normalise(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Object.is(value, -0) ? 0 : value;
  if (Array.isArray(value)) return value.map(normalise);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) continue;
      out[key] = normalise(v);
    }
    return out;
  }
  return value;
}

/** Stable stringify of an already-normalised value. */
export function stable(value: unknown): string {
  return JSON.stringify(value);
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(sortDeep);
    return [...items].sort((a, b) => (stable(a) < stable(b) ? -1 : stable(a) > stable(b) ? 1 : 0));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Sort nested arrays only, leaving the top level in the order produced. */
function sortNested(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function canonical(value: unknown, order: OrderMode): string {
  const n = normalise(value);
  if (order === 'deep') return stable(n);
  if (order === 'top') return stable(sortNested(n));
  return stable(sortDeep(n));
}

export interface CompareResult {
  equal: boolean;
  /** Short human description of the first divergence, for the failure log. */
  detail?: string;
}

export function compare(actual: unknown, expected: unknown, order: OrderMode): CompareResult {
  const a = canonical(actual, order);
  const e = canonical(expected, order);
  if (a === e) return { equal: true };

  const an = normalise(actual);
  const en = normalise(expected);
  const aLen = Array.isArray(an) ? an.length : null;
  const eLen = Array.isArray(en) ? en.length : null;
  if (aLen !== null && eLen !== null && aLen !== eLen) {
    return { equal: false, detail: `row count ${aLen} != expected ${eLen}` };
  }
  if (aLen !== null && eLen !== null && aLen > 0) {
    const aKeys = Object.keys((an as unknown[])[0] as object).sort();
    const eKeys = Object.keys((en as unknown[])[0] as object).sort();
    if (stable(aKeys) !== stable(eKeys)) {
      const missing = eKeys.filter((k) => !aKeys.includes(k));
      const extra = aKeys.filter((k) => !eKeys.includes(k));
      const parts: string[] = [];
      if (missing.length) parts.push(`missing keys [${missing.join(', ')}]`);
      if (extra.length) parts.push(`extra keys [${extra.join(', ')}]`);
      return { equal: false, detail: `same row count, ${parts.join('; ')}` };
    }
  }
  return { equal: false, detail: 'same shape, different values or order' };
}
