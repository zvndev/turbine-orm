/**
 * turbine-orm - Prisma schema subset parser (no DB).
 *
 * Run: npx tsx --test src/test/prisma-schema-parser.test.ts
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { type PrismaModel, PrismaParseError, parsePrismaSchema } from '../cli/prisma-schema.js';

const FIXTURES = join(process.cwd(), 'src/test/fixtures/prisma');
const readFixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf-8');

function model(ast: ReturnType<typeof parsePrismaSchema>, name: string): PrismaModel {
  const m = ast.models.find((x) => x.name === name);
  assert.ok(m, `model ${name} not parsed`);
  return m;
}

describe('parsePrismaSchema - shop.prisma', () => {
  const ast = parsePrismaSchema(readFixture('shop.prisma'));

  it('parses every model + enum and skips datasource/generator blocks', () => {
    assert.deepEqual(ast.models.map((m) => m.name).sort(), ['Order', 'OrderItem', 'Product', 'Tag', 'User']);
    assert.deepEqual(
      ast.enums.map((e) => e.name),
      ['Role'],
    );
    // datasource/generator produce no warnings and no models.
    assert.equal(ast.warnings.length, 0);
  });

  it('reads @@map divergence', () => {
    assert.equal(model(ast, 'User').map, 'shop_users');
    assert.equal(model(ast, 'OrderItem').map, 'order_items');
    assert.equal(model(ast, 'Product').map, undefined); // heuristic table
  });

  it('reads field @map and modifiers', () => {
    const user = model(ast, 'User');
    const displayName = user.fields.find((f) => f.name === 'displayName')!;
    const mapAttr = displayName.attrs.find((a) => a.name === 'map')!;
    assert.equal(mapAttr.args[0]!.value, 'display_name');

    const order = model(ast, 'Order');
    const reviewerId = order.fields.find((f) => f.name === 'reviewerId')!;
    assert.equal(reviewerId.optional, true, 'Int? is optional');
  });

  it('parses @relation fields/references arrays for disambiguation', () => {
    const order = model(ast, 'Order');
    const buyer = order.fields.find((f) => f.name === 'buyer')!;
    assert.equal(buyer.type, 'User');
    assert.equal(buyer.isList, false);
    const rel = buyer.attrs.find((a) => a.name === 'relation')!;
    // positional name + named fields/references
    assert.equal(rel.args.find((a) => a.key === undefined)!.value, 'buyer');
    assert.deepEqual(rel.args.find((a) => a.key === 'fields')!.items, ['buyerId']);
    assert.deepEqual(rel.args.find((a) => a.key === 'references')!.items, ['id']);
  });

  it('parses list relation fields (implicit m2m + hasMany)', () => {
    const product = model(ast, 'Product');
    const tags = product.fields.find((f) => f.name === 'tags')!;
    assert.equal(tags.type, 'Tag');
    assert.equal(tags.isList, true);
  });

  it('reads named and default @@unique + compound @@id', () => {
    const product = model(ast, 'Product');
    const named = product.compoundKeys.find((k) => k.kind === 'unique')!;
    assert.equal(named.name, 'owner_sku');
    assert.deepEqual(named.fields, ['ownerId', 'sku']);

    const order = model(ast, 'Order');
    const def = order.compoundKeys.find((k) => k.kind === 'unique')!;
    assert.equal(def.name, undefined); // default selector derived downstream
    assert.deepEqual(def.fields, ['buyerId', 'productId']);

    const item = model(ast, 'OrderItem');
    const id = item.compoundKeys.find((k) => k.kind === 'id')!;
    assert.deepEqual(id.fields, ['orderId', 'productId']);
  });

  it('reads enum @@map', () => {
    assert.equal(ast.enums[0]!.map, 'shop_role');
    assert.deepEqual(ast.enums[0]!.values, ['ADMIN', 'MEMBER']);
  });

  it('tolerates unknown native-type attributes (@db.VarChar) without crashing', () => {
    const product = model(ast, 'Product');
    const sku = product.fields.find((f) => f.name === 'sku')!;
    assert.equal(sku.type, 'String');
    // @db.VarChar(64) is recorded as a `db` attribute, never fatal.
    assert.ok(sku.attrs.some((a) => a.name === 'db'));
  });
});

describe('parsePrismaSchema - blog.prisma (self-relations, type block, comments)', () => {
  const ast = parsePrismaSchema(readFixture('blog.prisma'));

  it('parses a self-relation with a named @relation on both sides', () => {
    const comment = model(ast, 'Comment');
    const post = comment.fields.find((f) => f.name === 'post')!;
    const replies = comment.fields.find((f) => f.name === 'replies')!;
    assert.equal(post.type, 'Comment');
    assert.equal(replies.type, 'Comment');
    assert.equal(replies.isList, true);
    assert.equal(post.attrs.find((a) => a.name === 'relation')!.args[0]!.value, 'thread');
  });

  it('parses a composite `type` block and records a not-a-table warning', () => {
    const address = model(ast, 'Address');
    assert.equal(address.kind, 'type');
    assert.equal(address.fields.length, 3);
    assert.ok(ast.warnings.some((w) => /type Address/.test(w)));
  });

  it('does not treat a // inside a quoted URL as a comment', () => {
    // The datasource block holds url = "postgresql://.../blog". If the parser
    // mis-stripped the `//` the brace matcher would still succeed here; the real
    // proof is that every following model parsed intact.
    assert.deepEqual(ast.models.map((m) => m.name).sort(), ['Address', 'Author', 'Comment', 'Post']);
  });

  it('keeps /// doc comments out of field parsing', () => {
    const post = model(ast, 'Post');
    // publishedAt follows a /// doc comment line; it must still be a field.
    assert.ok(post.fields.some((f) => f.name === 'publishedAt'));
  });
});

describe('parsePrismaSchema - error handling with line numbers', () => {
  it('throws PrismaParseError with a line for an unterminated block', () => {
    const src = 'model User {\n  id Int @id\n';
    assert.throws(
      () => parsePrismaSchema(src),
      (e: unknown) => e instanceof PrismaParseError && e.line === 1 && /unterminated/.test(e.message),
    );
  });

  it('throws for an unterminated attribute paren', () => {
    const src = 'model User {\n  id Int @default(autoincrement()\n}';
    assert.throws(
      () => parsePrismaSchema(src),
      (e: unknown) => e instanceof PrismaParseError && e.line === 2,
    );
  });

  it('throws for @@unique with no field list', () => {
    const src = 'model User {\n  id Int @id\n  a Int\n  @@unique\n}';
    assert.throws(
      () => parsePrismaSchema(src),
      (e: unknown) => e instanceof PrismaParseError && e.line === 4 && /@@unique requires a field list/.test(e.message),
    );
  });

  it('throws for @@map without a quoted name', () => {
    const src = 'model User {\n  id Int @id\n  @@map(foo)\n}';
    assert.throws(
      () => parsePrismaSchema(src),
      (e: unknown) =>
        e instanceof PrismaParseError && e.line === 3 && /@@map requires a quoted table name/.test(e.message),
    );
  });
});

describe('parsePrismaSchema - lenience', () => {
  it('ignores an unknown top-level keyword block and still parses real models', () => {
    const src = 'widget Foo {\n  bar = 1\n}\nmodel User {\n  id Int @id\n}';
    const ast = parsePrismaSchema(src);
    assert.deepEqual(
      ast.models.map((m) => m.name),
      ['User'],
    );
  });

  it('strips // and /// comments including trailing ones', () => {
    const src = ['// header', 'model User {', '  /// the id', '  id Int @id // trailing', '}'].join('\n');
    const ast = parsePrismaSchema(src);
    assert.deepEqual(
      ast.models[0]!.fields.map((f) => f.name),
      ['id'],
    );
  });
});
