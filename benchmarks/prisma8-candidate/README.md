# Prisma 8 PostgreSQL candidate appendix

This is an isolated benchmark preparation for Prisma CLI **8.0.0-rc.33** and
`@prisma/orm-postgres` **8.0.0-rc.23**, including CLI toolchain **rc.23**.
It is a separate candidate appendix to the original PostgreSQL program.
The stable Prisma **7.10.1**, Drizzle **0.45.4** and Drizzle RC **1.0.0-rc.5**
baseline programs keep their existing identities and commands.

No performance result is supplied here. Refused and unmeasured cells have
`metrics: null`. There are no zero-time unsupported results, p99 estimates,
or global rankings. MySQL, SQLite and MongoDB are unsupported in this subproject.

## Locked installation and identities

Use the exact **Linux x64 Node 26.12.0** executable whose SHA256 is
`caa24debe02770c92a70677e2a62ca98890150e7ac1c17bcfe31bcc98cc89943`.
CLI's range is `^22.18.0 || ^24.11.0 || >=26.0.0`; the historical Node 24.10
baseline cannot run this CLI. This particular preparation intentionally verifies
the frozen executable as well as its version. Every run records its resolved
executable path, full runtime versions and hash.

Run from this directory, using npm **11.20.0**:

```bash
npm ci --cache .npm-cache --ignore-scripts --no-audit --no-fund
npm run verify:pins
npm run generate:check
npm run typecheck
npm run build
npm test
npm run catalog
```

The lockfile, package integrity strings, installed candidate/toolchain/driver
payload hashes, source tags, runtime and immutable fixture/helper hashes are in
`identity.json`. `verify:pins` also checks the canonical copies against `git show`
at the recorded source commit. Keep that commit's objects when exporting this
subproject. No mutable dependency installation from another benchmark or the
repository root is reused or symlinked. Lifecycle install scripts are unnecessary
for this producer on the pinned platform.

`pg` is deliberately **8.22.0**, the candidate facade's actual dependency. The
raw controls use that same installed driver, including the same `pg-cursor`
**2.22.1** for native cursor controls. The old benchmark's **8.23.1** driver is a
separate identity. This appendix does not override or alias it. Optional matched
comparators must accept the supplied 8.22.0 pool; preserve a run using 8.23.1 as
a different-driver baseline. No prepared-statement policy parity is claimed.

## Contract and canonical data

`fixture/contract.prisma` is a Prisma 8 contract for the original benchmark's
eight tables. It uses the required `// use prisma-8` header and DateTime precision
6 for the existing timestamptz columns. Its generated `contract.json` and
`contract.d.ts` are committed. The contract's ordinary descending index is
represented as an ascending index because this fixture does no migration work;
query ordering remains explicit. No schema equivalence or migration claim is made.

`npm run generate` uses the actual pinned CLI's **`contract emit`**, not the
Prisma 7 generator. `generate:check` emits to a disposable directory inside
this project and requires byte-identical output. The rc.23 emitter determines
public facade import roots from the output's project ancestry; putting that
directory outside the project emits internal import specifiers. The producer
does not patch generated types to hide that behavior.

Strict compilation has `skipLibCheck: false`. Public `postgres`,
`contractFromJson`, ORM collections, aggregates, transactions and SQL builder
plans are used. Negative type controls prove scalar projection, model/relation
names, unique criteria, bigint identity and atomic-update refusal.

`canonical/` holds byte-identical copies of the existing seed, headline oracle,
extended oracle and their type-only harness dependency. The manifest records
source commit and SHA256 for each. The timing code does not invoke the old
benchmark harness. The canonical seed creates 5 organizations, 1,000 users,
10,000 posts, 50,000 comments, 50 tags, 30,000 junction rows and 2,000 wide rows.
Its ordinary timestamp defaults use the service clock; each run records the
actual fixture digest. All arms in one run share exactly that fixture.

## Exact supported scenarios

`support.json` and `npm run catalog` enumerate every arm/scenario cell.

| Original headline | Prisma 8 route |
| --- | --- |
| Flat 100 users | Typed ORM, full ordered projection |
| 50 users plus posts | Typed include, ordered parents and children |
| 10 users, 5 posts each, comments | Typed nested include with per-parent limit |
| Unique user | Typed unique criterion |
| Unique user plus posts and comments | Typed nested include |
| All-user count | Typed aggregate countBigInt |
| Ordered 50K comments drain | Default buffered route and separate native cursor, batch 1000 |
| Atomic view-count increment | Refused for typed ORM; raw control remains explicit |
| Five-query pipeline | Refused; no raw fallback or Promise.all pipeline credit |
| Five-query transaction | Sequential typed reads inside callback transaction |
| Rotating unique IDs | Entire 50-ID cycle checked |

Two separately named dashboards run the same five reads as **independent
Promise.all reads** and as **sequential autocommit reads**. Independent reads
use a pool of 3 connections; they promise no shared snapshot. The transaction
route proves BEGIN/COMMIT and executes reads sequentially. These routes are
never folded into a pipeline result.

Fourteen extended cases are implemented for both raw and Prisma 8: 5K comments,
50K comments, 1K wide rows, page 3, deep offset, 500 posts plus author, 200 posts
plus tags through their explicit junction, relation counts, relation existence
filter, grouped count/average with HAVING, bulk insert 1K, PK update, unique
upsert update path and unique delete. The junction projection is checked before
flattening, and grouped averages use the canonical exact-decimal oracle.

The two strategy-selection cases and fresh-client cold query are refused in
this slice. Supporting the same row shape through one ordinary include does
not establish equivalent join/batched/auto/flatten strategy choices.

## Native correctness and service ownership

Only a **new private PostgreSQL 18.6 cluster** is allowed. Supply an existing
unprivileged PostgreSQL binary/catalog prefix containing `bin/initdb`,
`bin/postgres` and `share/postgresql/postgres.bki`. No sudo, permission changes,
existing endpoint, or existing datadir is used. Give `--out` a short new path
on storage with adequate quota. The Unix socket path must fit PostgreSQL's
108-byte limit. A plan creates no service and prints the reserved service root
and selected loopback port for coordination; the port is re-admitted by startup.

```bash
mkdir -p results/tmp
export TMPDIR="$PWD/results/tmp"
export PG_PREFIX=/absolute/postgresql/prefix
npm run plan-service -- --out "$HOME/.cache/p8-correctness-unique"
# Coordinate the printed service root and loopback port before starting.
npm run preflight -- --service-plan "$HOME/.cache/p8-correctness-unique/service-plan.json"
node scripts/validate-report.mjs "$HOME/.cache/p8-correctness-unique/report.json"
```

The existing process ownership and command helpers supervise/reap only the
owned processes. `fixture/postgres-service.mjs` is a service-specific adaptation
of the existing helper to accept the announced port. Success and failure both
await shutdown, audit remaining PIDs/groups, rebind the port, and remove the
owned datadir/socket. Cleanup is registered before socket creation or initdb; partial startup is recorded and removed too. The service admits 32 connections for all four optional three-connection comparator pools plus the built-in and control pools. Logs, plans and reports remain. Use a **new** output
directory for each attempt. A missing prerequisite or failed native check
fails the run; it cannot become a skipped success.

The independent raw oracle reads the full fixture and observes actual write
effects. Ordered results preserve missing keys, nulls, dates and all declared
integer bits. One original full fixture remains the oracle throughout preflight, controls and timing; each phase must preserve every read-table value. Each supported operation is preflighted before timing is eligible.
The 50K stream verifies the first row, every value in order, the exact count and
an order-sensitive digest. Full-drain timing consumes every row on each route.

Native cursor proof observes actual pg Bind/Execute protocol calls for a named
portal and Execute row limit 1000. Default buffering is checked separately.
Controls cover explicit iterator return, `break`, pre-abort, cancellation after
the first row, connection reuse with a **single-connection pool**, invalid batch
size, caller-owned pool survival, closed-client refusal, rollback and committed
visibility through the independent connection.

The real cursor opt-in is `postgres({ contract, pg: pool, cursor: { batchSize:
1000 } })`. Without `cursor`, `for await` still buffers the query. An active
cursor pins its connection until drain or return. Querying the same `pg.Client`
or transaction from inside that cursor loop waits for the occupied connection.
No nested-query experiment is faked here; no nested query runs in those loops.

Faults `omit`, `corrupt`, `route`, `effect`, and `rollback` can be selected with
`--fault NAME` on a new preflight attempt. They must exit nonzero with a specific
result, route, effect or transaction error. Unit controls also prove truncated
drains, wrong ordering, missing keys, unsafe integers and plausible returning
values without matching effects are rejected. Fault runs are never timing runs.

## Optional comparator inputs and later timing

The optional names are **Turbine**, **Drizzle stable**, **Drizzle RC**, and
**Prisma 7**. No optional comparator has been installed or executed by default.
`comparators.example.json` describes the explicit inputs. Each entry supplies
the exact source commit, artifact file/hash, immutable self-contained adapter
bundle file/hash, version, matched driver and supported scenario IDs. Bundle
its ORM dependency from that pinned artifact; do not import a mutable sibling
installation. Transitive bundle inputs must be included in the bundle hash.

The bundle exports `createArm({pool, runtime, driver})` and returns the same
`pool`, `close()`, `runHeadline(index, i)`, `runExtended(id, i)`,
`dashboard('independent'|'sequential'|'transaction')`, and `stream()` (an async
iterable). Results use the same complete canonical shapes, including declared
count normalization, junction flattening and group projections. No result
projection may discard incorrect fields. Declare only IDs actually implemented;
all other cells are explicit refusals. Supplied methods run through the same
exact/effect preflight. A comparator bundle is executable reviewed input, not a
security sandbox; its hash identifies all code the benchmark accepts.

Timing requires an actual Turbine input whose source and artifact SHA256 match
the supplied pinned artifact. Planning and preflight remain usable without it.
The timing command is for a later coordinated run:

```bash
npm run plan-service -- --out "$HOME/.cache/p8-timing-unique"
# Coordinate the printed private service and enter the final quiet window.
npm run run -- --mode timing \
  --service-plan "$HOME/.cache/p8-timing-unique/service-plan.json" \
  --artifact /absolute/frozen-turbine.tgz \
  --artifact-sha256 EXACT_ARCHIVE_SHA256 \
  --artifact-source EXACT_40_CHARACTER_SOURCE_COMMIT \
  --comparators /absolute/comparator-inputs.json --rounds 30 --warmup 5
```

Reports include source/build/lock/runtime/service identities, fixture digest,
support and refusals, preflight results, native route proofs, effects and
cleanup. Timing rotates arm order each round, keeps raw samples, and reports
sample count, median, mean, minimum and nearest-rank p95 in milliseconds.
Write setup and counter resets are outside the timed call. Every non-stream return is eagerly copied with structuredClone inside its measured interval, equally for all arms, so deferred getters cannot move materialization into verification. This extra common boundary is specific to this appendix and differs from historical baseline timings. Every warmup and
measured result, ordered stream digest and independent write effect is checked
after its call, outside the measured interval. Complete execution receipts and
rounds are recorded. p99, first-row latency, peak memory and global ranking remain
unavailable. One process/run is not cross-run statistical evidence; retain
multiple independent coordinated repetitions and all losses before drawing
comparative conclusions.

Wire observers are removed before timing warmup. `validate-report.mjs` rejects
missing supported cells, missing native controls, failed ownership cleanup,
incomplete timing cells/samples/receipts, statistics inconsistent with samples,
and reports carrying invented unmeasured metrics. Expected catalog rows, arm maps and statuses are derived from pinned source plus validated comparator inputs; orphan cases cannot redefine the catalog. Runtime binary, source/build digests, seed/initdb command ownership and ordered native stream receipts are required. Validation must run against the matching pinned producer and retained comparator files.

Callback/drain waits race the existing lifecycle cancellation signal and a 30-second deadline. The complete preflight and timing phases also have 120-second deadlines. A held arm cannot prevent teardown after SIGINT/SIGTERM; pending rejections remain observed while the existing owner closes clients/pools and reaps its service. These bounds do not claim to interrupt synchronous JavaScript or close a caller-owned external service.

## Official API anchors

- [ORM rc.23 tagged release](https://github.com/prisma/orm/releases/tag/v8.0.0-rc.23)
- [CLI rc.33 tagged release](https://github.com/prisma/prisma-cli/releases/tag/v8.0.0-rc.33)
- [ORM client reference](https://www.prisma.io/docs/orm/reference/orm-client)
- [Transactions and runtime reference](https://www.prisma.io/docs/orm/reference/transactions-and-runtime)

The tags and emitted public declarations fix this preparation's contracts;
rolling documentation may later describe different APIs.
