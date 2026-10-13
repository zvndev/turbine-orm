/**
 * An independent evaluator for Turbine `where` trees, over table dumps.
 *
 * This is the oracle for the where-clause differentials. It shares no code with
 * the library: rows come from raw SQL (`dumpJson`), and a `where` is evaluated
 * with SQL's three-valued logic written out here. Only the shapes the lane's
 * generators produce are modelled; anything else throws, so a generator that
 * outgrows the model fails loudly instead of being silently "expected".
 *
 * Contract it encodes: a filter that is `undefined` is absent. Callers pass the
 * INTENDED tree (holes already removed); the model never has to guess how a hole
 * is read.
 */

export type Row = Record<string, unknown>;
/** SQL truth value: true, false, or NULL (unknown). */
export type K = true | false | null;

export const kNot = (a: K): K => (a === null ? null : !a);
export const kAnd = (xs: readonly K[]): K =>
  xs.some((x) => x === false) ? false : xs.some((x) => x === null) ? null : true;
export const kOr = (xs: readonly K[]): K =>
  xs.some((x) => x === true) ? true : xs.some((x) => x === null) ? null : false;

export interface ModelRelation {
  readonly many: boolean;
  readonly target: string;
  /** Field on the parent row. */
  readonly local: string;
  /** Field on the target row. */
  readonly remote: string;
}

export interface ModelTable {
  readonly rows: readonly Row[];
  readonly relations: Readonly<Record<string, ModelRelation>>;
}

export type Model = Readonly<Record<string, ModelTable>>;

/** snake_case column -> camelCase field, matching how introspection names fields. */
export function camel(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

export function camelRow(row: Record<string, unknown>): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) out[camel(k)] = v;
  return out;
}

const OPERATOR_KEYS = new Set([
  'equals',
  'not',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'notIn',
  'contains',
  'startsWith',
  'endsWith',
  'mode',
  'has',
  'hasSome',
  'hasEvery',
  'isEmpty',
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

/** Does `where` hold under SQL semantics for `row` of `table`? */
export function evalWhere(model: Model, table: string, where: unknown, row: Row): K {
  if (where === undefined) return true;
  if (!isPlainObject(where)) throw new Error(`model: where must be an object, got ${JSON.stringify(where)}`);
  const parts: K[] = [];
  const meta = model[table];
  if (!meta) throw new Error(`model: unknown table ${table}`);
  for (const [key, value] of Object.entries(where)) {
    if (value === undefined) throw new Error(`model: undefined at ${key}; pass the intended tree`);
    if (key === 'AND') {
      parts.push(kAnd((value as unknown[]).map((w) => evalWhere(model, table, w, row))));
    } else if (key === 'OR') {
      const list = value as unknown[];
      parts.push(list.length === 0 ? false : kOr(list.map((w) => evalWhere(model, table, w, row))));
    } else if (key === 'NOT') {
      parts.push(kNot(evalWhere(model, table, value, row)));
    } else if (meta.relations[key]) {
      parts.push(evalRelation(model, meta.relations[key] as ModelRelation, value, row));
    } else {
      parts.push(evalField(row[key], value));
    }
  }
  return kAnd(parts);
}

function related(model: Model, rel: ModelRelation, row: Row): Row[] {
  const parentKey = row[rel.local];
  if (parentKey === null || parentKey === undefined) return [];
  return (model[rel.target] as ModelTable).rows.filter((r) => r[rel.remote] === parentKey);
}

function evalRelation(model: Model, rel: ModelRelation, filter: unknown, row: Row): K {
  const kids = related(model, rel, row);
  const hit = (where: unknown): boolean[] => kids.map((k) => evalWhere(model, rel.target, where, k) === true);
  const parts: K[] = [];
  if (!isPlainObject(filter))
    throw new Error(`model: relation filter must be an object, got ${JSON.stringify(filter)}`);
  for (const [mode, body] of Object.entries(filter)) {
    if (rel.many) {
      if (mode === 'some') parts.push(hit(body).some(Boolean));
      else if (mode === 'none') parts.push(!hit(body).some(Boolean));
      // "every related row matches". Generators keep `every` bodies NULL-free so
      // the two readings of a NULL predicate cannot disagree.
      else if (mode === 'every') parts.push(hit(body).every(Boolean));
      else throw new Error(`model: unknown to-many mode ${mode}`);
    } else if (mode === 'is') {
      parts.push(body === null ? kids.length === 0 : hit(body).some(Boolean));
    } else if (mode === 'isNot') {
      parts.push(body === null ? kids.length > 0 : !hit(body).some(Boolean));
    } else {
      throw new Error(`model: unknown to-one mode ${mode}`);
    }
  }
  return kAnd(parts);
}

/** Three-way comparison for numbers, and for dates (rows loaded from JSON hold ISO strings). */
function cmp(a: unknown, b: unknown): number {
  const x =
    a instanceof Date ? a.getTime() : typeof a === 'string' && b instanceof Date ? Date.parse(a) : (a as number);
  const y = b instanceof Date ? b.getTime() : (b as number);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Equality that treats a Date and its ISO string as the same instant. */
function same(a: unknown, b: unknown): boolean {
  if (b instanceof Date) return (a instanceof Date ? a.getTime() : Date.parse(String(a))) === b.getTime();
  return a === b;
}

function lowerAscii(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

function evalField(cell: unknown, filter: unknown): K {
  if (filter === null) return cell === null;
  if (!isPlainObject(filter)) return cell === null ? null : same(cell, filter);
  const keys = Object.keys(filter);
  if (keys.length === 0 || !keys.every((k) => OPERATOR_KEYS.has(k))) {
    throw new Error(`model: unsupported field filter ${JSON.stringify(filter)}`);
  }
  const insensitive = filter.mode === 'insensitive';
  const norm = (v: unknown): unknown => (insensitive && typeof v === 'string' ? lowerAscii(v) : v);
  const c = norm(cell);
  const parts: K[] = [];
  for (const [op, raw] of Object.entries(filter)) {
    if (op === 'mode') continue;
    const v = norm(raw);
    switch (op) {
      case 'equals':
        parts.push(raw === null ? cell === null : c === null ? null : same(c, v));
        break;
      case 'not':
        // `not: { <operators> }` is the negation of that operator object (NULL stays NULL).
        parts.push(
          isPlainObject(raw)
            ? kNot(evalField(cell, raw))
            : raw === null
              ? cell !== null
              : c === null
                ? null
                : !same(c, v),
        );
        break;
      case 'gt':
        parts.push(c === null ? null : cmp(c, v) > 0);
        break;
      case 'gte':
        parts.push(c === null ? null : cmp(c, v) >= 0);
        break;
      case 'lt':
        parts.push(c === null ? null : cmp(c, v) < 0);
        break;
      case 'lte':
        parts.push(c === null ? null : cmp(c, v) <= 0);
        break;
      case 'in':
        parts.push(
          (raw as unknown[]).length === 0
            ? false
            : c === null
              ? null
              : (raw as unknown[]).some((x) => same(c, norm(x))),
        );
        break;
      case 'notIn':
        // NOT (c = ANY(list)): an empty list is TRUE even for a NULL cell.
        parts.push(
          (raw as unknown[]).length === 0
            ? true
            : c === null
              ? null
              : !(raw as unknown[]).some((x) => same(c, norm(x))),
        );
        break;
      case 'contains':
        parts.push(c === null ? null : (c as string).includes(v as string));
        break;
      case 'startsWith':
        parts.push(c === null ? null : (c as string).startsWith(v as string));
        break;
      case 'endsWith':
        parts.push(c === null ? null : (c as string).endsWith(v as string));
        break;
      case 'has':
        parts.push(cell === null ? null : (cell as unknown[]).includes(raw));
        break;
      case 'hasSome':
        parts.push(cell === null ? null : (raw as unknown[]).some((x) => (cell as unknown[]).includes(x)));
        break;
      case 'hasEvery':
        parts.push(cell === null ? null : (raw as unknown[]).every((x) => (cell as unknown[]).includes(x)));
        break;
      case 'isEmpty':
        parts.push(cell === null ? null : ((cell as unknown[]).length === 0) === raw);
        break;
      default:
        throw new Error(`model: unsupported operator ${op}`);
    }
  }
  return kAnd(parts);
}

/** Ids of the rows of `table` for which `where` is TRUE, ascending. */
export function matchingIds(model: Model, table: string, where: unknown): number[] {
  return (model[table] as ModelTable).rows
    .filter((r) => evalWhere(model, table, where, r) === true)
    .map((r) => Number(r.id))
    .sort((a, b) => a - b);
}
