# Frozen Turbine buffered comparator

This private builder produces the existing optional-comparator input from an actual `turbine-orm` npm archive. It uses the archive's public `introspect` and `generate` APIs against a newly seeded canonical PostgreSQL fixture, compiles a generated typed client with strict TypeScript, and bundles that client and the unchanged archive runtime into one ESM file. No repository runtime, sibling installation, generated source overlay, lifecycle script, or expected query result is used by the arm.

This is correctness preparation. Comparative timing belongs to the campaign owner. A development run against a historical archive does not validate a later final artifact.

## Inputs and identity

Supply the archive, its independently retained SHA256, exact source commit, and a retained JSON identity with `sourceCommit` (or `head`) and `artifact.sha256`. The builder verifies their agreement and any archive `gitHead`. The source commit must exist in the local Git object database. The retained identity is operator provenance, not a claim that the builder reproduced the archive from source. The builder never invents a source identity or rebuilds/patches library source.

The explicit `--label` is retained in `identity.json`. Use a historical label for historical artifacts. The output directory must be new, and critical output files become read-only. `identity.json` records the archive and source tree, each staged package file, actual introspected schema, all generated files, exact compiler/dependency inputs, builder sources, canonical fixtures, esbuild input graph, and module hash. The emitted `comparators.json` is directly consumable by the candidate producer. Keep the output at its recorded absolute location.

`verify.mjs` checks archive/source/schema/generated/staged/bundle hashes and the manifest's identities before reuse. The producer independently checks the archive and module hashes when admitting the arm. Hashes establish bytes against the retained identity; they do not authenticate an untrusted operator's identity document.

Archive extraction validates checksums and paths before writing. Links, devices, duplicate names, traversal, extended tar path overrides, oversized payloads and malformed archives are refused. Only the package manifest and built JS/declarations/JSON are staged. Package scripts are never executed.

## Runtime and query policy

`createArm({pool,runtime,driver})` requires the actual Node26.12.0 process and the caller's native pg8.22.0 pool. It locates that already loaded CJS driver's export in Node's module cache and checks the pool's constructor, client, package identity and open state. It never resolves another driver relative to the bundle. This intentionally refuses wrappers, subclasses and custom loaders without the native CJS cache entry.

The bundle binds that exact driver's export before lazily evaluating the library runtime. The lazy initializer remains inside the single ESM file because native library modules capture `pg.Result` and `pg.utils` at evaluation. `arm.pool === pool`; `close()` closes Turbine, is idempotent, rejects later arm calls and leaves the caller's pool open. No driver parser is registered globally for an external pool.

Configuration explicitly selects production diagnostics (`cacheCheck: 'off'`, `advice: false`), logging off, UTC timestamps, join relations, prepared statements on, and an unset default limit. The full comments queries have no limit. Native fixed-arity names and the runtime's bounded/variable-arity naming policy remain active; no named-statement parity with Prisma is claimed. `TURBINE_DISABLE_PREPARED=1` is refused because it conflicts with the recorded policy.

All workload methods issue public, generated, typed ORM queries. The adapter does no raw SQL. The producer's independent raw connection verifies every complete returned write row and every committed effect. The native controls also exercise writes at two distinct iteration values and preserve sentinel rows.

| Admitted rows | Implementation |
| --- | --- |
| Headlines 0/1/2/3/4/5/6/9/10 | Complete users, ordered posts/comments, per-parent five-post limit, unique lookups, counts, full comments drain, typed transaction dashboard, all 50 rotating keys |
| Large/list | Comments5K and complete50K, full wide1K projection, deterministic newest-first page3/deep offset |
| Relations/aggregate | To-one, native junction-to-tags relation, relation count/existence filter, grouped count and average with HAVING |
| Writes | createMany returning1K, primary-key update, unique-slug upsert update path, unique-slug delete |
| Dashboard appendices | Five independent Promise.all reads vs five sequential autocommit reads |

The transaction dashboard uses `$transaction` and five sequential typed reads on one checked-out client. Independent Promise.all reads are neither a pipeline nor a transaction snapshot. The original filtered deep offset is empty in this fixture; that row does not establish nonempty deep-page decoding. Grouped results retain the actual aggregate values for the producer's exact decimal/integer normalization. Bulk returning rows are sorted by generated ID; no fields are omitted or fabricated.

The manifest declares exactly25 admitted cells. Atomic increment and pipeline are outside this optional candidate admission, even when a different Turbine benchmark implements them. Strategy variants and cold-client lifecycle stay outside this slice.

`stream()` is a **BUFFERED full drain**: it awaits complete ordered `findMany()` results and then yields them. It is not native cursor streaming and has no first-row or memory claim. The original main native-stream comparisons remain separate.

For a future native Turbine cursor comparison, the producer would need an additional comparator route identity such as `native-turbine-cursor-full-drain`, a separately named catalog arm, route-specific validation of actual portal/Execute batching, and iterator-return/cancel/single-connection reuse controls. A manifest `streamRoute` field plus `streamBatchSize` and route-proof receipt could make that distinction explicit. No such producer/catalog/manifest change or native route is implemented here.

## Build and preflight

Use the exact candidate Node26.12 runtime. From `benchmarks/prisma8-candidate`:

```bash
mkdir -p "$HOME/.cache/p8arm-tmp"
export TMPDIR="$HOME/.cache/p8arm-tmp"
npm ci --ignore-scripts --no-audit --no-fund
npm run verify:pins
npm run build
(cd adapters/turbine && npm ci --ignore-scripts --no-audit --no-fund && npm test)

# Use NEW short paths for each run; retain prior attempts.
export PG_PREFIX=/absolute/postgresql-18.6/prefix
export ARM_PREP="$HOME/.cache/p8-final-prep-UNIQUE"
export ARM_OUT="$HOME/.cache/p8-final-bundle-UNIQUE"
export ARM_CHECK="$HOME/.cache/p8-final-check-UNIQUE"
export ARM_CONTROLS="$HOME/.cache/p8-final-controls-UNIQUE"
node scripts/run.mjs --mode plan --out "$ARM_PREP"
node scripts/run.mjs --mode plan --out "$ARM_CHECK"
node scripts/run.mjs --mode plan --out "$ARM_CONTROLS"
# Announce EACH planned service root and port to the campaign owner before launch.

# ARTIFACT, ARTIFACT_SHA256, SOURCE_COMMIT and SOURCE_IDENTITY must come
# from the actual retained artifact's independent identity.
node adapters/turbine/build.mjs \
  --artifact "$ARTIFACT" --artifact-sha256 "$ARTIFACT_SHA256" \
  --source "$SOURCE_COMMIT" --source-identity "$SOURCE_IDENTITY" \
  --label final-artifact-correctness \
  --service-plan "$ARM_PREP/service-plan.json" --out "$ARM_OUT"
node adapters/turbine/verify.mjs "$ARM_OUT"
node scripts/run.mjs --mode preflight \
  --service-plan "$ARM_CHECK/service-plan.json" \
  --comparators "$ARM_OUT/comparators.json" \
  --artifact "$ARM_OUT/turbine-orm.tgz" --artifact-sha256 "$ARTIFACT_SHA256" \
  --artifact-source "$SOURCE_COMMIT"
node scripts/validate-report.mjs "$ARM_CHECK/report.json"
node adapters/turbine/tests/turbine-arm-native.mjs \
  --bundle "$ARM_OUT" --service-plan "$ARM_CONTROLS/service-plan.json"
```

The builder starts and removes its own preparation cluster through the existing owned-process/service helpers, seeds the unchanged canonical fixture and introspects it using the supplied archive. Compilation and bundling happen after service cleanup. The producer and native controls each use another newly announced owned cluster. The scripts retain shutdown/reap, port and datadir/socket cleanup evidence on success and failure. They never connect to an existing application database or introduce another supervisor.

The eleven unit tests include unsafe/broken archives, source/hash mismatch, actual pg8.23.1 mislabeled as8.22, wrong runtime, fake/wrapped/closed pools and positive controls. The native control runner uses the producer's exact drain/effect guards to reject truncation and convincing returns without writes, checks bundle-hash admission, proves buffered wire execution and named statements, distinguishes dashboard routes, verifies real writes and checks caller-pool ownership. It has no timing mode.


The native control runner races its entire control body against the existing lifecycle signal and a 120-second deadline, using the producer's execution helper. Drains also receive the scope so they stop consuming after shutdown. Signal and deadline regression tests execute the actual runner with in-memory service/DB/arm seams and the real drain, cleanup and report owner. A stalled iterator must allow cleanup and failure-report persistence before it is released. These tests launch no database and add no timing evidence.
