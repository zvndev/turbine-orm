/**
 * The Prisma migration toolkit with hostile names.
 *
 * A `schema.prisma` and the database it is resolved against can both choose any
 * names, and `__proto__`, `constructor`, `toString` and `valueOf` are legal ones.
 * The resolver used to key plain objects by those names and look them up with
 * bracket notation, so:
 *
 *  - a column `@map`ped to a prototype member ("constructor") resolved to the
 *    inherited FUNCTION, which `generatePrismaMap` then crashed serializing;
 *  - a model, field, relation or enum NAMED `__proto__` assigned the prototype of
 *    the map instead of adding an entry, so the model vanished from the map and
 *    the report still called it resolved;
 *  - an attribute named `@constructor` read an inherited function as a "note" and
 *    pushed its source text into the warnings.
 *
 * Everything here is DB-less: the schema is hand-built (plain-object records,
 * the shape that exposes the bracket lookups) and a null-prototype twin (the
 * shape introspection produces).
 *
 * Run: npx tsx --test src/test/security-perimeter-prisma-hostile-names.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatPrismaReport } from '../cli/prisma-report.js';
import { type ResolutionResult, resolvePrismaSchema } from '../cli/prisma-resolve.js';
import { parsePrismaSchema } from '../cli/prisma-schema.js';
import { generatePrismaMap } from '../generate.js';
import { nullRecord } from '../introspect.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

/** users(id, name), a plain-object schema: bracket lookups of prototype names would hit inherited members. */
function plainSchema(): SchemaMetadata {
  const users = mockTable('users', [
    { name: 'id', field: 'id' },
    { name: 'name', field: 'name', pgType: 'text' },
  ]);
  return { enums: {}, tables: { users } };
}

/** The same schema with every record null-prototype, as `introspect` builds it. */
function nullProtoSchema(): SchemaMetadata {
  const base = plainSchema();
  const users = base.tables.users!;
  const tables = nullRecord<(typeof base.tables)[string]>();
  tables.users = {
    ...users,
    columnMap: Object.assign(nullRecord<string>(), users.columnMap),
    reverseColumnMap: Object.assign(nullRecord<string>(), users.reverseColumnMap),
    relations: Object.assign(nullRecord<(typeof users.relations)[string]>(), users.relations),
  };
  return { enums: nullRecord<string[]>(), tables };
}

function resolve(prisma: string, schema: SchemaMetadata): ResolutionResult {
  return resolvePrismaSchema(parsePrismaSchema(prisma), schema, {});
}

const HOSTILE_COLUMNS = `
model User {
  id   Int @id
  name String
  a    String? @map("__proto__")
  b    String? @map("constructor")
  c    String? @map("toString")
  d    String? @map("hasOwnProperty")
  @@map("users")
}`;

for (const [label, build] of [
  ['plain-object records', plainSchema],
  ['null-prototype records', nullProtoSchema],
] as const) {
  describe(`a column @map named after a prototype member (${label})`, () => {
    it('is UNRESOLVED with a reason, never resolved to an inherited member', () => {
      const res = resolve(HOSTILE_COLUMNS, build());
      const user = res.models[0]!;
      for (const name of ['a', 'b', 'c', 'd']) {
        const field = user.fields.find((f) => f.prismaName === name)!;
        assert.equal(field.status, 'unresolved', `${name} must not resolve`);
        assert.equal(field.turbineField, null, `${name} must not carry a value`);
        assert.match(String(field.reason), /not found on table "users"/);
      }
      assert.equal(res.hasUnresolved, true);
    });

    it('generatePrismaMap and the report run to completion and omit them', () => {
      const res = resolve(HOSTILE_COLUMNS, build());
      const map = generatePrismaMap(res.map, { noTimestamp: true });
      assert.match(map, /fields: \{ id: 'id', name: 'name' \}/);
      assert.doesNotMatch(map, /function|native code|\[object/);
      const report = formatPrismaReport(res, {});
      assert.match(report, /UNRESOLVED/);
      assert.doesNotMatch(report, /function|native code|\[object/);
    });

    it('a compound unique over such a column is unresolved, not resolved to a member', () => {
      const res = resolve(
        `model User { id Int @id
  name String
  b String? @map("constructor")
  @@unique([name, b])
  @@map("users") }`,
        build(),
      );
      const compound = res.models[0]!.compoundUniques[0]!;
      assert.equal(compound.status, 'unresolved');
      assert.match(String(compound.reason), /column\(s\) not found: constructor/);
    });
  });
}

/** The key itself, held in a variable so no member access spells the deprecated accessor. */
const PROTO = '__proto__';

describe('names that Prisma lets you choose: __proto__ and friends', () => {
  const schema = (): SchemaMetadata => {
    const t = mockTable('__proto__', [
      { name: 'id', field: 'id' },
      { name: 'value', field: 'value', pgType: 'text' },
    ]);
    const tables = nullRecord<typeof t>();
    tables[PROTO] = t;
    return { enums: Object.assign(nullRecord<string[]>(), { toString: ['a', 'b'] }), tables };
  };

  const PRISMA = `
model __proto__ {
  id    Int @id
  value String
  __proto__ String? @map("value")
  constructor String? @map("value")
  @@map("__proto__")
}
enum toString { a b }`;

  it('a model named __proto__ is an entry in the map, not the map prototype', () => {
    const res = resolve(PRISMA, schema());
    assert.deepEqual(Object.keys(res.map.models), ['__proto__']);
    assert.equal(Object.hasOwn(res.map.models, PROTO), true);
    assert.equal(Object.getPrototypeOf(res.map.models), null, 'the record is prototype-less');
    assert.equal(res.models[0]!.status, 'resolved');
  });

  it('fields named __proto__ and constructor are entries, with the right columns', () => {
    const res = resolve(PRISMA, schema());
    const fields = res.map.models[PROTO]!.fields;
    assert.deepEqual(Object.keys(fields).sort(), ['__proto__', 'constructor', 'id', 'value']);
    assert.equal(fields[PROTO], 'value');
    assert.equal(fields.constructor, 'value');
  });

  it('an enum named toString is an entry', () => {
    const res = resolve(PRISMA, schema());
    assert.deepEqual(Object.keys(res.map.enums), ['toString']);
    assert.equal(res.map.enums.toString, 'toString');
  });

  it('the emitted module keeps every one of them as an OWN property when evaluated', () => {
    const res = resolve(PRISMA, schema());
    const source = generatePrismaMap(res.map, { noTimestamp: true });
    const body = source.slice(source.indexOf('{', source.indexOf('PRISMA_MAP')));
    const evaluated = new Function(`return (${body.replace(/;\s*$/, '')})`)() as {
      models: Record<string, { fields: Record<string, string> }>;
      enums: Record<string, string>;
    };
    assert.deepEqual(Object.keys(evaluated.models), ['__proto__']);
    assert.equal(Object.hasOwn(evaluated.models[PROTO]!.fields, PROTO), true);
    assert.equal(evaluated.enums.toString, 'toString');
  });

  it('two models resolving to the same table are still flagged when one is named __proto__', () => {
    const res = resolve(
      `model __proto__ { id Int @id
  @@map("users") }
model Other { id Int @id
  @@map("users") }`,
      plainSchema(),
    );
    assert.deepEqual(
      res.models.map((m) => m.status),
      ['unresolved', 'unresolved'],
    );
    assert.deepEqual(Object.keys(res.map.models), []);
  });
});

describe('the parser reads attribute notes by own key', () => {
  it('@constructor, @toString and @@valueOf produce no warning text', () => {
    const ast = parsePrismaSchema(`model A {
  id Int @id @constructor @toString
  @@valueOf
  @@hasOwnProperty
}`);
    assert.deepEqual(ast.warnings, []);
  });

  it('the real noted attributes still warn (the lookup was not broken)', () => {
    const ast = parsePrismaSchema(`model A {
  id Int @id @ignore
  @@fulltext([id])
}`);
    assert.equal(ast.warnings.length, 2);
    assert.match(ast.warnings.join('\n'), /@ignore excludes the field/);
    assert.match(ast.warnings.join('\n'), /@@fulltext/);
  });
});
