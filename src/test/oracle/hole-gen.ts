/**
 * Random `where` trees with `undefined` holes, paired with their intended form.
 *
 * Real code builds filters like `{ gte: from, lte: to }` where either bound may
 * be missing, so `undefined` shows up inside operator objects, relation filters
 * and combinator arrays. A generated case is two trees:
 *
 *   holey     what the caller passes, `undefined` values included
 *   intended  the same filter with every hole removed and every object that
 *             the removal emptied removed too, or `undefined` when nothing is
 *             left (the whole filter is absent)
 *
 * The contract being checked: `undefined` means absent. The library must answer
 * `holey` exactly as the model answers `intended`.
 *
 * Structure and presence are drawn from SEPARATE streams. The same `shape` seed
 * with a different `mask` renders the same filter shape with different holes,
 * which is what a cache keyed on structure has to survive.
 */

import type { Rng } from './rng.js';

export interface Mask {
  next(): boolean;
}

export const ALL_PRESENT: Mask = { next: () => true };

export function randomMask(rng: Rng, presentProbability: number): Mask {
  return { next: () => rng.chance(presentProbability) };
}

export interface Gen {
  /** The tree as the caller writes it, holes included. */
  holey: Record<string, unknown>;
  /** The tree with holes removed; `undefined` when nothing survives. */
  intended: Record<string, unknown> | undefined;
  /** Which kinds of hole this tree contains (for attributing a failure). */
  kinds: Set<string>;
}

export type FieldKind = 'int' | 'text' | 'bool' | 'textArray';

export interface FieldSpec {
  readonly key: string;
  readonly kind: FieldKind;
  readonly values: readonly unknown[];
  readonly nullable: boolean;
}

export interface RelationSpec {
  readonly key: string;
  readonly many: boolean;
  readonly target: string;
}

export interface TableGen {
  readonly name: string;
  readonly fields: readonly FieldSpec[];
  readonly relations: readonly RelationSpec[];
}

export type TableGens = Readonly<Record<string, TableGen>>;

const INT_OPS = ['equals', 'not', 'gt', 'gte', 'lt', 'lte', 'in', 'notIn'] as const;
const TEXT_OPS = ['equals', 'not', 'contains', 'startsWith', 'endsWith', 'in', 'notIn'] as const;
const TEXT_MODE_OPS = ['equals', 'not', 'contains', 'startsWith', 'endsWith'] as const;
const BOOL_OPS = ['equals', 'not'] as const;
const ARRAY_OPS = ['has', 'hasSome', 'hasEvery', 'isEmpty'] as const;

function union(...sets: Set<string>[]): Set<string> {
  const out = new Set<string>();
  for (const s of sets) for (const k of s) out.add(k);
  return out;
}

function opValue(shape: Rng, f: FieldSpec, op: string): unknown {
  const nonEmpty = f.values.filter((v) => v !== '');
  switch (op) {
    case 'in':
    case 'notIn':
      return shape.sample(f.values, shape.int(1, 3));
    case 'contains':
    case 'startsWith':
    case 'endsWith':
      return shape.pick(nonEmpty);
    case 'hasSome':
    case 'hasEvery':
      return shape.sample(f.values, shape.int(1, 2));
    case 'has':
      return shape.pick(f.values);
    case 'isEmpty':
      return shape.chance(0.5);
    case 'equals':
    case 'not':
      return f.nullable && shape.chance(0.12) ? null : shape.pick(f.values);
    default:
      return shape.pick(f.values);
  }
}

interface FieldGen {
  holey: unknown;
  intended: unknown;
  kinds: Set<string>;
}

function genField(shape: Rng, mask: Mask, f: FieldSpec): FieldGen {
  const kinds = new Set<string>();
  if (f.kind !== 'textArray' && shape.chance(0.2)) {
    const value = f.nullable && shape.chance(0.15) ? null : shape.pick(f.values);
    if (mask.next()) return { holey: value, intended: value, kinds };
    kinds.add('bare-undefined');
    return { holey: undefined, intended: undefined, kinds };
  }

  const useMode = f.kind === 'text' && shape.chance(0.25);
  const ops: readonly string[] =
    f.kind === 'int'
      ? INT_OPS
      : f.kind === 'bool'
        ? BOOL_OPS
        : f.kind === 'textArray'
          ? ARRAY_OPS
          : useMode
            ? TEXT_MODE_OPS
            : TEXT_OPS;
  const chosen = shape.sample(ops, shape.int(1, 3));
  const entries = chosen.map((op) => ({ op, value: opValue(shape, f, op), present: mask.next() }));
  const anyPresent = entries.some((e) => e.present);
  const modePresent = useMode && anyPresent && mask.next();
  if (useMode) entries.push({ op: 'mode', value: 'insensitive', present: modePresent });
  const order = shape.shuffle(entries);

  const holey: Record<string, unknown> = {};
  const intended: Record<string, unknown> = {};
  for (const e of order) {
    holey[e.op] = e.present ? e.value : undefined;
    if (e.present) intended[e.op] = e.value;
  }
  const realPresent = entries.filter((e) => e.op !== 'mode' && e.present).length;
  if (realPresent === 0) {
    kinds.add('field-emptied');
    return { holey, intended: undefined, kinds };
  }
  if (entries.some((e) => !e.present)) kinds.add('op-hole');
  return { holey, intended, kinds };
}

interface Options {
  /** Restrict to NOT NULL fields (used under `every`, where NULL predicates are ambiguous). */
  nullFree: boolean;
  /** Maximum nesting of combinators and relation filters. */
  maxDepth: number;
}

/** Generate one where-object over `tables[table]`. */
export function genWhere(shape: Rng, mask: Mask, tables: TableGens, table: string, depth: number, opts: Options): Gen {
  const spec = tables[table] as TableGen;
  const fields = opts.nullFree ? spec.fields.filter((f) => !f.nullable) : spec.fields;
  const count = shape.int(1, depth === 0 ? 3 : 2);
  const holey: Record<string, unknown> = {};
  const intended: Record<string, unknown> = {};
  const kinds: Set<string>[] = [];

  for (let i = 0; i < count; i++) {
    const r = shape.next();
    if (depth < opts.maxDepth && r < 0.12) {
      const key = shape.chance(0.5) ? 'AND' : 'OR';
      if (key in holey) continue;
      const g = genCombinator(shape, mask, tables, table, depth, opts);
      holey[key] = g.holey;
      if (g.intended !== undefined) intended[key] = g.intended;
      kinds.push(g.kinds);
    } else if (depth < opts.maxDepth && r < 0.2) {
      if ('NOT' in holey) continue;
      const body = genWhere(shape, mask, tables, table, depth + 1, opts);
      holey.NOT = body.holey;
      if (body.intended !== undefined) intended.NOT = body.intended;
      else kinds.push(new Set(['not-emptied']));
      kinds.push(body.kinds);
    } else if (depth < opts.maxDepth && r < 0.4 && spec.relations.length > 0) {
      const rel = shape.pick(spec.relations);
      if (rel.key in holey) continue;
      const g = genRelation(shape, mask, tables, rel, depth, opts);
      holey[rel.key] = g.holey;
      if (g.intended !== undefined) intended[rel.key] = g.intended;
      kinds.push(g.kinds);
    } else {
      const f = shape.pick(fields);
      if (f.key in holey) continue;
      const g = genField(shape, mask, f);
      holey[f.key] = g.holey;
      if (g.intended !== undefined) intended[f.key] = g.intended;
      kinds.push(g.kinds);
    }
  }
  if (Object.keys(holey).length === 0) {
    // Every draw collided with an earlier key; fall back to one plain field.
    const f = shape.pick(fields);
    const g = genField(shape, ALL_PRESENT, f);
    holey[f.key] = g.holey;
    intended[f.key] = g.intended;
  }
  return { holey, intended: Object.keys(intended).length > 0 ? intended : undefined, kinds: union(...kinds) };
}

function genCombinator(
  shape: Rng,
  mask: Mask,
  tables: TableGens,
  table: string,
  depth: number,
  opts: Options,
): { holey: unknown[]; intended: unknown[]; kinds: Set<string> } {
  const count = shape.int(2, 3);
  const kinds: Set<string>[] = [];
  const holey: unknown[] = [];
  const intended: unknown[] = [];
  for (let i = 0; i < count; i++) {
    const before = shape.clone();
    let child = genWhere(shape, mask, tables, table, depth + 1, opts);
    // An array whose elements all vanish would change meaning (`OR: []` matches
    // nothing), so the first element is regenerated with every hole filled.
    if (i === count - 1 && intended.length === 0 && child.intended === undefined) {
      child = genWhere(before, ALL_PRESENT, tables, table, depth + 1, opts);
    }
    holey.push(child.holey);
    if (child.intended !== undefined) intended.push(child.intended);
    else kinds.push(new Set(['combinator-element-emptied']));
    kinds.push(child.kinds);
  }
  return { holey, intended, kinds: union(...kinds) };
}

function genRelation(
  shape: Rng,
  mask: Mask,
  tables: TableGens,
  rel: RelationSpec,
  depth: number,
  opts: Options,
): { holey: Record<string, unknown>; intended: Record<string, unknown> | undefined; kinds: Set<string> } {
  const modes = rel.many ? ['some', 'every', 'none'] : ['is', 'isNot'];
  const chosen = shape.sample(modes, shape.int(1, 2));
  const holey: Record<string, unknown> = {};
  const intended: Record<string, unknown> = {};
  const kinds: Set<string>[] = [];
  for (const mode of chosen) {
    const body = genWhere(shape, mask, tables, rel.target, depth + 1, {
      ...opts,
      nullFree: opts.nullFree || mode === 'every',
    });
    const present = mask.next();
    if (!present) {
      holey[mode] = undefined;
      kinds.push(new Set(['rel-mode-hole']));
      continue;
    }
    holey[mode] = body.holey;
    kinds.push(body.kinds);
    if (body.intended !== undefined) intended[mode] = body.intended;
    else kinds.push(new Set(['rel-body-emptied']));
  }
  if (Object.keys(intended).length === 0) kinds.push(new Set(['rel-emptied']));
  return { holey, intended: Object.keys(intended).length > 0 ? intended : undefined, kinds: union(...kinds) };
}
