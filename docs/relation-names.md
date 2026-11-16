# Relation names across engines

Turbine derives relations from foreign keys: a database stores no relation
names. Every engine introspector, and `schemaDefToMetadata` for `defineSchema`
schemas, sends its foreign keys through the same naming pass. This page states
the one rule that differs by input (when a reverse relation is a to-one), which
entry points take which option, and the cases where engines still give
different relations for the same schema.

## A unique foreign key gives a to-one

When a foreign key's columns are exactly a unique key of their own table, at
most one child row can reference each parent row. The parent then gets a
`hasOne` relation (an object or `null`), named with the singular of the child
table, instead of a `hasMany` array named with the plural.

```sql
CREATE TABLE users (id INTEGER PRIMARY KEY);
CREATE TABLE profiles (id INTEGER PRIMARY KEY, user_id INTEGER UNIQUE REFERENCES users (id));
```

| Source | 0.93.1 | 0.94.0 |
| --- | --- | --- |
| PostgreSQL introspection | `users.profile`, `hasOne` | unchanged |
| SQLite (`node:sqlite`), MySQL and SQL Server introspection | `users.profiles`, `hasMany` | `users.profile`, `hasOne` |
| `schemaDefToMetadata` (`defineSchema`) | `users.profiles`, `hasMany` | `users.profile`, `hasOne` |
| better-sqlite3, local libSQL and D1 introspection (new in 0.94.0) | none | `users.profile`, `hasOne` |

The name follows PostgreSQL's rules exactly, because it is the same code:

- Several foreign keys from one table to the same target add `By` and the
  column: `couples.partner_a_id` and `couples.partner_b_id`, both unique and
  both referencing `people`, give `people.coupleByPartnerA` and
  `people.coupleByPartnerB`.
- When the singular is already taken by a column or by a relation named
  earlier, the plural is used. A unique self-reference,
  `nodes.successor_id REFERENCES nodes (id)`, gives `nodes.node` (the
  belongsTo) and `nodes.nodes` (the to-one).

What counts as a unique key, per source:

- **PostgreSQL:** the primary key, a UNIQUE constraint, or a unique index with
  no `WHERE` and no expression key. The index reader is conservative: an index
  it cannot read as plain columns, for example one that names an operator class
  (`text_pattern_ops`), does not count, and the relation stays to-many.
- **`schemaDefToMetadata`:** the primary key, a `unique: true` column, or a
  declared `indexes: [{ columns, unique: true }]` entry.
- **SQLite (`node:sqlite`, better-sqlite3, libSQL, D1):** the primary key or a
  complete unique index (not partial, no expression key). Each column pair
  must also have the same type affinity, the child table's DDL and the index's
  DDL must not contain `COLLATE`, and when the referenced parent key is not
  the rowid alias (a single `INTEGER PRIMARY KEY`), the parent table's DDL must
  not contain `COLLATE` either. A case-insensitive parent key lets the child
  values `'a'` and `'A'` both reference the parent `'a'`, so it is never a
  to-one.
- **MySQL:** the primary key or a unique index with no prefix or expression
  key part. Each column pair must have the same `COLUMN_TYPE`, and a `CHAR` or
  `VARCHAR` pair the same character set and collation. Integer, `DECIMAL`,
  `BINARY`, `VARBINARY`, date and time types qualify; `ENUM`, `SET`, floating
  point and other types keep `hasMany`. See
  [MySQL metadata](mysql-introspection-metadata.md).
- **SQL Server:** an active primary key or a complete unique index (not
  filtered, disabled or hypothetical, no computed key column), with the same
  data type and dimensions on both sides and, for character types, the same
  known collation. See [SQL Server metadata](mssql-introspection-metadata.md).

Each foreign key is decided on its own. A unique column that references two
parents is a to-one for each parent it compares cleanly with, and a to-many
for any other, whatever the other foreign key does.

## Keeping the old output

`legacyToManyUniques: true` keeps every reverse relation `hasMany` under its
plural name: `users.profiles`, an array, as 0.93.1 produced on SQLite, MySQL,
SQL Server and through `schemaDefToMetadata`.

`relationNames` renames a derived relation. To take the to-one but keep the old
key, rename it back: `relationNames: { users: { profile: 'profiles' } }`. An
existing entry that renamed the plural, such as
`relationNames: { users: { profiles: 'details' } }`, no longer matches a
relation and fails with
`relationNames: table "users" has no relation "profiles". Derived relations: profile.`
Rename the singular instead.

| Entry point | `legacyToManyUniques` | `relationNames` |
| --- | --- | --- |
| `turbine generate` / `pull` | `turbine.config.ts` or `--legacy-to-many-uniques` | `turbine.config.ts` |
| `turbine mcp` (PostgreSQL, SQLite, MySQL, SQL Server) | `turbine.config.ts` or `--legacy-to-many-uniques` | no |
| `introspect({ dialect, ... })` with the PostgreSQL, SQLite, MySQL or SQL Server dialect | yes | yes |
| `introspectPostgresCatalog` | yes | no |
| `introspectSqliteDatabase`, `introspectSqlite` | yes | no |
| `introspectBetterSqlite3Database` | yes | no |
| `introspectMysqlWith`, `introspectMysql` | yes | no |
| `introspectMssqlWith`, `introspectMssql` | yes | no |
| `introspectLibsql` | yes | yes |
| `introspectD1` | yes | yes |
| `schemaDefToMetadata(def, { legacyToManyUniques })` | yes | no |

Where an entry point takes no `relationNames`, call `introspect` with the
engine's dialect instead.

## Known differences

Every engine introspector and `schemaDefToMetadata` call one derivation, each
with its own catalog facts, so the shapes that differed across engines in
0.94.0 now derive as on PostgreSQL:

1. **A junction table with no primary key.**
   `post_tag_links (post_id REFERENCES posts, tag_id REFERENCES tags, UNIQUE (post_id, tag_id))`
   gives `posts.tags` and `tags.posts` (`manyToMany`) on every engine. Through
   `schemaDefToMetadata`, a declared two-column
   `indexes: [{ columns, unique: true }]` entry counts the same way. Both keys
   must reference their targets' primary keys; see
   [the limitation below](#junction-keys-to-another-column).
2. **Referential actions.** `FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE`
   gives relations carrying `onDelete: 'cascade'` on every engine.
3. **Two composite foreign keys from one table to the same target** are named
   from their constraint names. SQLite, libSQL and D1 read a declared
   `CONSTRAINT` name from the `CREATE TABLE` text, matched to its key by the
   child columns, the target table and the referenced columns. A name the
   engine generated (MySQL `returns_ibfk_1`, SQL Server `FK__returns__...`
   with a random suffix), or no name at all, counts as the name PostgreSQL
   would have generated for the same declarations. For two unnamed
   `returns (tenant_id, order_id)` and `returns (tenant_id, replacement_id)`
   keys to `orders`, the first gives `returns.returnsTenantIdOrderId` (from
   `returns_tenant_id_order_id_fkey`) on every engine.
4. **Which relation keeps a contested name.** When two foreign keys want one
   name, the first in source table, then constraint name, order keeps it and
   the other falls back to another name, whatever order the catalog returned
   them in. For `notes (owner REFERENCES "user", user_id REFERENCES users)`
   with the constraints named `notes_a_owner` and `notes_z_user`, every engine
   gives `notes.user` to the key to `user` and `notes.userRel` to the key to
   `users`. Pin either name with `relationNames`.

### Generated constraint names follow declaration order

PostgreSQL names an unnamed foreign key `<table>_<columns>_fkey`, cut to 63
bytes, and counts up (`_fkey1`, `_fkey2`) while any constraint in the schema
holds the name. A table's PRIMARY KEY, UNIQUE, CHECK and NOT NULL constraints
exist before its foreign keys are named, so their names count; the name of a
plain index does not. The foreign keys are then named one at a time, in
declaration order, and PostgreSQL refuses the statement if an explicit name
comes after an unnamed key that already took it as its default. The names
are facts in its catalog, and they depend on that order:

```sql
CREATE TABLE parents (a INTEGER, b INTEGER, c INTEGER, d INTEGER, PRIMARY KEY (a, b), UNIQUE (c, d));
CREATE TABLE links (
  x INTEGER, y INTEGER,
  FOREIGN KEY (x, y) REFERENCES parents (a, b),  -- links_x_y_fkey:  links.linksXY
  FOREIGN KEY (x, y) REFERENCES parents (c, d)   -- links_x_y_fkey1: links.linksXYFkey1
);
```

Declare the two keys the other way round and `links.linksXY` references
`(c, d)` instead. A `CONSTRAINT links_x_y_fkey CHECK (x > 0)` in `links`
moves both keys up the counter, to `links_x_y_fkey1` and `links_x_y_fkey2`.

The other engines synthesize these names by the same rule, in the order the
`CREATE TABLE` statement declares the keys: SQLite's text, which SQLite's own
catalog lists in reverse, and the order MySQL numbers its `_ibfk_<n>` names
in. Before choosing any default they reserve every explicit foreign-key name
and every other constraint name the table carries. For every statement
PostgreSQL accepts, that gives PostgreSQL's answer. For one it refuses, such
as an explicit `CONSTRAINT links_x_y_fkey` on the second of two keys over
`(x, y)`, which SQLite and MySQL accept, the explicit key keeps its name and
the unnamed one takes the counter. An explicit name longer than 63 bytes,
which MySQL (64 characters) and SQL Server (128) accept, is cut to 63 bytes
of UTF-8 as PostgreSQL stores it, never inside a character.

A schema declared in different orders on different databases can therefore
swap two such relation names; pin them with `relationNames`.

### What still differs

These edge cases, all in reading the constraint name of a composite foreign
key that shares its target, can still give different names:

- MySQL stores no flag for a generated name, so an explicit constraint named
  like one (`CONSTRAINT returns_ibfk_1 FOREIGN KEY (x, y)`) is read as
  unnamed and takes PostgreSQL's default, `returns_x_y_fkey`: MySQL gives
  `returns.returnsXY` where PostgreSQL gives `returns.returnsIbfk_1`. To keep
  PostgreSQL's name, rename it:
  `relationNames: { returns: { returnsXY: 'returnsIbfk_1' } }`.
- MySQL keeps an unquoted mixed-case constraint name as written, where
  PostgreSQL folds it to lower case.
- MySQL's catalog lists a UNIQUE index exactly as it lists a UNIQUE
  constraint, so a unique index named like a default is reserved too, where
  PostgreSQL would not consult an index. And MySQL names every primary key
  `PRIMARY`, so a primary key named like a default is not seen.
- SQL Server records no declaration order for the keys it named itself, so
  between those the counter goes by child columns, then referenced table and
  columns, then actions.
- When two tables' default names coincide (`box_items` with `item_id` and
  `box` with `items_item_id` are both `box_items_item_id_fkey`), PostgreSQL
  gives the counter to the table created second; the other engines give it in
  table name order.
- PostgreSQL keeps the name a key was created with through a later table
  rename or the drop of another key; the other engines name the keys a table
  has now.
- SQLite, libSQL and D1 take a declared name from the statement text. A key
  whose clause the reader cannot follow (SQLite also accepts table
  constraints with no comma between them) takes the default name, as an
  unnamed key does.

### Junction keys to another column

An automatic `manyToMany` is derived only when both junction keys reference
their targets' primary keys. The many-to-many query joins the junction to the
target's primary key, so through a key to any other unique column it would
return rows the junction does not reference:

```sql
CREATE TABLE tags (id INTEGER PRIMARY KEY, code INTEGER UNIQUE);
CREATE TABLE links (
  post_id INTEGER REFERENCES posts (id),
  tag_code INTEGER REFERENCES tags (code),
  UNIQUE (post_id, tag_code)
);
```

This gives `links.post`, `links.tag`, `posts.links` and `tags.links`, and no
`posts.tags` or `tags.posts`, on every engine and through
`schemaDefToMetadata`. Before this release PostgreSQL introspection derived
both, and `with: { tags: true }` returned the tag whose primary key equals
`tag_code`. Full support for a junction key that references another column
is a known limitation: read such a junction through its `belongsTo` and
`hasMany` relations, or reference the primary key. An explicitly declared
`manyToMany` is not affected.

`src/test/relation-derivation-parity.test.ts` creates each shape natively on
PostgreSQL, MySQL, `node:sqlite` and better-sqlite3, and as a `defineSchema`
schema where one can express it, and holds each to PostgreSQL's relations.
SQL Server is covered through catalog fixtures in
`src/test/mssql-introspection-metadata.test.ts`, and libSQL and D1 through
their own native tests.
