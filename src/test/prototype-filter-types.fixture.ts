/** Strict compiler fixture. Functions are deliberately never executed. */
import { col } from '../query/column-ref.js';
import type { QueryInterface, RelationDescriptor, WhereClause } from '../query/index.js';

interface PrototypeRow {
  id: number;
  __proto__: string;
  constructor: string | null;
  toString: string | null;
  valueOf: string | null;
  createdAt: Date;
  labels: string[];
  payload: unknown;
}
interface Child {
  id: number;
  title: string;
}
interface Relations {
  children: RelationDescriptor<Child, 'many', ChildRelations>;
}
interface ChildRelations {
  parent: RelationDescriptor<PrototypeRow, 'one', Relations>;
}
interface ControlRow extends PrototypeRow {
  OR: string;
}
declare const controlRows: QueryInterface<ControlRow>;
declare const rows: QueryInterface<PrototypeRow>;
declare const strict: QueryInterface<PrototypeRow, Relations>;
// biome-ignore lint/complexity/noBannedTypes: regression must reject the inherited constructor Function type
declare const suppliedFunction: Function;
declare const inputUnion: { id: number } | { constructor: typeof suppliedFunction };

declare const optionalFilter: { id: number } | undefined;

export async function accepted(): Promise<void> {
  const where = { id: 1 };
  await rows.findFirst({ where });
  await rows.findMany({ where });
  await rows.findFirstOrThrow({ where });
  await rows.findUnique({ where });
  await rows.findUniqueOrThrow({ where });
  await rows.count({ where });
  await rows.update({ where, data: { id: 2, constructor: 'c', toString: 't', valueOf: 'v' } });
  await rows.delete({ where });
  await rows.updateMany({ where, data: { id: 2, constructor: 'c', toString: 't', valueOf: 'v' } });
  await rows.deleteMany({ where });
  rows.buildFindFirst({ where });
  rows.buildFindMany({ where });
  rows.buildFindFirstOrThrow({ where });
  rows.buildFindUnique({ where });
  rows.buildFindUniqueOrThrow({ where });
  rows.buildCount({ where });
  rows.buildUpdate({ where, data: { id: 2, constructor: 'c', toString: 't', valueOf: 'v' } });
  rows.buildDelete({ where });
  rows.buildUpdateMany({ where, data: { id: 2, constructor: 'c', toString: 't', valueOf: 'v' } });
  rows.buildDeleteMany({ where });
  await rows.findMany({ where: optionalFilter });
  await rows.count({ where: optionalFilter });
  await rows.findMany({ where: { createdAt: { gte: new Date() } } });
  await rows.findMany({ where: { labels: { has: 'x', hasEvery: ['x'], isEmpty: false } } });
  await rows.findMany({ where: { payload: { path: ['x'], equals: 1 } } });
  await rows.findMany({ where: { constructor: { search: 'x', config: 'english' } } });
  await rows.findMany({ where: { payload: { distance: { to: [1], metric: 'cosine', lt: 1 } } } });
  await rows.findMany();
  await rows.count();
  await rows.findMany({ where: {} });
  await rows.findMany({ where: { constructor: 'ctor' } });
  await rows.findMany({ where: { toString: 'text' } });
  await rows.findMany({ where: { valueOf: null } });
  await rows.findMany({ where: { ['__proto__']: 'proto' } });
  await rows.findMany({ where: { constructor: undefined } });
  await rows.findMany({ where: { OR: [{ id: 1 }, { constructor: 'ctor' }], NOT: { toString: null } } });
  await rows.findMany({ where: { AND: [{ id: 1 }, { NOT: { constructor: { not: null } } }] } });
  await rows.findMany({
    where: {
      constructor: {
        equals: 'a',
        not: { startsWith: 'z' },
        gt: 'a',
        gte: 'a',
        lt: 'z',
        lte: 'z',
        in: ['a'],
        notIn: ['b'],
        contains: 'a',
        startsWith: 'a',
        endsWith: 'a',
        mode: 'insensitive',
      },
    },
  });
  await rows.findMany({ where: { constructor: { equals: col('toString') } } });
  await strict.findMany({ where: { id: 1, children: { some: { title: 'a' } } } });
  const first = await strict.findFirst({ where, select: { constructor: true }, with: { children: true } });
  if (first) {
    const ctor: string | null = first.constructor;
    const title: string = first.children[0]!.title;
    // @ts-expect-error unselected column remains absent
    first.id;
    void [ctor, title];
  }
  const updated = await rows.update({
    where,
    data: { id: 2, constructor: 'c', toString: 't', valueOf: 'v' },
    select: { toString: true },
  });
  const text: string | null = updated.toString;
  // @ts-expect-error update select still narrows
  updated.id;
  const deleted = rows.buildDelete({ where, omit: { id: true } });
  type Deleted = ReturnType<typeof deleted.transform>;
  const exact: Deleted['constructor'] = null;
  // @ts-expect-error deferred omit still narrows
  const absent: Deleted['id'] = 1;
  const annotated: WhereClause<PrototypeRow, Relations, typeof where> = where;
  void [text, exact, absent, annotated];
}

export async function rejected(): Promise<void> {
  // @ts-expect-error a column name cannot disable a logic control's type
  await controlRows.findMany({ where: { OR: 'scalar' } });
  // @ts-expect-error the filter itself cannot be a Function
  await rows.findMany({ where: suppliedFunction });
  // @ts-expect-error control entries cannot be Function objects
  await rows.findMany({ where: { OR: [suppliedFunction] } });
  // @ts-expect-error control entries cannot be arrays
  await rows.findMany({ where: { AND: [[{ id: 1 }]] } });
  // @ts-expect-error required mutation selectors cannot be undefined
  await rows.delete({ where: undefined });
  // @ts-expect-error invalid case mode remains invalid
  await rows.findMany({ where: { constructor: { equals: 'x', mode: 'invalid' } } });
  // @ts-expect-error an explicitly supplied constructor function is not text
  await rows.findFirst({ where: { constructor: Function } });
  // @ts-expect-error a typed Function cannot be hidden as an inherited constructor
  await rows.findMany({ where: { id: 1, constructor: suppliedFunction } });
  // @ts-expect-error toString functions are not string predicates
  await rows.count({ where: { toString: () => 'text' } });
  // @ts-expect-error wrong constructor scalar
  await rows.update({ where: { constructor: 1 }, data: { id: 2, constructor: 'c', toString: 't', valueOf: 'v' } });
  // @ts-expect-error wrong operator value
  await rows.delete({ where: { constructor: { equals: Function } } });
  // @ts-expect-error explicit Function remains invalid in deferred reads
  rows.buildFindMany({ where: { constructor: Function } });
  rows.buildUpdate({
    // @ts-expect-error explicit Function remains invalid in deferred mutations
    where: { toString: suppliedFunction },
    data: { id: 2, constructor: 'c', toString: 't', valueOf: 'v' },
  });
  // @ts-expect-error invalid operator name
  rows.buildDelete({ where: { constructor: { badOperator: 'x' } } });
  // @ts-expect-error invalid normal column value
  rows.buildCount({ where: { id: 'bad' } });
  // @ts-expect-error an extra operator must not hide beside a valid operator
  await rows.findMany({ where: { constructor: { equals: 'x', badOperator: 'x' } } });
  // @ts-expect-error nested not operators retain excess-key checks
  await rows.findMany({ where: { toString: { not: { contains: 'x', badOperator: 'x' } } } });
  // @ts-expect-error normal columns on a prototype table keep operator checks
  await rows.findMany({ where: { id: { equals: 1, badOperator: 1 } } });
  // @ts-expect-error relation target retains excess-key checks beside valid fields
  await strict.findMany({ where: { children: { some: { title: 'x', typo: 1 } } } });
  // @ts-expect-error bad logic control shape
  await rows.findMany({ where: { OR: { id: 1 } } });
  // @ts-expect-error bad logic control leaf
  await rows.findMany({ where: { AND: [{ id: 1 }, { constructor: Function }] } });
  // @ts-expect-error nested wrong scalar
  await rows.findMany({ where: { NOT: { toString: 123 } } });
  // @ts-expect-error bad branch must not disappear from a union
  await rows.findMany({ where: inputUnion });
  // @ts-expect-error strict relation maps retain excess-key checks
  await strict.findMany({ where: { id: 1, typo: 'x' } });
  // @ts-expect-error strict controls retain excess-key checks
  await strict.findMany({ where: { NOT: { id: 1, typo: 'x' } } });
  // @ts-expect-error relation target remains checked
  await strict.findMany({ where: { children: { some: { title: 1 } } } });
  // @ts-expect-error unbranded column refs still fail
  await rows.findMany({ where: { constructor: { equals: { col: 'toString' } } } });
  // @ts-expect-error named column refs still validate their target
  await rows.findMany({ where: { constructor: { equals: col('unknown') } } });
}
