/**
 * turbine-orm: explicit JSON values for json / jsonb writes.
 *
 * A JS string written to a json/jsonb column is RAW JSON TEXT: `'{"a":1}'`
 * stores the object `{ a: 1 }`, which is how `JSON.stringify(value)` callers
 * have always written documents. That rule leaves no way to store a JSON
 * STRING (`"hello"`) or a JSON `null` (as opposed to SQL NULL).
 * `jsonValue(v)` is that way: the wrapped value is serialized with
 * `JSON.stringify` on every engine and every write path, so
 *
 *   jsonValue('hello') stores the JSON string "hello"
 *   jsonValue(null)    stores the JSON value null (the column is NOT SQL NULL)
 *   jsonValue([1, 2])  stores the JSON array [1, 2]
 *
 * The brand is a `Symbol.for` key so a copy of the package loaded twice (ESM
 * and CJS) still recognizes the other copy's values, and so `JSON.parse` can
 * never produce one from request data.
 */

const JSON_VALUE_BRAND: unique symbol = Symbol.for('turbine-orm.jsonValue');

/** A value marked for `JSON.stringify` serialization. Create with {@link jsonValue}. */
export interface JsonValue<T = unknown> {
  readonly [JSON_VALUE_BRAND]: true;
  /** The wrapped value, exactly as passed to {@link jsonValue}. */
  readonly value: T;
  /** `JSON.stringify(wrapper)` serializes the wrapped value, never the wrapper. */
  toJSON(): T;
}

/**
 * Mark `value` to be written as JSON. See the module comment for why a plain
 * string cannot mean this. Throws (E003 at write time) only when the value is
 * not JSON-serializable, e.g. a `bigint` or `undefined`.
 */
export function jsonValue<T>(value: T): JsonValue<T> {
  const wrapper = {
    [JSON_VALUE_BRAND]: true as const,
    value,
    toJSON: () => value,
    // node-postgres calls `toPostgres` for an object param before its own
    // JSON fallback; a wrapper that reaches the driver unresolved still binds
    // the serialized text rather than `{"value":...}`.
    toPostgres: () => serializeJsonValue(value),
  };
  return Object.freeze(wrapper) as JsonValue<T>;
}

/** Whether `value` was produced by {@link jsonValue} (any loaded copy of the package). */
export function isJsonValue(value: unknown): value is JsonValue {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[JSON_VALUE_BRAND] === true;
}

/**
 * The JSON text a json/jsonb column receives for `value`. `undefined` (and a
 * function or symbol) has no JSON form and `JSON.stringify` returns
 * `undefined` for it; a `bigint` makes it throw. Both surface as `undefined`
 * here so the caller can raise its own E003 naming the column.
 */
export function serializeJsonValue(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}
