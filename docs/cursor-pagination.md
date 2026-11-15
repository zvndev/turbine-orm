# Cursor pagination

`findMany({ cursor, orderBy })` starts strictly after the supplied cursor. The
ordinary lexicographic predicate remains the default. Explicitly passing
`cursorPredicate: 'lexicographic'` preserves its SQL, bindings and cache entry.

PostgreSQL callers can opt into a strict row comparison:

```ts
await db.items.findMany({
  orderBy: { score: 'asc' },
  cursor: { score: last.score, id: last.id },
  cursorPredicate: 'tuple',
  limit: 25,
});
```

When `id` is the primary key, the effective order is `score ASC, id ASC` and the
predicate is `("items"."score", "items"."id") > ($1, $2)`. Descending order uses
`<`. Existing WHERE, relation-selection and global-filter bindings precede the
cursor bindings. Each ordered cursor value binds once in effective order. The
same validated plan supplies SQL, cache fingerprints and cache-hit bindings.
Tuple statements have a separate signature; prepared-statement naming and its
existing arity and process budgets still apply.

Tuple mode requires all of the following:

- A nonempty, exclusive forward cursor containing every effective ordering
  value, including all appended primary-key or unique-key tie-breakers. It never
  locates an incomplete cursor by querying its row.
- Plain columns, one common direction, and a proven unique key at the end of the
  effective order. Composite primary and non-null unique keys are supported.
  The conservative proof uses primary keys and UNIQUE constraints. Standalone
  unique indexes need complete key and equality/collation provenance before they
  can establish this proof.
  This restriction applies to tuple admission. The default lexicographic
  planner still uses coarse standalone-index metadata and can miss ties when
  expression keys or index collations differ from the ordered columns. Prefer
  primary-key or UNIQUE-constraint proof; that default-planner limitation is
  not repaired by opting out of tuple mode.
- Schema NOT NULL or primary-key proof for every ordered column. Arbitrary
  WHERE conditions do not establish this proof. Metadata must be trustworthy and
  match the database. Ordering and schema key arrays require dense own slots
  with the declared element types. Sparse or inherited indexed values cannot
  establish an ordering or uniqueness proof.
- Non-null scalar values (finite numbers) and builtin integer, numeric, floating-point, text,
  UUID, boolean, date or timestamp columns. Arrays, JSON, custom types and
  unknown type/nullability metadata are unsupported.

Missing or malformed input raises E003. Otherwise unsupported tuple requests
raise E017 before connection checkout. Mixed directions, expression ordering,
collation overrides, nullable columns, inclusive cursors, offset/skip and
`distinct` are refused. The option applies to top-level build, execute,
findFirst, deferred/pipeline and stream paths through the same builder. A
`cursorPredicate` option inside a nested `with` relation is explicitly refused;
query that related table directly. Selecting relations on a top-level tuple
page remains supported.

Only PostgreSQL's canonical capability enables this optimization. Other engine
capability literals are false, and custom dialects that omit the optional
`tupleCursorPredicate` capability refuse tuple mode. Default pagination on all
engines is unchanged.

A row comparison does not promise an index or a particular plan. Index layout,
selectivity, collations, prepared custom/generic planning and table statistics
still matter. Supplying a cursor avoids discovery work; finding one with an
OFFSET query still incurs that query's cost. No cross-engine optimization or
general performance guarantee follows from opting in.
