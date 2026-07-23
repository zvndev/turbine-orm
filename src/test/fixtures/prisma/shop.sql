-- ============================================================================
-- Integration fixture for `turbine migrate-from-prisma`.
-- The DDL here mirrors src/test/fixtures/prisma/shop.prisma so the command can
-- be driven end-to-end against a real database. snake_case columns, @@map
-- divergence (shop_users, order_items), a named + a default composite unique, a
-- composite primary key, multiple FKs to one table, an enum, and a Prisma-style
-- implicit m2m junction (_ProductToTag).
-- Idempotent: drops everything first.
-- ============================================================================

DROP TABLE IF EXISTS "_ProductToTag" CASCADE;
DROP TABLE IF EXISTS order_items CASCADE;
DROP TABLE IF EXISTS orders CASCADE;
DROP TABLE IF EXISTS products CASCADE;
DROP TABLE IF EXISTS tags CASCADE;
DROP TABLE IF EXISTS shop_users CASCADE;
DROP TYPE IF EXISTS shop_role CASCADE;

CREATE TYPE shop_role AS ENUM ('ADMIN', 'MEMBER');

-- User @@map("shop_users")
CREATE TABLE shop_users (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email        TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role         shop_role NOT NULL DEFAULT 'MEMBER',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Product (heuristic product -> products)
CREATE TABLE products (
  id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id BIGINT NOT NULL REFERENCES shop_users(id),
  sku      TEXT NOT NULL,
  name     TEXT NOT NULL,
  price    NUMERIC NOT NULL DEFAULT 0,
  UNIQUE (owner_id, sku)       -- named @@unique(name: "owner_sku")
);
CREATE INDEX idx_products_owner_id ON products(owner_id);

-- Tag (heuristic tag -> tags)
CREATE TABLE tags (
  id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  label TEXT NOT NULL UNIQUE
);

-- Order (heuristic order -> orders) - two FKs to shop_users (buyer, reviewer).
CREATE TABLE orders (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  buyer_id    BIGINT NOT NULL REFERENCES shop_users(id),
  reviewer_id BIGINT REFERENCES shop_users(id),
  product_id  BIGINT NOT NULL REFERENCES products(id),
  quantity    INTEGER NOT NULL DEFAULT 1,
  UNIQUE (buyer_id, product_id)  -- default @@unique([buyerId, productId])
);
CREATE INDEX idx_orders_buyer_id ON orders(buyer_id);
CREATE INDEX idx_orders_product_id ON orders(product_id);

-- OrderItem @@map("order_items") - composite PK, payload column keeps it a table.
CREATE TABLE order_items (
  order_id   BIGINT NOT NULL REFERENCES orders(id),
  product_id BIGINT NOT NULL REFERENCES products(id),
  quantity   INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (order_id, product_id)
);

-- Prisma implicit many-to-many junction Product <-> Tag.
CREATE TABLE "_ProductToTag" (
  "A" BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  "B" BIGINT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY ("A", "B")
);
