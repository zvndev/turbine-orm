/** Structural admission and relation-union regressions. Never executed. */
import type { PowqlInterface as AdmissionPowql } from '../powql.js';
import type {
  QueryInterface as AdmissionQuery,
  RelationDescriptor as AdmissionRelation,
  WhereClause as AdmissionWhere,
} from '../query/index.js';

interface AdmissionRow {
  id: number;
  constructor: string;
  note?: string | null;
}
interface AdmissionChild {
  id: number;
  name?: string | null;
}
interface AdmissionChildRelations {
  owner: AdmissionRelation<AdmissionRow, 'one', AdmissionRelations>;
}
interface AdmissionRelations {
  child: AdmissionRelation<AdmissionChild, 'one', AdmissionChildRelations>;
  children: AdmissionRelation<AdmissionChild, 'many', AdmissionChildRelations>;
}
interface AdmissionOrdinary {
  id: number;
  note?: string | null;
}
declare const admissionRows: AdmissionQuery<AdmissionRow, AdmissionRelations>;
declare const admissionOrdinary: AdmissionQuery<AdmissionOrdinary, AdmissionRelations>;
declare const admissionPowql: AdmissionPowql<AdmissionRow>;
// biome-ignore lint/complexity/noBannedTypes: reject the broad built-in interface as well as callable signatures
declare const admissionFunction: Function;
type AdmissionOne = { is: { id: number } } | { isNot: { name: string | null } } | { id: number };
type AdmissionMany = { some: { id: number } } | { every: { name?: string | null } } | { none: { id: number } };
declare const admissionOne: AdmissionOne | undefined;
declare const admissionMany: AdmissionMany | undefined;

export function publicGenericAdmission<T extends object, R extends object>(
  table: AdmissionQuery<T, R>,
  where: AdmissionWhere<T, R>,
) {
  return table.findMany({ where });
}
export function subtypeAdmission(where: AdmissionWhere<AdmissionRow, AdmissionRelations> & { id: number }) {
  void admissionRows.findMany({ where: where });
  void admissionRows.findFirst({ where: where });
  void admissionRows.findFirstOrThrow({ where: where });
  void admissionRows.findUnique({ where: where });
  void admissionRows.findUniqueOrThrow({ where: where });
  void admissionRows.count({ where: where });
  void admissionRows.update({ where: where, data: { constructor: 'next' } });
  void admissionRows.delete({ where: where });
  void admissionRows.upsert({ where: where, create: { id: 1, constructor: 'new' }, update: { constructor: 'next' } });
  void admissionRows.updateMany({ where: where, data: { constructor: 'next' } });
  void admissionRows.deleteMany({ where: where });
  void admissionRows.buildFindMany({ where: where });
  void admissionRows.buildFindFirst({ where: where });
  void admissionRows.buildFindFirstOrThrow({ where: where });
  void admissionRows.buildFindUnique({ where: where });
  void admissionRows.buildFindUniqueOrThrow({ where: where });
  void admissionRows.buildCount({ where: where });
  void admissionRows.buildUpdate({ where: where, data: { constructor: 'next' } });
  void admissionRows.buildDelete({ where: where });
  void admissionRows.buildUpsert({
    where: where,
    create: { id: 1, constructor: 'new' },
    update: { constructor: 'next' },
  });
  void admissionRows.buildUpdateMany({ where: where, data: { constructor: 'next' } });
  void admissionRows.buildDeleteMany({ where: where });
}
export function unresolvedAdmission<F extends AdmissionWhere<AdmissionRow, AdmissionRelations>>(
  where: F,
  optional: F | undefined,
) {
  void admissionRows.findMany({ where: where });
  void admissionRows.findFirst({ where: where });
  void admissionRows.findFirstOrThrow({ where: where });
  void admissionRows.findUnique({ where: where });
  void admissionRows.findUniqueOrThrow({ where: where });
  void admissionRows.count({ where: where });
  void admissionRows.update({ where: where, data: { constructor: 'next' } });
  void admissionRows.delete({ where: where });
  void admissionRows.upsert({ where: where, create: { id: 1, constructor: 'new' }, update: { constructor: 'next' } });
  void admissionRows.updateMany({ where: where, data: { constructor: 'next' } });
  void admissionRows.deleteMany({ where: where });
  void admissionRows.buildFindMany({ where: where });
  void admissionRows.buildFindFirst({ where: where });
  void admissionRows.buildFindFirstOrThrow({ where: where });
  void admissionRows.buildFindUnique({ where: where });
  void admissionRows.buildFindUniqueOrThrow({ where: where });
  void admissionRows.buildCount({ where: where });
  void admissionRows.buildUpdate({ where: where, data: { constructor: 'next' } });
  void admissionRows.buildDelete({ where: where });
  void admissionRows.buildUpsert({
    where: where,
    create: { id: 1, constructor: 'new' },
    update: { constructor: 'next' },
  });
  void admissionRows.buildUpdateMany({ where: where, data: { constructor: 'next' } });
  void admissionRows.buildDeleteMany({ where: where });

  void admissionRows.findMany({ where: optional });
  void admissionRows.count({ where: optional });
}
export function powqlGenericAdmission<F extends AdmissionWhere<AdmissionRow>>(where: F) {
  void admissionPowql.findMany({ where: where });
  void admissionPowql.findFirst({ where: where });
  void admissionPowql.findFirstOrThrow({ where: where });
  void admissionPowql.findUnique({ where: where });
  void admissionPowql.findUniqueOrThrow({ where: where });
  void admissionPowql.count({ where: where });
  void admissionPowql.update({ where: where, data: { constructor: 'next' } });
  void admissionPowql.delete({ where: where });
  void admissionPowql.upsert({ where: where, create: { id: 1, constructor: 'new' }, update: { constructor: 'next' } });
  void admissionPowql.updateMany({ where: where, data: { constructor: 'next' } });
  void admissionPowql.deleteMany({ where: where });
}
export function relationUnionAdmission() {
  const where = { child: admissionOne, children: admissionMany };
  void admissionRows.findMany({ where: where });
  void admissionRows.findFirst({ where: where });
  void admissionRows.findFirstOrThrow({ where: where });
  void admissionRows.findUnique({ where: where });
  void admissionRows.findUniqueOrThrow({ where: where });
  void admissionRows.count({ where: where });
  void admissionRows.update({ where: where, data: { constructor: 'next' } });
  void admissionRows.delete({ where: where });
  void admissionRows.upsert({ where: where, create: { id: 1, constructor: 'new' }, update: { constructor: 'next' } });
  void admissionRows.updateMany({ where: where, data: { constructor: 'next' } });
  void admissionRows.deleteMany({ where: where });
  void admissionRows.buildFindMany({ where: where });
  void admissionRows.buildFindFirst({ where: where });
  void admissionRows.buildFindFirstOrThrow({ where: where });
  void admissionRows.buildFindUnique({ where: where });
  void admissionRows.buildFindUniqueOrThrow({ where: where });
  void admissionRows.buildCount({ where: where });
  void admissionRows.buildUpdate({ where: where, data: { constructor: 'next' } });
  void admissionRows.buildDelete({ where: where });
  void admissionRows.buildUpsert({
    where: where,
    create: { id: 1, constructor: 'new' },
    update: { constructor: 'next' },
  });
  void admissionRows.buildUpdateMany({ where: where, data: { constructor: 'next' } });
  void admissionRows.buildDeleteMany({ where: where });

  void admissionOrdinary.findMany({ where: { child: admissionOne, children: admissionMany, note: null } });
  void admissionRows.findMany({ where: { constructor: 'c', child: admissionOne, children: admissionMany } });
  void admissionRows.findMany({
    where: { child: { is: undefined, isNot: { name: null } }, children: { some: undefined } },
  });
}

type AdmissionEqual<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function admissionExact<_T extends true>(): void {}
export async function admissionResults(where: AdmissionWhere<AdmissionRow, AdmissionRelations> & { id: number }) {
  const selected = await admissionRows.findMany({
    where,
    select: { id: true },
    with: { children: { select: { name: true } } },
  });
  admissionExact<AdmissionEqual<typeof selected, { id: number; children: { name?: string | null }[] }[]>>();
  const deferred = admissionRows.buildFindFirst({ where, omit: { constructor: true } });
  admissionExact<AdmissionEqual<ReturnType<typeof deferred.transform>, Omit<AdmissionRow, 'constructor'> | null>>();
  const contextual = await admissionRows.findFirst({
    where: { constructor: { equals: 'c', mode: 'insensitive' }, child: admissionOne },
    select: { constructor: true },
  });
  admissionExact<AdmissionEqual<typeof contextual, { constructor: string } | null>>();
}

export function relationAdmissionRejections(
  scalar: AdmissionMany | number,
  callable: AdmissionMany | (() => number),
  array: AdmissionMany | readonly [],
  nullable: AdmissionMany | null,
  malformedOne: AdmissionOne | { is: { id: string } },
  malformedBare: AdmissionOne | { id: string },
  malformedControl: AdmissionOne | { some: { id: number } },
) {
  // @ts-expect-error to-many predicates require control objects in every method
  void admissionRows.findMany({ where: { constructor: 'c', children: 123 } });
  // @ts-expect-error to-many predicates require control objects in every method
  void admissionRows.findFirst({ where: { constructor: 'c', children: false } });
  // @ts-expect-error to-many predicates require control objects in every method
  void admissionRows.findFirstOrThrow({ where: { constructor: 'c', children: 'bad' } });
  // @ts-expect-error to-many predicates require control objects in every method
  void admissionRows.findUnique({ where: { constructor: 'c', children: null } });
  // @ts-expect-error to-many predicates require control objects in every method
  void admissionRows.findUniqueOrThrow({ where: { constructor: 'c', children: [] as const } });
  // @ts-expect-error to-many predicates require control objects in every method
  void admissionRows.count({ where: { constructor: 'c', children: admissionFunction } });
  // @ts-expect-error to-many predicates require control objects in every method
  void admissionRows.update({ where: { constructor: 'c', children: () => 1 }, data: { constructor: 'next' } });
  // @ts-expect-error to-many predicates require control objects in every method
  void admissionRows.delete({ where: { constructor: 'c', children: scalar } });
  void admissionRows.upsert({
    // @ts-expect-error to-many predicates require control objects in every method
    where: { constructor: 'c', children: callable },
    create: { id: 1, constructor: 'new' },
    update: { constructor: 'next' },
  });
  // @ts-expect-error to-many predicates require control objects in every method
  void admissionRows.updateMany({ where: { constructor: 'c', children: array }, data: { constructor: 'next' } });
  // @ts-expect-error to-many predicates require control objects in every method
  void admissionRows.deleteMany({ where: { constructor: 'c', children: nullable } });
  // @ts-expect-error to-many predicates require control objects in every method
  void admissionRows.buildFindMany({ where: { constructor: 'c', children: 123 } });
  // @ts-expect-error to-many predicates require control objects in every method
  void admissionRows.buildFindFirst({ where: { constructor: 'c', children: false } });
  // @ts-expect-error to-many predicates require control objects in every method
  void admissionRows.buildFindFirstOrThrow({ where: { constructor: 'c', children: 'bad' } });
  // @ts-expect-error to-many predicates require control objects in every method
  void admissionRows.buildFindUnique({ where: { constructor: 'c', children: null } });
  // @ts-expect-error to-many predicates require control objects in every method
  void admissionRows.buildFindUniqueOrThrow({ where: { constructor: 'c', children: [] as const } });
  // @ts-expect-error to-many predicates require control objects in every method
  void admissionRows.buildCount({ where: { constructor: 'c', children: admissionFunction } });
  // @ts-expect-error to-many predicates require control objects in every method
  void admissionRows.buildUpdate({ where: { constructor: 'c', children: () => 1 }, data: { constructor: 'next' } });
  // @ts-expect-error to-many predicates require control objects in every method
  void admissionRows.buildDelete({ where: { constructor: 'c', children: scalar } });
  void admissionRows.buildUpsert({
    // @ts-expect-error to-many predicates require control objects in every method
    where: { constructor: 'c', children: callable },
    create: { id: 1, constructor: 'new' },
    update: { constructor: 'next' },
  });
  // @ts-expect-error to-many predicates require control objects in every method
  void admissionRows.buildUpdateMany({ where: { constructor: 'c', children: array }, data: { constructor: 'next' } });
  // @ts-expect-error to-many predicates require control objects in every method
  void admissionRows.buildDeleteMany({ where: { constructor: 'c', children: nullable } });
  // @ts-expect-error each malformed relation union member must refuse admission
  void admissionRows.findMany({ where: { children: scalar } });
  // @ts-expect-error each malformed relation union member must refuse admission
  void admissionRows.findMany({ where: { constructor: 'c', children: scalar } });
  // @ts-expect-error ordinary roots retain the same relation union boundary
  void admissionOrdinary.findMany({ where: { children: scalar } });
  // @ts-expect-error ordinary roots retain the same relation union boundary
  void admissionOrdinary.count({ where: { children: scalar } });
  // @ts-expect-error ordinary roots retain the same relation union boundary
  void admissionOrdinary.buildFindMany({ where: { children: scalar } });
  // @ts-expect-error ordinary roots retain the same relation union boundary
  void admissionOrdinary.deleteMany({ where: { children: scalar } });
  // @ts-expect-error each malformed relation union member must refuse admission
  void admissionRows.findMany({ where: { children: callable } });
  // @ts-expect-error each malformed relation union member must refuse admission
  void admissionRows.findMany({ where: { constructor: 'c', children: callable } });
  // @ts-expect-error ordinary roots retain the same relation union boundary
  void admissionOrdinary.findMany({ where: { children: callable } });
  // @ts-expect-error ordinary roots retain the same relation union boundary
  void admissionOrdinary.count({ where: { children: callable } });
  // @ts-expect-error ordinary roots retain the same relation union boundary
  void admissionOrdinary.buildFindMany({ where: { children: callable } });
  // @ts-expect-error ordinary roots retain the same relation union boundary
  void admissionOrdinary.deleteMany({ where: { children: callable } });
  // @ts-expect-error each malformed relation union member must refuse admission
  void admissionRows.findMany({ where: { children: array } });
  // @ts-expect-error each malformed relation union member must refuse admission
  void admissionRows.findMany({ where: { constructor: 'c', children: array } });
  // @ts-expect-error ordinary roots retain the same relation union boundary
  void admissionOrdinary.findMany({ where: { children: array } });
  // @ts-expect-error ordinary roots retain the same relation union boundary
  void admissionOrdinary.count({ where: { children: array } });
  // @ts-expect-error ordinary roots retain the same relation union boundary
  void admissionOrdinary.buildFindMany({ where: { children: array } });
  // @ts-expect-error ordinary roots retain the same relation union boundary
  void admissionOrdinary.deleteMany({ where: { children: array } });
  // @ts-expect-error each malformed relation union member must refuse admission
  void admissionRows.findMany({ where: { children: nullable } });
  // @ts-expect-error each malformed relation union member must refuse admission
  void admissionRows.findMany({ where: { constructor: 'c', children: nullable } });
  // @ts-expect-error ordinary roots retain the same relation union boundary
  void admissionOrdinary.findMany({ where: { children: nullable } });
  // @ts-expect-error ordinary roots retain the same relation union boundary
  void admissionOrdinary.count({ where: { children: nullable } });
  // @ts-expect-error ordinary roots retain the same relation union boundary
  void admissionOrdinary.buildFindMany({ where: { children: nullable } });
  // @ts-expect-error ordinary roots retain the same relation union boundary
  void admissionOrdinary.deleteMany({ where: { children: nullable } });
  // @ts-expect-error each malformed relation union member must refuse admission
  void admissionRows.findMany({ where: { child: malformedOne } });
  // @ts-expect-error each malformed relation union member must refuse admission
  void admissionRows.findMany({ where: { constructor: 'c', child: malformedOne } });
  // @ts-expect-error ordinary roots retain the same relation union boundary
  void admissionOrdinary.findMany({ where: { child: malformedOne } });
  // @ts-expect-error ordinary roots retain the same relation union boundary
  void admissionOrdinary.count({ where: { child: malformedOne } });
  // @ts-expect-error ordinary roots retain the same relation union boundary
  void admissionOrdinary.buildFindMany({ where: { child: malformedOne } });
  // @ts-expect-error ordinary roots retain the same relation union boundary
  void admissionOrdinary.deleteMany({ where: { child: malformedOne } });
  // @ts-expect-error each malformed relation union member must refuse admission
  void admissionRows.findMany({ where: { child: malformedBare } });
  // @ts-expect-error each malformed relation union member must refuse admission
  void admissionRows.findMany({ where: { constructor: 'c', child: malformedBare } });
  // @ts-expect-error ordinary roots retain the same relation union boundary
  void admissionOrdinary.findMany({ where: { child: malformedBare } });
  // @ts-expect-error ordinary roots retain the same relation union boundary
  void admissionOrdinary.count({ where: { child: malformedBare } });
  // @ts-expect-error ordinary roots retain the same relation union boundary
  void admissionOrdinary.buildFindMany({ where: { child: malformedBare } });
  // @ts-expect-error ordinary roots retain the same relation union boundary
  void admissionOrdinary.deleteMany({ where: { child: malformedBare } });
  // @ts-expect-error each malformed relation union member must refuse admission
  void admissionRows.findMany({ where: { child: malformedControl } });
  // @ts-expect-error each malformed relation union member must refuse admission
  void admissionRows.findMany({ where: { constructor: 'c', child: malformedControl } });
  // @ts-expect-error ordinary roots retain the same relation union boundary
  void admissionOrdinary.findMany({ where: { child: malformedControl } });
  // @ts-expect-error ordinary roots retain the same relation union boundary
  void admissionOrdinary.count({ where: { child: malformedControl } });
  // @ts-expect-error ordinary roots retain the same relation union boundary
  void admissionOrdinary.buildFindMany({ where: { child: malformedControl } });
  // @ts-expect-error ordinary roots retain the same relation union boundary
  void admissionOrdinary.deleteMany({ where: { child: malformedControl } });
  // @ts-expect-error ordinary roots reject scalar, null, array and function predicates
  void admissionOrdinary.findFirst({ where: { children: 123 } });
  // @ts-expect-error ordinary roots reject scalar, null, array and function predicates
  void admissionOrdinary.findFirst({ where: { children: false } });
  // @ts-expect-error ordinary roots reject scalar, null, array and function predicates
  void admissionOrdinary.findFirst({ where: { children: 'bad' } });
  // @ts-expect-error ordinary roots reject scalar, null, array and function predicates
  void admissionOrdinary.findFirst({ where: { children: null } });
  // @ts-expect-error ordinary roots reject scalar, null, array and function predicates
  void admissionOrdinary.findFirst({ where: { children: [] as const } });
  // @ts-expect-error ordinary roots reject scalar, null, array and function predicates
  void admissionOrdinary.findFirst({ where: { children: admissionFunction } });
  // @ts-expect-error ordinary roots reject scalar, null, array and function predicates
  void admissionOrdinary.findFirst({ where: { children: () => 1 } });
  // @ts-expect-error relation controls still reject malformed keys
  void admissionRows.findMany({ where: { children: { some: { id: 1 }, typo: true } } });
  // @ts-expect-error to-one controls still reject malformed keys
  void admissionRows.count({ where: { child: { is: { id: 1 }, typo: true } } });
}
