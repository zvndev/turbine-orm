/** Copy configuration containers synchronously; retain driver/resource identities. */
function snapshot<T>(value: T): T {
  if (Array.isArray(value)) return value.map(snapshot) as T;
  if (value instanceof Uint8Array) return Uint8Array.prototype.slice.call(value) as T;
  if (value && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, snapshot(entry)])) as T;
    }
  }
  return value;
}

export default snapshot;
