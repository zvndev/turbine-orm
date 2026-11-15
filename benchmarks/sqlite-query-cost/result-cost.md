# SQLite ordinary result construction supplement

`result-cost.mjs` extends the [query-cost workload](README.md) with 32-row wide
and untyped reads, multirow `RETURNING`, unique SQL-text reads/writes, and native
table replacement between executions. It uses the same atomic report,
failure/signal handling and observed native-handle cleanup. Native prepare and
post-step column descriptions remain part of every nonempty ordinary query.

The multirow builder enumerates the native projection's keys and looks up each
decoder once per result, then applies the existing coercions to every cell.
The two temporary arrays live only for that result. Empty and single-row
results retain their existing builder. No statement, binding, row or additional
decoder record is cached between queries.

```sh
node benchmarks/sqlite-query-cost/bundle.mjs --source /tmp/base-sqlite.ts --out /tmp/base.mjs
node benchmarks/sqlite-query-cost/bundle.mjs --out /tmp/candidate.mjs
/path/to/node --expose-gc benchmarks/sqlite-query-cost/result-cost.mjs \
  --base /tmp/base.mjs --candidate /tmp/candidate.mjs --out /tmp/result-cost.json \
  --rounds 12 --iterations 1000
```

Use the exact Node 22.16.0 or 24.10.0 runtime, as required by the main workload.
The base must be a correct committed source, including fresh decoder metadata
and native single-statement admission. Both bundle manifests must identify the
same shared inputs, lock and esbuild version. Bundles are measurement artifacts,
not packed-package certification.

Three arms (base, candidate, identical-base control) complete all positions in
both directions every six rounds. Every result and affected count is checked
against JavaScript expectations after timing. Independent native counters
verify write effects. Warmups use separate unique SQL comments and are excluded
from reported totals. Each arm owns its own in-memory handle and pool.

“Cold” means unique SQL text that cannot hit the SQL admission memo, not a new
process or cold OS cache. Native statements are freshly prepared on all cases.
The native-DDL case times the native replacement as well as the ordinary query;
it is correctness evidence with DDL cost included. The narrow and wide reads
have fixed result sizes. Timings include promises, row construction and output
retention. Keep paired deltas and identical-control noise; marginal medians do
not establish a ranking. This supplement makes no broad speed, memory, engine
parity or production-load claim.
