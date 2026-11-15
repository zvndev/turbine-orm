# Packed tuple cursor contract

Build once, then run each required runtime against the same tarball:

```sh
npm run build
npm pack --ignore-scripts --pack-destination /tmp
node tooling/cursor-tuple/consumer.mjs "${TARBALL:?absolute package archive path}"
```

Use Node 22.16 and 24.10 for the consumer matrix. Each invocation installs the
actual archive into an owned temporary project, compiles strict ESM and CJS
consumers with `skipLibCheck: false` and without `@types/pg`, then exercises both
runtime exports. TypeScript and Node declaration versions come from the root
lock. The disposable project also pins the driver dependency closure to the
root lock and verifies the loaded driver paths, versions and entry hashes.
Installation scripts are disabled and the temporary project is removed
on success or failure. The source unit and native PostgreSQL regression cases
are `src/test/cursor-tuple*.test.ts`.

The native producer uses a fresh owned PostgreSQL 18.6 cluster per invocation:

```sh
PG_PREFIX=/path/to/pgsql-prefix TUPLE_REPORT=/tmp/tuple-source.json \
  node --import tsx tooling/cursor-tuple/native.mjs
```

It fails when the server or root-lock driver prerequisites are absent. It checks
exact values, diagnostic plans and the actual backend's prepared executions,
then stops the cluster and records cleanup. The 39 producer checks include one
invocation of the three-test dedicated native suite. Those nested tests are not
additional producer checks. These diagnostics establish no performance ranking.
Set `TUPLE_API` to an extracted package's ESM or CJS entry to test that artifact.
`TUPLE_TOOLS_PACKAGE` adds real CLI and stdio MCP compile/refusal checks from a
concretely staged package. `TUPLE_EXTRA_NATIVE=1` separately runs the option
behavior and exact aggregate-value suites; their counts stay separate.

`default-compat.mjs <baseline-package-dir> <candidate-package-dir>` compares 357
query cases twice across four SQL dialects, including warm cache fingerprints,
SQL, parameters, prepared names and transformed values. Both directories must
contain actual staged packages and resolve their drivers. These are package
comparison checks, not native certification of the non-PostgreSQL engines.
`guard-consumer.mjs <candidate-package-dir>` checks tuple isolation, complete
comparison, own-slot proofs, suffix proofs and strict builtin type boundaries.
