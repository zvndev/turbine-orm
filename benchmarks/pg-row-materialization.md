# Row assignment preservation checks

The scalar decoder classifies plain destination fields once per exact column shape. It still reads every row's own keys and verifies their complete order. A reentrant read keeps the outer row's classification snapshot. Cell conversion, native object construction and count hydration retain their existing phases.

Run the focused source checks with an installed development toolchain:

```sh
node --import tsx --test benchmarks/pg-row-materialization.test.ts
```

The installed-consumer fixture requires a disposable native PostgreSQL database and an actual package installation. It checks complete values and key order, projection changes, integers, dates, JSON, bytes, tenant filters, relation filters, counts, lazy accessor descriptors and caller pool ownership. Invoke it once for each runtime, format and driver version:

```sh
DATABASE_URL=postgresql://... node benchmarks/pg-consumer.mjs /absolute/consumer esm /absolute/report.json
DATABASE_URL=postgresql://... node benchmarks/pg-consumer.mjs /absolute/consumer cjs /absolute/report.json
```

The fixture creates and drops only `materialization_pg_rows` and `materialization_pg_children`. Its raw `__proto__` alias check records the existing pg 8.15 compatibility hold separately from ordinary mapped fields.

`pg-array-control.mjs` demonstrates why bare array mode is unsuitable as an equivalent replacement: an OID parser can install a numeric prototype accessor before a later cell is assigned. Object rows retain their pre-created own field; the native array can invoke the inherited setter and lose its own element. The control expects this difference and does not enable an array route in production.

```sh
DATABASE_URL=postgresql://... node benchmarks/pg-array-control.mjs /absolute/consumer /absolute/control.json
```

These commands establish correctness and a rejected alternative. They make no comparative performance claim.
