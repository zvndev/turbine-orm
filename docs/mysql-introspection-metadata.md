# MySQL introspection metadata

The MySQL introspector uses native catalog facts for keys, effective insert
defaults, nullability and computed-column write protection. The focused native
suite exercises MySQL 8.4.0 in the default strict SQL mode and with
`ANSI_QUOTES,NO_BACKSLASH_ESCAPES`. This is evidence for that exact version,
not a claim that every MySQL release has been tested.

## Columns and keys

Primary keys and plain unique keys retain native key order. `AUTO_INCREMENT`
sets `isGenerated` and `hasDefault`; explicit identity values remain writable.
Nullable columns have an effective default of NULL, including columns without
an explicit DEFAULT clause. The catalog does not distinguish explicit and
implicit NULL defaults. `defaultValue` is not reconstructed from catalog text:
literal strings and SQL expressions require different quoting rules.

Both VIRTUAL and STORED computed columns set the existing
`isGeneratedStored` flag and `hasDefault`. The flag means computed and
non-writable to the existing generator and mutation guards. Their native
`generationExpression` is retained as opaque text. `DEFAULT_GENERATED` alone
does not mark a column computed, so ordinary expression defaults remain writable.

## Index facts

`IndexMetadata` keeps its existing shape. Complete plain indexes expose their
ordered column names. If any key part is a prefix or expression, the entire
index has `columns: []` and contributes nothing to `uniqueColumns`. This avoids
turning the remaining columns of a mixed functional index into a false unique
selector. MySQL prefix indexes are not partial indexes; `partial` stays absent.

`definition` contains `MySQL index metadata: ` followed by JSON with native
`type`, `visible`, `comment` and ordered `keys`. Each key records `column`,
`expression`, `prefixLength` and native `order` (`A`, `D` or null). These are
display facts, not executable DDL. Consumers must not feed this string to a
migration executor or parse it as a PostgreSQL index declaration. Primary keys
remain in `primaryKey`, outside `indexes`, as before.

The catalog meanings come from the MySQL
[STATISTICS reference](https://dev.mysql.com/doc/refman/8.4/en/information-schema-statistics-table.html).
The query requires the functional-key `EXPRESSION` field introduced in MySQL
8.0.13. This introspection path does not support earlier 8.0 catalog versions,
MySQL 5.7, or MariaDB. It does not add support for partial-index DDL.

## Reverse relation cardinality

Relation names come from the naming pass every engine shares. A reverse
relation is `hasOne` only when its exact FK column set is a complete primary or
plain unique key, and both sides have the same supported native comparison
domain. That is decided per foreign key before naming, so the to-one is named
as PostgreSQL names it: `profiles.user_id INT UNIQUE` referencing `users`
gives `users.profile`, not `users.profiles`. Nullable unique FKs can still be
to-one: multiple NULL child values do not match a parent under SQL equality.

The conservative equality check accepts identical integer, decimal, binary and
temporal declarations. Character columns also require identical declarations,
character sets and collations. Different lengths, unknown facts, approximate
numbers, ENUM/SET and unrecognized domains retain arrays. Superset keys and
mixed expression keys cannot establish to-one cardinality. Cross-database FKs
are omitted instead of binding to a same-named local table. MySQL's native
[foreign-key restrictions](https://dev.mysql.com/doc/refman/8.4/en/create-table-foreign-keys.html)
describe its type and collation requirements; this check is deliberately more
conservative.

`introspectMysqlWith`, `introspectMysql`, and generic `introspect` with
`mysqlDialect` accept `legacyToManyUniques: true` to retain reverse arrays
under their plural names (`users.profiles`), the 0.93.1 output. The MySQL CLI
also forwards this config option to generation, schema/compile commands and
MCP tools. `relationNames` is read by `turbine.config.ts` and by generic
`introspect`, not by `introspectMysqlWith` or `introspectMysql`; see
[Relation names across engines](relation-names.md#keeping-the-old-output).
Views remain outside this introspector's base-table contract.

## Known differences from PostgreSQL

These shapes give MySQL relations that differ from PostgreSQL's for the same
schema, and are left that way deliberately
([details and the other engines](relation-names.md#known-differences)):

- A junction with no primary key, `post_tag_links (post_id, tag_id, UNIQUE (post_id, tag_id))`, gets no `manyToMany` on MySQL; PostgreSQL derives `posts.tags`.
- `ON DELETE CASCADE` is not read: relations carry no `onDelete` or `onUpdate`.
- Two unnamed composite FKs from `returns` to `orders` are named from MySQL's `returns_ibfk_1`, giving `returns.returnsIbfk_1` where PostgreSQL gives `returns.returnsTenantIdOrderId`. Named constraints give the same names on both.
- A name two FKs both want goes to the first in constraint-name order across all tables; PostgreSQL orders by source table first.

Run `npm run gen:studio`, then supply `MYSQL_URL` for an owned
disposable database and run:

```sh
TURBINE_REQUIRE_ENGINE=mysql npx tsx --test src/test/mysql-introspection-metadata.test.ts
```

Without that prerequisite the native case is skipped, not passed. The suite
uses a unique scratch database and drops it after checking native effects,
metadata, write refusals, strict ESM/CJS generated consumers, and compiler
negative controls. The consumer cases build their own temporary ESM/CJS package
and resolve its exports; they do not require or overwrite the worktree's `dist`.

## ENUM labels and catalog limitations

`SchemaMetadata.enums` keeps inline ENUM labels in declaration order under
`table.column` keys. Introspection decodes quoted commas, doubled apostrophes,
literal backslashes, empty labels, BMP Unicode and control characters from
`COLUMN_TYPE`. The catalog serialization is decoded independently of the
caller's SQL mode, including `NO_BACKSLASH_ESCAPES`. A newline remains distinct
from the two characters backslash and `n`. Malformed or truncated ENUM catalog
text from a custom executor throws `ValidationError` instead of returning a
partial label array.

One catalog fact is lossy. On MySQL 8.4.0 the catalog reports `COLUMN_TYPE`
in utf8mb3, so it replaces supplementary Unicode in an ENUM label: stored
`雪🙂` is reported as `雪?`, while the stored definition and every row value
stay intact (`SHOW CREATE TABLE` renders the same utf8mb3 text and is damaged
the same way). When a decoded label holds `?` on a column whose character set
can encode past the BMP (utf8mb4, utf16, utf16le, utf32, gb18030), or on one
whose character set the executor did not report, the labels cannot be trusted
from the catalog alone. The column then gets no `enums` entry, is marked
`enumLabelsUnrecoverable`, and is warned about by table and column name
(`introspect-enum-labels-unrecoverable`); generation types it `string` rather
than a literal union built from damaged text.

A label that really contains a question mark on such a column is typed
`string` too, because catalog text cannot tell a literal `?` from an altered
character. Exact literal types come only from labels declared explicitly: an
`enums` entry on the metadata, or a `columnTypes` override in
`turbine.config.ts` (see [mysql-enum-generation.md](mysql-enum-generation.md)).

Introspection issues `SELECT` statements only, through `introspectMysql` and
through any executor handed to `introspectMysqlWith`. Native trailing-space
canonicalization and duplicate-label refusal also remain server behavior. This
does not establish correctness of generated enum identifiers beyond the round
trips the native suite exercises (labels declared in default strict mode and
under `ANSI_QUOTES,NO_BACKSLASH_ESCAPES`, on MySQL 8.4.0).
