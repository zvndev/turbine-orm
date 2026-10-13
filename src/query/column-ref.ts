/**
 * turbine-orm: branded column references
 *
 * `{ equals: col('publishedVersionId') }` compares a column against another
 * column of the same row instead of against a bound value. The reference is
 * written into the SQL TEXT (`"a" = "b"`), so it is the one operand that
 * removes the bound value entirely.
 *
 * That is why it carries a brand. A plain `{ col: 'id' }` object is exactly
 * what `JSON.parse` produces from a request body, and when the plain shape was
 * the reference, `delete({ where: { id: body.id } })` with a body of
 * `{"id":{"equals":{"col":"id"}}}` compiled to `WHERE "id" = "id"` and deleted
 * every row. A symbol cannot come out of `JSON.parse`, a query string, a form
 * body or a `structuredClone` of parsed input, so only code can build one. Same
 * reasoning as the `UNSAFE` sentinel.
 *
 * `Symbol.for` rather than `Symbol()` because the package ships dual ESM and
 * CJS builds: a reference built by one copy must be recognized by the other.
 */

import { ValidationError } from '../errors.js';

/** The brand every {@link ColumnRef} carries. Registered, see the module note. */
export const COLUMN_REF: unique symbol = Symbol.for('turbine-orm.columnRef');

/**
 * A column-to-column comparison operand, built only by {@link col}.
 *
 * Accepted by `equals`, `not`, `gt`, `gte`, `lt` and `lte` on a non-JSON
 * column. The referenced field resolves through the table's column map
 * (camelCase or snake_case) and compiles to a quoted identifier, so no
 * parameter is bound. An unknown field throws `ValidationError` (E003), and
 * `mode: 'insensitive'` cannot be combined with a reference.
 *
 * `F` narrows the referenced name to the table's field names when the
 * surrounding where clause knows the entity type.
 *
 * ```ts
 * import { col } from 'turbine-orm';
 * where: { currentVersionId: { equals: col('publishedVersionId') } }
 * // → WHERE "current_version_id" = "published_version_id"
 * ```
 */
export interface ColumnRef<F extends string = string> {
  readonly col: F;
  readonly [COLUMN_REF]: true;
}

/**
 * Build a column reference: `{ gt: col('startsAt') }` compares against the
 * `startsAt` column of the same row.
 */
export function col<F extends string>(name: F): ColumnRef<F> {
  if (typeof name !== 'string' || name.length === 0) {
    throw new ValidationError('col() takes the name of a field on the table, as a non-empty string.');
  }
  const ref = { col: name } as { col: F; [COLUMN_REF]: true };
  // Non-enumerable so a reference prints and compares as `{ col }`; a symbol
  // key is never visited by `Object.keys`, so no where walker sees it either.
  Object.defineProperty(ref, COLUMN_REF, { value: true, enumerable: false });
  return Object.freeze(ref);
}

/** True only for a reference built by {@link col}. */
export function isColumnRef(value: unknown): value is ColumnRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { [COLUMN_REF]?: unknown })[COLUMN_REF] === true &&
    typeof (value as { col?: unknown }).col === 'string'
  );
}

/**
 * True for the UNBRANDED `{ col: '<name>' }` shape: the spelling a column
 * reference used to have, and what parsed request data produces. Callers
 * refuse it with {@link plainColumnRefMessage} rather than reading it as a
 * value, because the person who wrote it almost certainly meant a reference.
 */
export function isPlainColumnRefShape(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isColumnRef(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === 'col' && typeof (value as { col?: unknown }).col === 'string';
}

/** The refusal for a plain `{ col }` object at an operand position. */
export function plainColumnRefMessage(value: { col: string }, operator: string, column: string, table: string): string {
  const name = JSON.stringify(value.col);
  return (
    `A plain { col: ${name} } object at '${operator}' on "${column}" for table "${table}" is not a column ` +
    `reference. Build one with col(${name}) (import { col } from 'turbine-orm'): references carry a ` +
    'symbol brand so that parsed request data can never name a column. To compare against a value, pass a ' +
    'string, number, boolean, bigint, Date or Buffer.'
  );
}
