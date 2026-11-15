# Matched PostgreSQL consumer comparison

The existing `scripts/measure-consumer-cost.mjs --compare` entry measures the
actual packed Turbine consumer alongside Drizzle 0.45.4, Drizzle 1.0.0-rc.5 and
Prisma client/adapter/CLI 7.10.1. It reuses the harness's command runner, strict
compiler and resource monitor. It does not score ORMs or time database queries.
The original profiles, locks, size budgets and coverage floors are unchanged.

Every arm uses `pg@8.23.1`, `@types/pg@8.23.1`, TypeScript 6.0.3 and Node types
22.20.4. npm runs through the **same Node executable** as the compiler and runtime
probes. Separate runtime/tooling role manifests and locks freeze every actual
installed package/version, lock integrity, manifest hash and file hash are retained. No checkout source or dependency
imports substitute for an installed package. Prisma 8 is outside this comparison.

## Prepare and replay

Use fresh absolute work/evidence directories under an owned cache directory.
The parent directory must already exist. Output and lock directories are never
overwritten. The archive is required together with an explicit SHA-256.

```sh
: "${CANDIDATE:?packed turbine-orm archive}"
: "${CANDIDATE_SHA256:?archive SHA-256}"
: "${CAMPAIGN:?fresh campaign parent directory}"
mkdir -p "$CAMPAIGN"

node scripts/measure-consumer-cost.mjs --compare \
  --tarball "$CANDIDATE" --sha256 "$CANDIDATE_SHA256" \
  --work-root "$CAMPAIGN/lock-work" --cache "$CAMPAIGN/cache" \
  --prepare-locks "$CAMPAIGN/locks" --allow-network

# Explicit payload-cache population, not an accepted timing run.
node scripts/measure-consumer-cost.mjs --compare \
  --tarball "$CANDIDATE" --sha256 "$CANDIDATE_SHA256" \
  --work-root "$CAMPAIGN/fill-work" --cache "$CAMPAIGN/cache" \
  --locks "$CAMPAIGN/locks" --out "$CAMPAIGN/fill" \
  --install-mode cache-fill --allow-network

# Offline cache install, strict ESM/CJS, import/init and oracle smoke.
node scripts/measure-consumer-cost.mjs --compare \
  --tarball "$CANDIDATE" --sha256 "$CANDIDATE_SHA256" \
  --work-root "$CAMPAIGN/offline-work" --cache "$CAMPAIGN/cache" \
  --locks "$CAMPAIGN/locks" --out "$CAMPAIGN/offline"

# Registry-cold npm payload installs have a new, empty cache per arm.
# Registry/CDN/OS/network caches are outside the measurement's control.
node scripts/measure-consumer-cost.mjs --compare \
  --tarball "$CANDIDATE" --sha256 "$CANDIDATE_SHA256" \
  --work-root "$CAMPAIGN/registry-work" --cache "$CAMPAIGN/unused-cache" \
  --locks "$CAMPAIGN/locks" --out "$CAMPAIGN/registry" \
  --install-mode registry-cold --allow-network --install-only

# Bounded large-scale compiler evidence, serial within this command.
node scripts/measure-consumer-cost.mjs --compare \
  --tarball "$CANDIDATE" --sha256 "$CANDIDATE_SHA256" \
  --work-root "$CAMPAIGN/scale-work" --cache "$CAMPAIGN/cache" \
  --locks "$CAMPAIGN/locks" --out "$CAMPAIGN/scale" \
  --sizes 100,500,1000 --formats esm --iterations 1 \
  --timeout-ms 180000 --compiler-heap-mb 4096

node --test tooling/consumer-cost/measure-consumer-cost.test.mjs \
  tooling/consumer-cost/comparison.test.mjs \
  tooling/consumer-cost/runtime-role-closure.test.mjs
```

`--arms turbine,drizzle-stable,drizzle-rc,prisma` selects arms. Both formats are
the default; `--formats esm` makes the omission of CJS scale work explicit.
Sizes are integers from 3 to 1000. Every spawn gets its own timeout; the heap
bound is V8 old space, not total RSS. Work directories are retained, including
failures. The caller owns their removal after archiving needed evidence. npm
scripts are disabled and npm configs are empty. No install step is run against
the repository or a sibling checkout. Generation is a separate explicit command.
`CONSUMER_COST_NPM` can select the npm executable; its CLI path/hash/version are
recorded and its JavaScript runs on the selected Node.

Lock identity schema v2 requires `ARM/runtime` and `ARM/tooling` manifests and
locks, explicit roles, all four file hashes per arm and the exact common
transitive name/version/integrity/resolved identity. Historical one-lock evidence
is refused, including an unchanged archive; it is never silently upgraded.

The runtime manifest has only pinned runtime roots. The tooling manifest adds
the pinned compiler, declarations and Prisma CLI for generation. Runtime
transitive overrides freeze unambiguous tooling-lock versions without adding
package roots; all runtime transitive identities must occur in the tooling lock.
Runtime locks refuse Prisma CLI, TypeScript, `@prisma/dev` and CLI-only `mysql2`.
No installed graph is pruned to obtain this closure.

The supplied archive must receive new locks when its bytes change. Never edit
lock metadata to accept another archive. Online lock preparation resolves
transitives; exact v3 locks and their hashes freeze the resulting closure.
`cache-fill` permits network access to an existing payload cache. An offline
cache install is not a registry-cold install. `--install-only` omits all compiler,
runtime and native checks explicitly, rather than reporting them as passed.

## Workload and distinct costs

All arms describe the same ring of tables, each with id, parentId, exact numeric
amount, label, integer rank, boolean active, timestamptz and nullable note. Each
table has a parent and children relationship. Every accessor participates in
three queries: an ordered two-row nested projection (parent, children, children's
parent), a selected id/amount projection and a scalar predicate using changing
runtime inputs. Type assertions cover scalars, selected exclusions, nullable
fields, dates, nested relations and invalid relations/predicate operands.

Turbine generates from metadata, Prisma generates from its real schema through
its pinned CLI, and Drizzle infers directly from authored TypeScript. Stable
relations and RC `defineRelations` use their respective real APIs. No equivalent
Drizzle codegen phase is invented. These are different authoring models:

| Evidence | Meaning |
| --- | --- |
| `authoring` | Authored schema bytes/hashes; deterministic fixture emission time, **not human authoring effort** |
| `generation` | Actual Turbine/Prisma codegen process cost; not applicable for Drizzle |
| `generated`, `generatedBytes` | Full generated file inventory, distinct from authored schema and compiler costs |
| `declarations` | Strict schema/client declaration graph without workload expressions |
| `workload` | Strict same graph plus every accessor's query/type workload |
| `consumerOnly` | Supplemental `skipLibCheck: true` diagnostics when strict compilation fails; **never a strict pass** |
| `negative` | Suppressions removed in a real second compile at the smallest requested size; every intended invalid line must diagnose |
| `emit` | `--noCheck` emits runtime JS independently; **never compiler correctness evidence** |
| `emittedRuntimePayload` | Actual emitted JS plus required Prisma generated runtime assets |
| `installation`, `productionInventory` | Full actual runtime-only physical installation, separate from tooling |
| `tools`, `tooling-payload.json` | Separate tooling physical installation and full inventory including compiler/Prisma CLI |
| `runtimeAfterTooling`, `runtimeUnchanged`, `runtimeAfterExecution` | Runtime dependency hashes unchanged after independent tooling installation and after execution |
| `runtimeIdentity` | Actual installed driver/ORM versions and manifest hashes in the runtime-only tree |
| `runtime` | Fresh-process import and unconnected client initialization, then cached same-process import and second initialization |
| `importGraph` | Separate V8-observed imported JS files, bytes/hashes; excludes native/JSON/unvisited dynamic edges |

Both `declarations` and `workload` use strict NodeNext, no incremental cache and
`skipLibCheck: false`. A failed declaration graph has no successful strict
compiler-cost result to rank. Supplemental success cannot change that exit.
Stable CJS may also expose private-type identity errors in the workload; a
negative compile with a failing positive baseline is explicitly unavailable as
a passing type contract. Minimal independent `.mts`/`.cts` driver-only and narrow
relation consumers are retained for Drizzle to isolate errors from the large
schema or root-barrel imports. Missing unrelated optional drivers stay visible;
they are neither silently installed nor charged as required runtime dependencies.

Turbine's int8 contract here is `number | string`, matching its default safe-number
parser and string fallback. Metadata-decoded nested IDs in this fixture retain
strings. Drizzle uses bigint mode and Prisma exposes bigint/Decimal. These public
type differences are asserted, not hidden with `any`, casts or lossy number modes.

Production inventory records Turbine's actual pg declaration and all installed
pg instances. Every physically installed package must occur in its role lock;
`dev`, `devOptional`, `optional` and `peer` provenance remains explicit. It never
reports a library-only install size. Emitted
client/runtime files are separate payloads, particularly Prisma generated JS and
WASM; they must be included when discussing a deployable consumer. Compilation
and generation execute under `ARM/tooling`. Exact emitted output, including real
Prisma generated assets, is copied and hash-verified into
`ARM/runtime/fixtures/SIZE-FORMAT`.
Missing entry/workload output or Prisma entry/WASM fails admission. All probes
and native queries execute there using runtime's own dependencies. Neither tree
uses a `node_modules` symlink bridge. External symlinks and V8-observed imported
file URLs outside the runtime tree fail closed. The runtime dependency payload
is rehashed after tooling installation and execution; the deployed output is
checked again after execution. No source or sibling dependency is substituted.
Runtime init
constructs real, unconnected clients/pools and excludes cleanup. It is not a
connection-handshake, query, server initialization or migration measurement.
Fresh process wall time includes startup; warm import is the same process's
module-cache hit, not a second warm process. OS caches are not flushed. Child
CPU/RSS observations cover the main child only, not descendant attribution.

## Optional native oracle

`--pg-url postgresql://USER@127.0.0.1:PORT/postgres` accepts only an explicit
loopback PostgreSQL URL without a password. Use an **owned disposable** service,
supervised and independently audited by the existing native lifecycle tools.
The consumer harness does not start or certify a service. Each native child
creates a fresh database, refuses a colliding name, closes its clients, verifies
no remaining database sessions, then drops only that created database.

The native fixture executes the first and last accessor in ESM/CJS at the
smallest requested scale. It uses two separately reported domains:

- `safe`: IDs 1..3 and amount `123.1234567891`, returned as the same decimal text under the tested mappings.
- `precision`: IDs starting at `9007199254740993` and amount
  `123456789.0123456789`, which require exact bigint/decimal preservation.

Every result is checked for all rows, fields, nested cardinalities, order,
null/date/boolean/integer values and actual public scalar types. Bigints become
text without loss for comparison. Prisma's actual generated Decimal API is used
for recognition and fixed-scale rendering; no number conversion is permitted.
Turbine's safe scalar/nested int8 type distinction is represented in its explicit
expected shape. There is no rounding tolerance. Changed dynamic parameters,
missing rows/fields/children, reordered rows and changed numeric values must fail
the independent oracle. Each domain's failure remains in `native-result.json`
and fails the command; success in `safe` cannot admit `precision` equivalence.

Exit 0 means requested applicable checks passed. Exit 1 includes strict compiler
failures, native domain failures, deadlines/resource exhaustion and invalid
inputs. Missing native input is explicitly unavailable within each case; an
import-only run cannot claim native success. Never treat skips, supplemental
checks or runtime emission as passing strict types. No timing from a contended
implementation host is an accepted performance or type-cost ranking. Final
quiet repetitions, scoring and replay against a later archive belong to the
caller after implementation freezes.
