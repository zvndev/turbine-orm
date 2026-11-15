# Composable SQL fragments

`turbine-orm/sql` is an optional, execution-free import for reusable SQL
templates, identifiers and lists. It does not add code to the ordinary client
or serverless entry points. It uses the existing dialect's placeholder and
identifier-quoting methods.

```ts
import { postgresDialect } from 'turbine-orm';
import { compile, identifier, join, sql } from 'turbine-orm/sql';

const ids = [10, 20];
const organizationId = 7;
const scope = sql`${identifier('u', 'organization_id')} = ${organizationId}`;
const selectedIds = ids.length
  ? sql`${identifier('u', 'id')} IN (${join(ids)})`
  : sql`1 = 0`;

const query = sql`
  SELECT ${identifier('u', 'id')}, ${identifier('u', 'name')}
  FROM ${identifier('public', 'users')} AS u
  WHERE ${scope} AND ${selectedIds}
`;
const compiled = compile(query, postgresDialect);
// SQL contains $1, $2, $3; params is [7, 10, 20].
const rows = await db.rawUnsafe<{ id: number; name: string }>(
  compiled.sql, ...compiled.params,
);
```

Here `db` is an existing PostgreSQL client. Pass `sqliteDialect` from
`turbine-orm/sqlite`, `mysqlDialect` from `turbine-orm/mysql`, or `mssqlDialect`
from `turbine-orm/mssql` when compiling for those clients. Their placeholders
are `:p1`, `:p1`, and `@p1` respectively. These named placeholders are meant
for Turbine's existing driver adapters. A native driver may require its own
binding map rather than a positional array. The compiler does not translate
SQL syntax or certify engine compatibility. PowDB uses PowQL, not these SQL
templates.

| Function | Behavior |
| --- | --- |
| `` sql`text ${value}` `` | Binds ordinary values; expands genuine fragment tokens. |
| `identifier(...names)` | Quotes each component separately; rejects empty components and NUL. |
| `join(values, separator?)` | Joins values or fragments; default separator is comma and space. |
| `compile(fragment, dialect)` | Returns a fresh `{ sql, params }` without executing anything. |

`identifier('public', 'users')` is a qualified name. `identifier('public.users')`
is one name containing a dot. `identifier('*')` is a column named `*`; write a
static `*` in the template for a wildcard. Quoting keeps hostile quotes and
comments inside a name. It does not decide whether that name is authorized;
use an application allowlist when choosing user-selectable tables or columns.

`join` accepts an array and an optional genuine fragment separator, such as
``join(predicates, sql` AND `)``. Separators may have parameters. Every
occurrence gets its own placeholder in final SQL order, including reused
fragments. Empty joins emit empty text and no parameters; singleton joins do
not emit a separator. `join([])` inside `IN (...)` would produce `IN ()`.
Choose an explicit empty-set predicate such as ``sql`1 = 0``, as in the
example. The compiler does not guess SQL semantics.

Ordinary interpolation of a string, Date, array, empty array, JSON object or
null always produces one bound parameter. Arrays expand only through an
explicit `join`. Driver value conversion and supported types still follow the
existing raw APIs; the compiler neither serializes JSON nor coerces dates or
arrays for a particular engine. Use explicit casts or driver-supported
representations where required.

Fragments have frozen, opaque structure. Lists are captured when composed,
and each compilation starts numbering at one. Bound objects retain their
identity: do not mutate parameter objects, dates or arrays between building
and executing a fragment if you need stable values. Mutating a returned
`params` array does not change the fragment. Tokens belong to the module copy
that created them; build and compile using the same import. Tokens from another
installed copy or the other ESM/CJS build are ordinary values on interpolation
and are refused as compiler roots or separators.

Request JSON cannot manufacture a genuine fragment token. Objects resembling
fragments, serialized tokens and object copies remain values. Calling `sql`
with ordinary arrays or strings instead of a tagged template is refused with
`TypeError`; invalid factory/compiler arguments also throw `TypeError`. This
is an API boundary for request data, not a sandbox for arbitrary JavaScript
code, which can construct frozen template arrays itself. Keep template text
and dialect implementations in trusted application code. There is no runtime
string-to-fragment factory.

This API preserves `db.sql` and `db.raw` behavior. Passing a fragment to either
existing tag binds the fragment as a value; it does not expand it. Compile
first, then pass the returned text and values together to `db.rawUnsafe` (or
its transaction equivalent). Do not concatenate request data into that text.

Raw SQL remains the caller's responsibility: these fragments do not apply
model global filters, tenant scoping, soft-delete rules, PII masking, column
mapping or mass-mutation guards. Add authorization and predicates explicitly.
Result types supplied to `rawUnsafe<T>` remain assertions by the caller, with
no runtime validation or decoding. The optional projection surface below
infers selected fields from caller-declared column types; it does not verify
those declarations against a database. Windows and arbitrary typed
expressions remain outside this surface.

See [the compilation-only example](../examples/sql-fragments.ts).

After building, `npm run check:sql-fragments` packs the package and checks ESM,
CJS and strict TypeScript consumers in isolation, without installed drivers.
To check an existing tarball, pass its path after `--`.


## Typed column projections and joins

Use `table<Row>()(physicalName, alias)` to declare the SQL column names and
values your driver returns. Aliases are explicit; the curried factory preserves
both the caller's row type and the inferred literal alias.

```ts
import { compile, selectFrom, sql, table, type SqlResult } from 'turbine-orm/sql';

const u = table<{ id: number; name: string; team_id: number | null }>()('users', 'u');
const p = table<{ user_id: number; title: string }>()(['public', 'posts'], 'p');
const query = selectFrom(u)
  .leftJoin(p, sql`${u.column('id')} = ${p.column('user_id')}`)
  .where(sql`${u.column('id')} > ${10}`)
  .select({ userId: u.column('id'), name: u.column('name'), title: p.column('title') });
type Row = SqlResult<typeof query>;
// { userId: number; name: string; title: string | null }
const built = compile(query, postgresDialect);
const rows = await db.rawUnsafe<Row>(built.sql, ...built.params);
```

`innerJoin` retains each column's declared type. `leftJoin` adds `null` to
selected columns from the joined alias, including columns declared non-null.
Later WHERE predicates and inner joins do not narrow that nullable type.
Selecting the same column under several output names is supported. The map
must contain at least one genuine column reference; arbitrary expression
fragments cannot declare an inferred value type. Only the named columns are
selected; there is no wildcard expansion, implicit column mapping or relation
loading. A declared nullable value stays nullable through an inner join.

Builders are immutable: each join, WHERE or ordering call returns a new branch.
Repeated WHERE calls combine parenthesized predicates with AND. ON clauses may reference
prior tables and the new joined table. WHERE and SELECT may reference only
tables already declared on that branch. This is checked by private table
identity, including typed columns nested in fragments and join separators.
A separately created table with the same alias is a different reference and
cannot stand in for the declared table. Alias names and selected output names
must match `[A-Za-z_][A-Za-z0-9_]{0,62}`; case-insensitive collisions are
conservatively refused for portability. Physical table/column identifiers keep
the full existing identifier quoting behavior. Supply an array for qualified
table names; dots in a single component are literal. There is no schema lookup:
`column(name)` checks `keyof Row` in TypeScript, and safely quotes the supplied
name at runtime. It cannot verify a caller's type assertion or a physical
column's existence.

A completed selection is a genuine, closed fragment. Reuse it inside explicit
parentheses for an uncorrelated subquery. Its internal references stay in its own
scope and every occurrence gets fresh traversal-order parameter numbers:

```ts
const ids = selectFrom(u)
  .where(sql`${u.column('name')} = ${requestedName}`)
  .select({ id: u.column('id') });
const titles = selectFrom(p)
  .where(sql`${p.column('user_id')} IN (${ids})`)
  .select({ title: p.column('title') });
const result = compile(titles, postgresDialect);
```

There is no typed derived-table alias, correlated subquery, general expression
builder, SQL parser or execution method. The type brand is retained only on a
completed selection; wrapping it in `sql` produces an ordinary fragment.
`SqlResult` describes the selection's declared columns, not arbitrary raw
composition around it.

Scope checks cover genuine `column()` references. Raw template text and
`identifier()` are trusted SQL escape hatches and are not parsed for table
references, SQL validity or policies. Ordinary interpolated values are always
parameters; forged/cloned fragments never become SQL. Build and compile with
the same module copy, including when using ESM and CJS. Raw composition does
not automatically enforce tenants, global filters, soft deletion or PII rules.
Row declarations must describe the actual driver's representations (for
example, text versus bigint versus number), not a desired decoded value. No
runtime decoding, validation, policy injection or engine certification occurs.


## Typed column ordering

Call `orderBy(...keys)` before `select`, with one or more explicit
`{ column, direction }` descriptors. `SqlOrder<Scope>` is the exported descriptor
type; directions are the lowercase literals `'asc'` and `'desc'`.

```ts
const ordered = selectFrom(u)
  .leftJoin(p, sql`${u.column('id')} = ${p.column('user_id')}`)
  .orderBy({ column: u.column('id'), direction: 'desc' })
  .orderBy({ column: p.column('title'), direction: 'asc' })
  .select({ userId: u.column('id'), title: p.column('title') });
// ... ORDER BY "u"."id" DESC, "p"."title" ASC
// SqlResult<typeof ordered> is { userId: number; title: string | null }.
```

Keys retain their supplied order. Repeated calls append to one `ORDER BY`
clause after all predicates, regardless of when `where` is called. Keys may
use unprojected columns, but only genuine `column()` tokens from tables or
CTE references already declared on that builder branch. A separate reference
with the same alias is refused by identity. Arbitrary expressions, raw
fragments, identifier fragments and unchecked direction strings are refused.
Descriptors must provide their column and direction as own data properties;
getters and inherited descriptor values are not read.

Calls capture descriptor values immediately and leave earlier builders and
completed selections unchanged. Ordering emits no parameters and preserves
final traversal order for all predicate and repeated-fragment parameters.
It does not narrow left-join nullability, verify caller-declared value types,
decode results or add model policy. Queries without `orderBy` retain their
original text and parameters. No unique tie-breaker is added: tied keys have
no guaranteed relative order. NULL ordering and collation follow the server.

Ordered selections remain complete selections for CTE definitions, set
operands and explicitly parenthesized subqueries. Set operands keep their
existing derived-SELECT wrappers, so branch-local ordering does not become
an invalid inner compound clause on PostgreSQL or SQLite. An inner order does
not guarantee the outer query's order. Order the outer SELECT explicitly when
needed; ordering a completed UNION still requires trusted raw SQL.

Column `ASC`/`DESC` compilation is checked against PostgreSQL, SQLite, MySQL
and SQL Server dialects. Native execution of ordering and composed statements
is covered on PostgreSQL and SQLite. MySQL and SQL Server checks are compilation
only; native SQL Server remains unverified. SQL Server restricts `ORDER BY`
inside derived tables, CTEs and subqueries unless additional engine-specific
syntax is supplied. Keep its typed ordered selections at the top level; this
API does not add that syntax or infer an engine from its placeholders.
Pagination, `NULLS FIRST/LAST`, aggregates and expression ordering are outside
this surface.

## Nonrecursive CTEs and set operations

`cte(name, selection)` defines a named, immutable CTE from a genuine completed
selection. `definition.ref(alias)` creates a typed table reference for use with
`selectFrom`, joins and column projections. It exposes only the selection's
output names, retaining its declared value types and join nullability.

```ts
import { cte, selectFrom, sql, table, unionAll, withCtes } from 'turbine-orm/sql';

const users = table<{ id: number; name: string }>()('users', 'u');
const chosen = cte('chosen_users', selectFrom(users)
  .where(sql`${users.column('id')} > ${10}`)
  .select({ id: users.column('id'), name: users.column('name') }));
const a = chosen.ref('a');
const b = chosen.ref('b');
const first = selectFrom(a).select({ id: a.column('id'), name: a.column('name') });
const second = selectFrom(b).select({ id: b.column('id'), name: b.column('name') });
const statement = withCtes([chosen], unionAll(first, second));
const built = compile(statement, postgresDialect);
// One definition parameter, [10]. The two references reuse the CTE's rows.
// SqlResult<typeof statement> is { id: number; name: string }.
```

`withCtes(definitions, body)` produces a complete named `SqlSelection`.
Definitions are visible by token identity in array order; each definition may
use earlier entries, and the body may use all entries. Compilation refuses an
omitted, forward or recursive reference, including one inside a closed nested
selection or set operand. A different definition with the same name cannot
satisfy a reference. Duplicate names, including case-only differences, are
refused. Definition names and reference aliases use the existing bounded ASCII
alias rules. Physical identifiers still use the compilation dialect's escaping.
An unqualified physical table whose name collides with a surrounding CTE is
refused, including inside nested complete selections and definition bodies.
Use a schema-qualified physical name to disambiguate it. This conservative
case-insensitive check covers genuine table tokens; trusted raw SQL is not parsed.

Each call to `ref` creates an independent table identity. Declare both references
on a join before using both columns. A completed subquery owns its column scope;
free outer columns are refused. A nested `withCtes` owns a separate complete CTE
scope and cannot capture outer CTE definitions. Ordinary closed subqueries inside
one WITH can read definitions visible at that position. No recursive or
self-referential definition factory, data-changing CTE, materialization option
or typed derived-table factory is provided.
A completed WITH can itself be the body of another WITH; it is wrapped in a
derived SELECT so the nested definitions remain valid SQL with their own scope.

`union(left, right)` removes duplicates; `unionAll(left, right)` retains them.
`intersect(left, right)` returns distinct rows present in both operands.
`except(left, right)` returns distinct rows from the left operand absent from
the right. These compare entire projected rows, including NULL values under
the engine's set comparison rules; they are not key-based joins or `NOT IN`.
There are no `intersectAll`/`exceptAll` exports or ALL options.

```ts
import { except, intersect, union } from 'turbine-orm/sql';

const overlap = intersect(first, second);
const onlyFirst = except(first, second);
const grouped = intersect(union(first, second), first);
// Function nesting fixes grouping: (first UNION second) INTERSECT first.
const orderedOverlap = compile(sql`${withCtes([chosen], overlap)} ORDER BY ${identifier('id')}`, postgresDialect);
```

All four operators require genuine completed named selections. The projection aliases must
match **in the same order**, with the same arity. Reversed object property order
throws `TypeError`, even when TypeScript sees identical object shapes. No
implicit reordering occurs. Each operand is wrapped as a derived SELECT so
nested compound statements and complete WITH statements keep their grouping
on PostgreSQL and SQLite. Wrap a final compound statement in trusted `sql` to
add ordering, as with other selections.

Set results conservatively retain per-column declared unions, including nullability and scalar
literal unions. TypeScript refuses different alias sets, optional or string
index-signature projection shapes, and incompatible declared value categories
such as number versus string. Non-null scalar literal types must share their
primitive category; other non-null declared types must be mutually assignable.
A null-only declared column may combine with another declared column.
These checks do not inspect SQL types or prove database coercion behavior. Use
accurate driver value declarations and SQL-compatible operand types; runtime
JavaScript cannot inspect erased TypeScript declarations. Decoding remains
manual. Explicit casts or erased type annotations can defeat static checks,
while genuine-token and ordered-alias checks still run.
INTERSECT and EXCEPT do not narrow those declared unions or remove left-join
nullability, even if a particular result could use a narrower type. Operand
ordering stays inside its derived SELECT; explicitly order the outer result.
Nested function calls preserve grouping across engine precedence differences.

Native execution tests cover duplicate and NULL rows, empty operands, mixed
operator grouping, ordering, nested WITH scopes and repeated parameter effects
on PostgreSQL 18.6 and SQLite. [PostgreSQL 18 set syntax](https://www.postgresql.org/docs/18/queries-union.html)
and [SQLite compound SELECT syntax](https://sqlite.org/lang_select.html#compound_select_statements)
support the distinct operators used here. MySQL compilation targets the
[8.0.31+ set syntax](https://dev.mysql.com/doc/refman/8.0/en/set-operations.html);
older MySQL versions do not support INTERSECT/EXCEPT. SQL Server compilation
targets its [documented distinct set syntax](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/set-operators-except-and-intersect-transact-sql?view=sql-server-ver17).
These MySQL and SQL Server checks are compilation-only, without native execution.
The compiler's two dialect hooks cannot detect server versions or enforce SQL
grammar. SQL Server does not allow WITH inside a derived operand and restricts
branch-local ORDER BY as described above: use unordered selections and hoist
CTEs to one top-level `withCtes` when targeting SQL Server. SQLite and SQL Server
do not support INTERSECT ALL or EXCEPT ALL; those variants remain absent on all
dialects. Collations, SQL type comparability and result coercion follow the server.

Compile a complete statement or interpolate it inside an explicitly parenthesized
subquery. A reused completed WITH emits its definition parameters once per
occurrence; a single WITH with several references emits its definition once.
All operands, definitions, predicates and raw wrapper values share one final
parameter counter, starting at one on every compilation. No parameter offsets
are stored on reusable fragments.

Empty or malformed definition arrays, forged definitions/references/operands,
and ordinary raw fragments used as typed definitions or set operands are
refused. Wrapping a selection in `sql` loses its typed projection metadata.
Create, compose and compile using the same module copy; ESM/CJS and separately
installed copies do not share brands. Raw template text and `identifier` remain
trusted escape hatches, so hand-written names/references are not parsed or
validated as CTE dependencies. There is no recursion, UPDATE
CTE, automatic model policy or result decoding. Native PostgreSQL and SQLite
coverage does not certify other servers; native SQL Server is not certified.
