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
   `indexes: [{ columns, unique: true }]` entry counts the same way.
2. **Referential actions.** `FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE`
   gives relations carrying `onDelete: 'cascade'` on every engine.
3. **Two composite foreign keys from one table to the same target** are named
   from their constraint names. SQLite, libSQL and D1 read a declared
   `CONSTRAINT` name from the `CREATE TABLE` text. A name the engine generated
   (MySQL `returns_ibfk_1`, SQL Server `FK__returns__...` with a random
   suffix), or no name at all, counts as the name PostgreSQL would have
   generated. For two unnamed `returns (tenant_id, order_id)` and
   `returns (tenant_id, replacement_id)` keys to `orders`, the first gives
   `returns.returnsTenantIdOrderId` (from `returns_tenant_id_order_id_fkey`)
   on every engine.
4. **Which relation keeps a contested name.** When two foreign keys want one
   name, the first in source table, then constraint name, order keeps it and
   the other falls back to another name, whatever order the catalog returned
   them in. For `notes (owner REFERENCES "user", user_id REFERENCES users)`
   with the constraints named `notes_a_owner` and `notes_z_user`, every engine
   gives `notes.user` to the key to `user` and `notes.userRel` to the key to
   `users`. Pin either name with `relationNames`.

These edge cases, all in how a composite foreign key's constraint name is
read, can still give different names:

- MySQL stores no flag for a generated name, so an explicit constraint named
  like one (`returns_ibfk_1`) is read as PostgreSQL's default name too.
- SQLite, libSQL and D1 match a declared name to its foreign key by the child
  columns and the target table. Two declarations over the same columns to the
  same table are ambiguous, and both take PostgreSQL's default name.
- When two default names collide (two unnamed keys over the same columns, or
  names that truncate to the same 63 bytes), the `fkey1` suffix goes to the
  key the catalog lists second, and that order differs between engines. An
  explicit name equal to the default another key would take is not reserved
  first.
- MySQL keeps an unquoted mixed-case constraint name as written, where
  PostgreSQL folds it to lower case.

`src/test/relation-derivation-parity.test.ts` and
`src/test/relation-unique-fk-parity.test.ts` create each shape natively on
every engine they can reach and hold it to PostgreSQL's relations.
