/**
 * Result normalisation for cross-ORM parity comparison.
 *
 * The three ORMs return the same logical data in slightly different physical
 * shapes:
 *   - Prisma returns bigint PKs/FKs as JS `bigint`; Turbine and Drizzle (in
 *     `mode: 'number'`) return them as `number`.
 *   - All three return timestamps as `Date`, but structural equality on Date
 *     objects is fragile — we coerce to ISO strings.
 *   - Relation arrays come back in arbitrary order across ORMs (and across
 *     query plans), so any array of rows is sorted by primary key.
 *   - Prisma/Drizzle may include extra relation keys or omit nulls; we strip
 *     `undefined` and keep only the canonical column set per entity.
 *
 * `normalize()` produces a plain, deterministically-ordered JSON-safe value
 * that `assert.deepEqual` can compare directly.
 */

/**
 * Matches the two ISO-8601 timestamp renderings we see across the ORMs:
 *   - Date.toISOString():            2025-01-02T04:41:00.000Z
 *   - PG json_build_object string:   2025-01-02T04:41:00+00:00
 * Both denote the same instant; we re-parse to a single canonical ISO form.
 */
const ISO_TS = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:?\d{2}|Z)$/;

/** Recursively convert a value into a comparison-safe canonical form. */
export function canon(value: unknown): unknown {
  if (value === null || value === undefined) return null;

  // bigint -> number (Prisma returns bigint for BIGINT columns)
  if (typeof value === 'bigint') return Number(value);

  // Date -> ISO string
  if (value instanceof Date) return value.toISOString();

  // Timestamp string -> canonical ISO instant.
  // Turbine returns nested-relation date columns as PG JSON strings (e.g.
  // `...+00:00`) rather than Date objects (a documented Turbine cosmetic
  // inconsistency — see README). Re-parsing collapses both renderings to the
  // same absolute instant so we compare the data, not the formatting.
  if (typeof value === 'string' && ISO_TS.test(value)) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }

  if (Array.isArray(value)) {
    const items = value.map(canon);
    return sortByPk(items);
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    // Sort keys for stable structural comparison.
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      // Drop undefined (Prisma omits unselected fields rather than null-ing).
      if (v === undefined) continue;
      out[key] = canon(v);
    }
    return out;
  }

  // number / string / boolean pass through.
  return value;
}

/** Sort an array of row-objects by their `id` (primary key) ascending. */
function sortByPk(items: unknown[]): unknown[] {
  const allHaveId = items.every(
    (it) => it && typeof it === 'object' && !Array.isArray(it) && 'id' in (it as Record<string, unknown>),
  );
  if (!allHaveId) return items;
  return [...items].sort((a, b) => {
    const ai = Number((a as Record<string, unknown>)['id']);
    const bi = Number((b as Record<string, unknown>)['id']);
    return ai - bi;
  });
}

/**
 * Project a row down to an explicit set of keys, in canonical form. Used to
 * normalise away ORM-specific extra keys (e.g. Drizzle hydrating an unrequested
 * relation, or Prisma's `_count` wrappers) before comparison.
 */
export function pick(row: unknown, keys: string[]): Record<string, unknown> {
  const c = canon(row) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = k in c ? c[k] : null;
  return out;
}

/** Canonical column sets per entity (camelCase, matching Turbine output). */
export const COLUMNS = {
  user: ['id', 'orgId', 'email', 'name', 'role', 'avatarUrl', 'lastLoginAt', 'createdAt'],
  post: ['id', 'userId', 'orgId', 'title', 'content', 'published', 'viewCount', 'createdAt', 'updatedAt'],
  comment: ['id', 'postId', 'userId', 'body', 'createdAt'],
  organization: ['id', 'name', 'slug', 'plan', 'createdAt'],
} as const;

type EntityName = keyof typeof COLUMNS;

/**
 * Normalise a flat list of entity rows: pick the canonical columns, sort by PK.
 */
export function rows(list: unknown[], entity: EntityName): Record<string, unknown>[] {
  const cols = COLUMNS[entity] as readonly string[];
  const mapped = list.map((r) => pick(r, [...cols]));
  return sortByPk(mapped) as Record<string, unknown>[];
}

/** Normalise a single entity row (or null). */
export function row(value: unknown, entity: EntityName): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  return pick(value, [...(COLUMNS[entity] as readonly string[])]);
}

/**
 * Normalise a nested tree. `spec` maps a key to either an entity name (leaf
 * relation row set) or a nested spec object `{ __entity, <relKey>: spec }`.
 *
 * This lets us compare deeply-nested `with` results without the ORMs' extra
 * relation keys (e.g. a back-ref author object) leaking in.
 */
export type TreeSpec = {
  __entity: EntityName;
  __relations?: Record<string, { many: boolean; spec: TreeSpec }>;
};

export function tree(value: unknown, spec: TreeSpec): unknown {
  if (value === null || value === undefined) return null;
  const c = canon(value) as Record<string, unknown>;
  const cols = COLUMNS[spec.__entity] as readonly string[];
  const out: Record<string, unknown> = {};
  for (const k of cols) out[k] = k in c ? c[k] : null;
  if (spec.__relations) {
    for (const [relKey, rel] of Object.entries(spec.__relations)) {
      const child = c[relKey];
      if (rel.many) {
        const arr = Array.isArray(child) ? child : [];
        out[relKey] = sortByPk(arr.map((item) => tree(item, rel.spec)));
      } else {
        out[relKey] = tree(child ?? null, rel.spec);
      }
    }
  }
  return out;
}
