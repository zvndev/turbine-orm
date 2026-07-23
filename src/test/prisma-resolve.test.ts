/**
 * turbine-orm - Prisma schema resolver + prisma-map generator (no DB).
 *
 * Drives resolvePrismaSchema against hand-built mock SchemaMetadata (resolved /
 * diverged / unresolved paths, compound-unique derivation) and pins
 * generatePrismaMap output under noTimestamp.
 *
 * Run: npx tsx --test src/test/prisma-resolve.test.ts
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { resolvePrismaSchema } from '../cli/prisma-resolve.js';
import { parsePrismaSchema } from '../cli/prisma-schema.js';
import { generate, generatePrismaMap } from '../generate.js';
import type { IndexMetadata, RelationDef, SchemaMetadata, TableMetadata } from '../schema.js';

// ---------------------------------------------------------------------------
// Mock metadata helpers
// ---------------------------------------------------------------------------

function table(
  name: string,
  columns: string[], // snake_case column names
  opts: {
    primaryKey?: string[];
    uniqueColumns?: string[][];
    relations?: Record<string, RelationDef>;
    indexes?: IndexMetadata[];
  } = {},
): TableMetadata {
  const columnMap: Record<string, string> = {};
  const reverseColumnMap: Record<string, string> = {};
  for (const c of columns) {
    const field = c.replace(/_([a-z])/g, (_, x: string) => x.toUpperCase());
    columnMap[field] = c;
    reverseColumnMap[c] = field;
  }
  return {
    name,
    columns: columns.map((c) => ({
      name: c,
      field: reverseColumnMap[c]!,
      pgType: 'int8',
      tsType: 'number',
      nullable: false,
      hasDefault: c === 'id',
      isArray: false,
      pgArrayType: 'bigint[]',
    })),
    columnMap,
    reverseColumnMap,
    dateColumns: new Set(),
    pgTypes: Object.fromEntries(columns.map((c) => [c, 'int8'])),
    allColumns: columns,
    primaryKey: opts.primaryKey ?? ['id'],
    uniqueColumns: opts.uniqueColumns ?? [],
    relations: opts.relations ?? {},
    indexes: opts.indexes ?? [],
  };
}

const rel = (
  name: string,
  type: RelationDef['type'],
  to: string,
  foreignKey: string | string[],
  through?: RelationDef['through'],
): RelationDef => ({ name, type, from: '', to, foreignKey, referenceKey: 'id', through });

// A schema matching a small shop: shop_users, products, orders.
function mockSchema(): SchemaMetadata {
  return {
    enums: { shop_role: ['ADMIN', 'MEMBER'] },
    tables: {
      shop_users: table('shop_users', ['id', 'email', 'display_name', 'role'], {
        uniqueColumns: [['email']],
        relations: { products: rel('products', 'hasMany', 'products', 'owner_id') },
      }),
      products: table('products', ['id', 'owner_id', 'sku', 'name'], {
        uniqueColumns: [['owner_id', 'sku']],
        relations: {
          owner: rel('owner', 'belongsTo', 'shop_users', 'owner_id'),
          tags: rel('tags', 'manyToMany', 'tags', 'id', { table: '_ProductToTag', sourceKey: 'A', targetKey: 'B' }),
        },
      }),
      tags: table('tags', ['id', 'label'], {
        relations: {
          products: rel('products', 'manyToMany', 'products', 'id', {
            table: '_ProductToTag',
            sourceKey: 'B',
            targetKey: 'A',
          }),
        },
      }),
      orders: table('orders', ['id', 'buyer_id', 'reviewer_id', 'product_id'], {
        uniqueColumns: [['buyer_id', 'product_id']],
        relations: {
          buyer: rel('buyer', 'belongsTo', 'shop_users', 'buyer_id'),
          reviewer: rel('reviewer', 'belongsTo', 'shop_users', 'reviewer_id'),
          product: rel('product', 'belongsTo', 'products', 'product_id'),
        },
      }),
    },
  };
}

const SHOP_PRISMA = `
model User {
  id          Int    @id
  email       String @unique
  displayName String @map("display_name")
  role        Role
  products    Product[]
  @@map("shop_users")
}
model Product {
  id      Int    @id
  ownerId Int    @map("owner_id")
  sku     String
  name    String
  owner   User   @relation(fields: [ownerId], references: [id])
  tags    Tag[]
  @@unique([ownerId, sku], name: "owner_sku")
}
model Tag {
  id       Int    @id
  label    String @unique
  products Product[]
}
model Order {
  id         Int  @id
  buyerId    Int  @map("buyer_id")
  reviewerId Int? @map("reviewer_id")
  productId  Int  @map("product_id")
  buyer    User    @relation("buyer", fields: [buyerId], references: [id])
  reviewer User?   @relation("reviewer", fields: [reviewerId], references: [id])
  product  Product @relation(fields: [productId], references: [id])
  @@unique([buyerId, productId])
}
enum Role {
  ADMIN
  MEMBER
  @@map("shop_role")
}
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolvePrismaSchema - resolved shop schema', () => {
  const res = resolvePrismaSchema(parsePrismaSchema(SHOP_PRISMA), mockSchema());

  it('resolves every model, marking @@map divergence', () => {
    assert.equal(res.hasUnresolved, false);
    const user = res.models.find((m) => m.prismaName === 'User')!;
    assert.equal(user.table, 'shop_users');
    assert.equal(user.accessor, 'shopUsers');
    assert.equal(user.viaMap, true);

    const product = res.models.find((m) => m.prismaName === 'Product')!;
    assert.equal(product.table, 'products'); // heuristic (product -> products)
    assert.equal(product.viaMap, false);
  });

  it('maps fields via @map to the camelCase turbine field', () => {
    assert.equal(res.map.models.User!.fields.displayName, 'displayName');
    assert.equal(res.map.models.Order!.fields.buyerId, 'buyerId');
  });

  it('disambiguates two relations to the same model via @relation fields', () => {
    const order = res.map.models.Order!;
    assert.deepEqual(order.relations.buyer, { name: 'buyer', cardinality: 'one' });
    assert.deepEqual(order.relations.reviewer, { name: 'reviewer', cardinality: 'one' });
  });

  it('resolves an implicit m2m relation and records the junction', () => {
    const product = res.models.find((m) => m.prismaName === 'Product')!;
    const tags = product.relations.find((r) => r.prismaName === 'tags')!;
    assert.equal(tags.status, 'resolved');
    assert.equal(tags.cardinality, 'many');
    assert.equal(tags.junction, '_ProductToTag');
    assert.equal(res.map.models.Product!.relations.tags!.name, 'tags');
  });

  it('derives named and default compound-unique selectors', () => {
    assert.deepEqual(res.map.models.Product!.compoundUniques.owner_sku, ['ownerId', 'sku']);
    assert.deepEqual(res.map.models.Order!.compoundUniques.buyerId_productId, ['buyerId', 'productId']);
  });

  it('resolves an enum via @@map', () => {
    assert.equal(res.map.enums.Role, 'shop_role');
  });
});

describe('resolvePrismaSchema - unresolved / diverged paths', () => {
  it('marks a model UNRESOLVED when no table matches and never guesses', () => {
    const src = 'model Gadget {\n  id Int @id\n}';
    const res = resolvePrismaSchema(parsePrismaSchema(src), mockSchema());
    const gadget = res.models[0]!;
    assert.equal(gadget.status, 'unresolved');
    assert.equal(gadget.table, null);
    assert.ok(res.hasUnresolved);
    assert.match(gadget.reason!, /no table matched/);
  });

  it('marks a model UNRESOLVED (never guesses) when multiple candidate tables match', () => {
    // Both `widget` and `widgets` exist - ambiguous, must not pick one.
    const schema: SchemaMetadata = {
      enums: {},
      tables: { widget: table('widget', ['id']), widgets: table('widgets', ['id']) },
    };
    const res = resolvePrismaSchema(parsePrismaSchema('model Widget {\n  id Int @id\n}'), schema);
    assert.equal(res.models[0]!.status, 'unresolved');
    assert.match(res.models[0]!.reason!, /ambiguous/);
  });

  it('reports an unresolved field when the column is missing', () => {
    const src = 'model User {\n  id Int @id\n  ghost Int @map("does_not_exist")\n  @@map("shop_users")\n}';
    const res = resolvePrismaSchema(parsePrismaSchema(src), mockSchema());
    const ghost = res.models[0]!.fields.find((f) => f.prismaName === 'ghost')!;
    assert.equal(ghost.status, 'unresolved');
    assert.match(ghost.reason!, /not found/);
    // and the field is omitted from the verified map
    assert.equal(res.map.models.User!.fields.ghost, undefined);
  });

  it('reports an unresolved compound-unique when no constraint matches', () => {
    const src =
      'model User {\n  id Int @id\n  email String\n  role Int\n  @@unique([email, role])\n  @@map("shop_users")\n}';
    const res = resolvePrismaSchema(parsePrismaSchema(src), mockSchema());
    const cu = res.models[0]!.compoundUniques[0]!;
    assert.equal(cu.status, 'unresolved');
    assert.match(cu.reason!, /no unique constraint/);
  });

  it('flags an ambiguous relation (two FKs to one table) when @relation fields are absent', () => {
    // A back-relation list with no @relation(fields) cannot pick between the two
    // FKs orders has into shop_users.
    const src =
      'model User {\n  id Int @id\n  orders Order[]\n  @@map("shop_users")\n}\nmodel Order {\n  id Int @id\n}';
    const schema = mockSchema();
    // give shop_users two hasMany into orders
    schema.tables.shop_users!.relations = {
      ordersByBuyer: rel('ordersByBuyer', 'hasMany', 'orders', 'buyer_id'),
      ordersByReviewer: rel('ordersByReviewer', 'hasMany', 'orders', 'reviewer_id'),
    };
    const res = resolvePrismaSchema(parsePrismaSchema(src), schema);
    const orders = res.models.find((m) => m.prismaName === 'User')!.relations.find((r) => r.prismaName === 'orders')!;
    assert.equal(orders.status, 'unresolved');
    assert.match(orders.reason!, /ambiguous/);
  });
});

describe('resolvePrismaSchema - --no-db (parse-only)', () => {
  const res = resolvePrismaSchema(parsePrismaSchema(SHOP_PRISMA), null);

  it('produces a parse-only report with no resolution and no map', () => {
    assert.equal(res.noDb, true);
    assert.equal(res.hasUnresolved, false); // parse-only never fails
    assert.equal(Object.keys(res.map.models).length, 0);
    for (const m of res.models) {
      assert.equal(m.status, 'parsed');
      assert.equal(m.table, null);
    }
  });
});

describe('generatePrismaMap - deterministic output', () => {
  it('emits a byte-identical module across runs under noTimestamp', () => {
    const res = resolvePrismaSchema(parsePrismaSchema(SHOP_PRISMA), mockSchema());
    const a = generatePrismaMap(res.map, { noTimestamp: true });
    const b = generatePrismaMap(res.map, { noTimestamp: true });
    assert.equal(a, b);
    assert.doesNotMatch(a, /Generated at:/); // no volatile timestamp line
    assert.match(a, /export const PRISMA_MAP: PrismaCompatMap = \{/);
    assert.match(a, /User: \{\n\s+table: 'shop_users'/);
    assert.match(a, /owner_sku: \['ownerId', 'sku'\]/);
    assert.match(a, /enums: \{ Role: 'shop_role' \}/);
  });
});

// ---------------------------------------------------------------------------
// FIX A: two named relations to the same target model (pair by @relation name)
// ---------------------------------------------------------------------------

// User <- Item via TWO FKs, disambiguated purely by matching @relation names.
// The inverse (list) sides carry only the name; the owning sides pin the FK.
const NAMED_RELATION_PRISMA = `
model User {
  id            Int    @id
  createdItems  Item[] @relation("CreatedBy")
  modifiedItems Item[] @relation("ModifiedBy")
  @@map("shop_users")
}
model Item {
  id           Int  @id
  createdById  Int  @map("created_by_id")
  modifiedById Int  @map("modified_by_id")
  createdBy    User @relation("CreatedBy", fields: [createdById], references: [id])
  modifiedBy   User @relation("ModifiedBy", fields: [modifiedById], references: [id])
  @@map("items")
}
`;

function namedRelationSchema(): SchemaMetadata {
  return {
    enums: {},
    tables: {
      shop_users: table('shop_users', ['id'], {
        relations: {
          createdItems: rel('createdItems', 'hasMany', 'items', 'created_by_id'),
          modifiedItems: rel('modifiedItems', 'hasMany', 'items', 'modified_by_id'),
        },
      }),
      items: table('items', ['id', 'created_by_id', 'modified_by_id'], {
        relations: {
          createdBy: rel('createdBy', 'belongsTo', 'shop_users', 'created_by_id'),
          modifiedBy: rel('modifiedBy', 'belongsTo', 'shop_users', 'modified_by_id'),
        },
      }),
    },
  };
}

describe('prisma-schema parser - @relation("Name")', () => {
  const ast = parsePrismaSchema(NAMED_RELATION_PRISMA);
  const relName = (modelName: string, fieldName: string): string | undefined => {
    const field = ast.models.find((m) => m.name === modelName)!.fields.find((f) => f.name === fieldName)!;
    const attr = field.attrs.find((a) => a.name === 'relation')!;
    const named = attr.args.find((a) => a.key === 'name' && a.kind === 'string');
    if (named?.value) return named.value;
    return attr.args.find((a) => a.key === undefined && a.kind === 'string')?.value;
  };

  it('captures the relation name on the inverse (no fields) side', () => {
    assert.equal(relName('User', 'createdItems'), 'CreatedBy');
    assert.equal(relName('User', 'modifiedItems'), 'ModifiedBy');
  });

  it('captures the relation name on the owning (fields/references) side', () => {
    assert.equal(relName('Item', 'createdBy'), 'CreatedBy');
    assert.equal(relName('Item', 'modifiedBy'), 'ModifiedBy');
  });
});

describe('resolvePrismaSchema - two named relations to one model', () => {
  const res = resolvePrismaSchema(parsePrismaSchema(NAMED_RELATION_PRISMA), namedRelationSchema());

  it('resolves both named pairs with zero ambiguous items', () => {
    assert.equal(res.hasUnresolved, false);
  });

  it('pairs each inverse list relation through the same-named owning FK', () => {
    const user = res.map.models.User!;
    assert.deepEqual(user.relations.createdItems, { name: 'createdItems', cardinality: 'many' });
    assert.deepEqual(user.relations.modifiedItems, { name: 'modifiedItems', cardinality: 'many' });
  });

  it('resolves the owning (belongsTo) sides too', () => {
    const item = res.map.models.Item!;
    assert.deepEqual(item.relations.createdBy, { name: 'createdBy', cardinality: 'one' });
    assert.deepEqual(item.relations.modifiedBy, { name: 'modifiedBy', cardinality: 'one' });
  });
});

// ---------------------------------------------------------------------------
// FIX B: @@unique matched by a UNIQUE INDEX (not only a constraint)
// ---------------------------------------------------------------------------

const uniqueIndex = (name: string, columns: string[], partial = false): IndexMetadata =>
  ({ name, columns, unique: true, definition: '', ...(partial ? { partial: true } : {}) }) as IndexMetadata;

describe('resolvePrismaSchema - @@unique backed by a unique index', () => {
  const PRISMA = `
model Product {
  id      Int    @id
  ownerId Int    @map("owner_id")
  sku     String
  @@unique([ownerId, sku])
  @@map("products")
}
`;

  it('resolves a compound unique that exists ONLY as a unique index', () => {
    const schema: SchemaMetadata = {
      enums: {},
      tables: {
        products: table('products', ['id', 'owner_id', 'sku'], {
          // No unique CONSTRAINT; the composite unique is a unique INDEX.
          uniqueColumns: [],
          indexes: [uniqueIndex('products_owner_id_sku_key', ['owner_id', 'sku'])],
        }),
      },
    };
    const res = resolvePrismaSchema(parsePrismaSchema(PRISMA), schema);
    const cu = res.models[0]!.compoundUniques[0]!;
    assert.equal(cu.status, 'resolved');
    assert.equal(res.hasUnresolved, false);
    assert.deepEqual(res.map.models.Product!.compoundUniques.ownerId_sku, ['ownerId', 'sku']);
  });

  it('ignores a PARTIAL unique index (does not enforce table-wide uniqueness)', () => {
    const schema: SchemaMetadata = {
      enums: {},
      tables: {
        products: table('products', ['id', 'owner_id', 'sku'], {
          uniqueColumns: [],
          indexes: [uniqueIndex('products_owner_id_sku_partial', ['owner_id', 'sku'], true)],
        }),
      },
    };
    const res = resolvePrismaSchema(parsePrismaSchema(PRISMA), schema);
    assert.equal(res.models[0]!.compoundUniques[0]!.status, 'unresolved');
    assert.ok(res.hasUnresolved);
  });
});

// ---------------------------------------------------------------------------
// FIX D: --keep-column-names maps fields to raw DB column spellings
// ---------------------------------------------------------------------------

describe('resolvePrismaSchema - keepColumnNames', () => {
  const res = resolvePrismaSchema(parsePrismaSchema(SHOP_PRISMA), mockSchema(), { keepColumnNames: true });

  it('maps @map fields to the raw DB column name, not camelCase', () => {
    assert.equal(res.map.models.User!.fields.displayName, 'display_name');
    assert.equal(res.map.models.Order!.fields.buyerId, 'buyer_id');
    assert.equal(res.map.models.Product!.fields.ownerId, 'owner_id');
  });

  it('emits column-name compound-unique field lists', () => {
    assert.deepEqual(res.map.models.Product!.compoundUniques.owner_sku, ['owner_id', 'sku']);
  });

  it('leaves relations, accessors, and tables camelCase / snake as before', () => {
    assert.equal(res.map.models.User!.table, 'shop_users');
    assert.equal(res.map.models.User!.accessor, 'shopUsers');
    assert.deepEqual(res.map.models.Order!.relations.buyer, { name: 'buyer', cardinality: 'one' });
  });

  it('serializes the DB column spellings into the emitted map module', () => {
    const src = generatePrismaMap(res.map, { noTimestamp: true });
    assert.match(src, /displayName: 'display_name'/);
    assert.doesNotMatch(src, /displayName: 'displayName'/);
  });
});

// ---------------------------------------------------------------------------
// FIX C: the client is emitted from live metadata even on the partial path
// ---------------------------------------------------------------------------

describe('migrate-from-prisma - client emission on the partial path', () => {
  it('generate() emits the standard client files even when resolution is partial', () => {
    // A schema with one model that does not resolve makes the run partial.
    const partial = resolvePrismaSchema(
      parsePrismaSchema(`${SHOP_PRISMA}\nmodel Gadget {\n  id Int @id\n}`),
      mockSchema(),
    );
    assert.equal(partial.hasUnresolved, true);

    // The command generates the client from the live introspected metadata, so
    // the unresolved item does not block it. Mirror that generate() call here.
    const dir = mkdtempSync(join(process.cwd(), 'tmp-prisma-client-'));
    try {
      const gen = generate({ schema: mockSchema(), outDir: dir, noTimestamp: true });
      assert.deepEqual([...gen.files].sort(), ['index.ts', 'metadata.ts', 'types.ts']);
      for (const f of gen.files) assert.ok(existsSync(join(dir, f)), `${f} should be written`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
