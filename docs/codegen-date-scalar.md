# Generated Date names and temporal scalars

A table named `dates` keeps its public `Date` entity and `dates` accessor. In that module, inferred timestamp and date fields use `globalThis.Date` so the entity cannot replace the JavaScript scalar type. A generated enum named `Date` receives the same treatment for independent temporal fields; enum references still name the enum.

The generator uses the existing temporal-column metadata to identify inferred Date scalars. It preserves nullable and array forms, and qualifies the Date member introduced by time-of-day write inputs. Explicit `columnTypes`, declared TypeScript types and custom type expressions retain their meanings. Unmarked hand-written metadata keeps its type text. Runtime metadata and database parsing stay unchanged.

The regression tests cover scalar and write types, nullable arrays, enums, overrides, custom metadata, ordinary names and the existing Record dictionary behavior. The installed-consumer fixture exercises strict compilation with unmarked negative cases, generated native SQLite reads and writes, stored values, nested relations, transactions and caller/factory ownership. It accepts a physical consumer root, `esm` or `cjs`, and a fresh output label as arguments.
