/**
 * turbine-orm — Referential actions (WS-B / B1)
 *
 * Code-first FK referential actions: `references` accepts the existing
 * 'table.column' string OR `{ target, onDelete?, onUpdate? }`. DDL emits
 * `ON DELETE …` / `ON UPDATE …` clauses; the fluent `.references(target, opts)`
 * builder mirrors it. Introspection maps `pg_constraint.confdeltype/confupdtype`.
 *
 * Run: npx tsx --test src/test/referential-actions.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pgConfActionToReferential } from '../introspect.js';
import { column, defineSchema, table } from '../schema-builder.js';
import { referentialActionToSql, schemaToSQL } from '../schema-sql.js';

describe('B1 — referentialActionToSql', () => {
  it('maps every ReferentialAction to its SQL keyword', () => {
    assert.equal(referentialActionToSql('cascade'), 'CASCADE');
    assert.equal(referentialActionToSql('restrict'), 'RESTRICT');
    assert.equal(referentialActionToSql('set null'), 'SET NULL');
    assert.equal(referentialActionToSql('set default'), 'SET DEFAULT');
    assert.equal(referentialActionToSql('no action'), 'NO ACTION');
  });
});

describe('B1 — pgConfActionToReferential (introspection mapping)', () => {
  it('maps pg_constraint conf*type chars to actions', () => {
    assert.equal(pgConfActionToReferential('c'), 'cascade');
    assert.equal(pgConfActionToReferential('r'), 'restrict');
    assert.equal(pgConfActionToReferential('n'), 'set null');
    assert.equal(pgConfActionToReferential('d'), 'set default');
    assert.equal(pgConfActionToReferential('a'), 'no action');
  });
});

describe('B1 — object references form in defineSchema', () => {
  it('emits ON DELETE / ON UPDATE from { target, onDelete, onUpdate }', () => {
    const schema = defineSchema({
      users: { id: { type: 'serial', primaryKey: true } },
      posts: {
        id: { type: 'serial', primaryKey: true },
        userId: {
          type: 'integer',
          notNull: true,
          references: { target: 'users.id', onDelete: 'cascade', onUpdate: 'restrict' },
        },
      },
    });
    const create = schemaToSQL(schema).find((s) => s.includes('CREATE TABLE "posts"'))!;
    assert.ok(create.includes('REFERENCES "users"("id")'), create);
    assert.ok(create.includes('ON DELETE CASCADE'), create);
    assert.ok(create.includes('ON UPDATE RESTRICT'), create);
  });

  it('omits action clauses when unset (plain string reference is unchanged)', () => {
    const schema = defineSchema({
      users: { id: { type: 'serial', primaryKey: true } },
      posts: {
        id: { type: 'serial', primaryKey: true },
        userId: { type: 'integer', notNull: true, references: 'users.id' },
      },
    });
    const create = schemaToSQL(schema).find((s) => s.includes('CREATE TABLE "posts"'))!;
    assert.ok(create.includes('REFERENCES "users"("id")'), create);
    assert.ok(!create.includes('ON DELETE'), create);
    assert.ok(!create.includes('ON UPDATE'), create);
  });

  it('emits only ON DELETE when onUpdate is unset', () => {
    const schema = defineSchema({
      users: { id: { type: 'serial', primaryKey: true } },
      posts: {
        id: { type: 'serial', primaryKey: true },
        userId: { type: 'integer', notNull: true, references: { target: 'users.id', onDelete: 'set null' } },
      },
    });
    const create = schemaToSQL(schema).find((s) => s.includes('CREATE TABLE "posts"'))!;
    assert.ok(create.includes('ON DELETE SET NULL'), create);
    assert.ok(!create.includes('ON UPDATE'), create);
  });
});

describe('B1 — fluent .references(target, opts)', () => {
  it('legacy builder emits ON DELETE from opts', () => {
    const schema = defineSchema({
      users: table({ id: column.serial().primaryKey() }),
      posts: table({
        id: column.serial().primaryKey(),
        userId: column.integer().notNull().references('users.id', { onDelete: 'cascade' }),
      }),
    });
    const create = schemaToSQL(schema).find((s) => s.includes('CREATE TABLE "posts"'))!;
    assert.ok(create.includes('REFERENCES "users"("id") ON DELETE CASCADE'), create);
  });

  it('.references(target) with no opts is back-compatible (no action clause)', () => {
    const schema = defineSchema({
      users: table({ id: column.serial().primaryKey() }),
      posts: table({
        id: column.serial().primaryKey(),
        userId: column.integer().notNull().references('users.id'),
      }),
    });
    const create = schemaToSQL(schema).find((s) => s.includes('CREATE TABLE "posts"'))!;
    assert.ok(!create.includes('ON DELETE'), create);
  });
});
