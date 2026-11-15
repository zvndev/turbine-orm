import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const SIZE = 24000;
export const PAGE = 11;
export const row = (id) => ({ id, score: id % 19 === 0 ? null : Math.floor((id - 1) / 4) % 300,
  bucket: id % 100, label: `page:${id}:λ'\\` });
export const fixture = (size = SIZE) => Array.from({ length: size }, (_, i) => row(i + 1));
const orderedCache = new Map();
export function ordered(c) {
  if (orderedCache.has(c.id)) return orderedCache.get(c.id);
  const direction = c.desc ? -1 : 1;
  const rows = fixture(c.tiny ? 17 : SIZE).filter((r) => !c.selective || r.bucket === 7).sort((a, b) => {
    if (a.score === null || b.score === null) {
      if (a.score !== b.score) return a.score === null ? 1 : -1;
    } else if (a.score !== b.score) return direction * (a.score - b.score);
    return a.id - b.id;
  });
  orderedCache.set(c.id, rows);
  return rows;
}
export const CASES = [
  { id: 'tiny', tiny: true, offset: 3 },
  { id: 'deep', offset: 18003 },
  { id: 'final', offset: SIZE - 5 },
  { id: 'empty', offset: SIZE },
  { id: 'selective-deep', selective: true, offset: 201 },
  { id: 'selective-final', selective: true, offset: 237 },
  { id: 'selective-empty', selective: true, offset: 240 },
  { id: 'null-boundary', offset: SIZE - Math.floor(SIZE / 19) - 4 },
  { id: 'null-cursor', offset: SIZE - 30 },
  { id: 'mixed-desc', desc: true, offset: 18003 },
  { id: 'parents', parents: true, offset: 1 },
];
export const METHODS = ['offset', 'provided', 'locate'];
export const ARMS = ['raw', 'turbine'];
export const MODES = ['connection-cold', 'warm'];
export const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function expected(c) {
  if (c.parents) return [2, 3, 4].map((id) => ({ id, children: [2, 3, 4].map((n) => ({ id: (id - 1) * 13 + n, parent: id, label: `child:${id}:${n}` })) }));
  return ordered(c).slice(c.offset, c.offset + PAGE);
}
export function cursor(c) {
  if (c.parents) return { id: c.offset };
  const r = ordered(c)[c.offset - 1];
  assert.ok(r, `Missing cursor for ${c.id}`);
  return { score: r.score, id: r.id };
}
export function args(c, method, supplied = cursor(c)) {
  const common = c.parents ? {
    select: { id: true }, orderBy: { id: 'asc' }, limit: 3,
    with: { children: { select: { id: true, parent: true, label: true }, orderBy: { id: 'asc' }, offset: 1, limit: 3 } },
  } : {
    select: { id: true, score: true, bucket: true, label: true },
    where: c.selective ? { bucket: 7 } : { bucket: { gte: 0 } },
    orderBy: [{ score: { sort: c.desc ? 'desc' : 'asc', nulls: 'last' } }, { id: 'asc' }], limit: PAGE,
  };
  return method === 'offset' ? { ...common, offset: c.offset } : { ...common, cursor: supplied };
}
export function lookupArgs(c) {
  const a = args(c, 'offset');
  delete a.with;
  return { ...a, select: c.parents ? { id: true } : { score: true, id: true }, offset: c.offset - 1, limit: 1 };
}
export function verifyRows(actual, c, fault) {
  const oracle = structuredClone(expected(c));
  if (fault === 'oracle') oracle[0] = { ...oracle[0], id: -1 };
  assert.deepEqual(actual, oracle, `Independent ordered row/shape oracle: ${c.id}`);
  return digest(actual);
}
