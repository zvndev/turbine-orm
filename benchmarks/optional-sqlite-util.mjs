// workerd 2026-07-30's node:util comparator calls propertyIsEnumerable directly
// on null-prototype objects made by the existing canonical validator. Preserve
// every enumerable key (including undefined), order and scalar, then delegate
// to that same runtime comparator. Only equivalence.ts's util import is mapped.
import { isDeepStrictEqual as nativeEqual } from 'node:util';

function ordinary(value) {
  if (Array.isArray(value)) return value.map(ordinary);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, cell]) => [key, ordinary(cell)]));
  return value;
}
export function isDeepStrictEqual(actual, expected) {
  return nativeEqual(ordinary(actual), ordinary(expected));
}
