# SQLite relation values and fanout evidence

This executable workload measures existing public SQLite relation routes. It
changes no ORM implementation. Reports are diagnostic shared-host samples, with
no ranking or performance threshold. The smoke default is 48 verified samples:
four deterministic fixture shapes, two windows and six routes, once each.

```sh
npm ci
npm run gen:studio
# NODE must point to exactly Node 22.16.0 or 24.10.0 for native evidence.
"$NODE" benchmarks/sqlite-relations/run.mjs --out /tmp/sqlite-relations.json
"$NODE" benchmarks/sqlite-relations/controls.mjs --out /tmp/sqlite-relations-controls.json
# Dependency-light validator tests and executable omissions also run on Node20/26.
node --test benchmarks/sqlite-relations/harness.test.mjs
node benchmarks/sqlite-relations/omissions.mjs
```

For a larger, opt-in campaign use `--rounds 4 --scale 4 --delay 1`. Rounds are
bounded at 20, scale at 16 and consumer delay at 20 milliseconds. The default
child process/group deadline is 30 seconds (`--deadline`, bounded at 120000 ms).
An existing output path is refused before starting a child, preserving its bytes.
Use a new path for every attempt. The default runtime must not be mistaken for a
native prerequisite pass: unsupported versions create failed evidence and exit 1.

`raw` reads projected parent and related rows using the same native DatabaseSync
as the ORM routes. It is an explicit per-parent reference, not an optimized SQL
competitor. `join`, `batched` and `flatten` execute `findMany`; `stream-join` and
`stream-flatten` execute `findManyStreamBatches` with batch size two. A supplied
AbortSignal bypasses speculative materialized reads on the streaming arms. The
native audit must prove `iterate`, never `all`, for their relation SELECT.
Flatten must actually join the optional to-one owner; the to-many children
remain correlated JSON subqueries. There is no claim of a flattened to-many
strategy. Forced positional relation encoding on SQLite must refuse with E017
before any SELECT. Refusals have no successful timing sample.

All arms use the same public `$transaction`, one connection, a pinned read
snapshot, fixed foreign-key/journal/synchronous/busy settings, integer binding
and native bigint read policy. BEGIN, fixture setup, metadata introspection,
snapshot pin, EXPLAIN and COMMIT stay outside timing. Timings include native
instrumentation, decoding, retention of exact values and optional matched
consumer delays. Delay is once per two delivered parents, including the final
partial group. Rounds alternate route order. This is not disk-cold evidence.
There is no concurrent writer; host load, CPU times and memory are captured to
record noise, without asserting that the host is otherwise idle.

The value oracle independently filters/sorts/slices fixture arrays, with parent
ordering `(rank ASC, id ASC)` and child ordering `(rank ASC, id DESC)`. The all
window reads ten parents and all children; the page reads seven parents after
offset one and three children after offset one. Fixtures contain tied ranks,
empty to-many, optional to-one and nullable values, Unicode, wide payloads and
skewed fanout. Scale increases generated parents, fanout and wide payload size;
parent query windows remain fixed. Post-campaign native table reads also prove
that all exact fixture values survived unchanged. Input, oracle, harness,
production source, root lock and actual binary/driver identities are hashed.

The native statement audit records SQL, bindings, delivered row counts,
serialized bytes and real EXPLAIN QUERY PLAN rows. Bytes mean UTF-8 JSON
serialization of returned values, not a network protocol, SQLite pages or VM
steps. Only exactly safe fixture integers are normalized from bigint. Native
bytes include extra correlation/rank fields delivered by the batched route and
JSON escaping in joined routes. Final delivered bytes cover identical projected
nested values. Each streaming batch bounds parents only: one parent's children
and JSON payload can be much larger. Process memory snapshots and process
high-water RSS include the harness and retained exact results. They establish
no global memory bound; no native allocator/VM-step count is inferred.

The parent owns one detached worker group and one unique disposable directory,
without a network service, socket or port. It enforces deadlines, escalates
TERM to KILL, preserves failure/OS-signal state, retains primary and directory-removal errors in the final report, and independently checks PID,
group and path removal. Native close proof tests the closed handle; an omitted
close is a sticky failure even when recovery closes it afterward. Forced
termination cannot claim native close proof. Controls run copies of source and
harness in a disposable snapshot, after a complete native prerequisite run.
They inject missing rows, wrong tie ordering, materialization, lost close,
timeout, child SIGTERM and parent SIGINT/SIGTERM. Omission tests remove individual
assertions in disposable harness copies and require the intended unit assertion
to fail after the unchanged prerequisite suite passes.

Packed evidence uses the exact same workload:

```sh
npm run build
npm pack --ignore-scripts --pack-destination /tmp
# Install/extract that archive in a disposable consumer with the root-lock pg.
"$NODE" benchmarks/sqlite-relations/run.mjs --module /tmp/consumer/package/dist/sqlite.js \
  --archive /tmp/turbine-orm-0.93.1.tgz --out /tmp/sqlite-relations-packed.json
```

Every distribution payload is checked against the archive before execution.
The report distinguishes source from packed ESM, and captures both source input
hashes and the exact artifact hash. Source, packed and later integrated evidence
are separate scopes. Native MSSQL, other engines, optimizer changes, automatic
strategy selection and later unmerged SQLite decoder changes are outside this
workload. No shared gate is modified.
