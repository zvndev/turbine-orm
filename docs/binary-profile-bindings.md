# Optional package bindings for native binary types

This records a historical tooling snapshot. Its artifact hashes and file counts
refer to that snapshot, not the 0.94.0 release artifact.

The six optional package builds bind the current normal package using complete ordered source, emitted-file and archive inventories. Public imports, default PostgreSQL dependency, exports, runtime graph selection and algorithms remain unchanged. Refreshing these tooling bindings leaves the normal package byte-identical.

MySQL and better-sqlite3 bind 199 ordered library/build inputs and all 757 normal emissions. Their existing peer-helper and literal-caller pins remain unchanged. The PostgreSQL compatibility profile retains all 761 normal payload members and 757 dist members. Counts supplement complete member and byte checks.

| Profile | Payload members | Dist members |
| --- | ---: | ---: |
| Full optional | 765 | 761 |
| D1 runtime | 218 | 215 |
| Builtin SQLite runtime | 238 | 235 |
| MySQL runtime | 232 | 229 |
| better-sqlite3 runtime | 240 | 237 |
| PostgreSQL compatibility | 761 | 757 |

The original builders and standalone verifiers remain the authorities for each profile. The additional qualification helper runs those six paths, the original standalone contracts under Node 22.16.0 and 24.10.0, normal type/lint/size checks and normal packing. The separate inventory helper reconstructs every member and byte independently, including runtime subset closure. Neither descriptor chooses the accepted subset.

Native binary qualification uses PostgreSQL and builtin SQLite only. It checks native producer hints, PostgreSQL builtin/domain/view/materialized-view distinctions, caller-owned declarations and overrides, serialization/copy routes, frozen nonenumerable descriptors, native byte values and plain same-named model negatives. Generated unique selectors retain native binary meaning on direct, copied and preserved-column-name routes. Scalar unique reads and writes, compound selectors, rollback, full bytes/nulls/arrays and borrowed-handle or pool survival remain separate runtime checks.

Whole-array equality on a unique PostgreSQL array column now identifies one row at runtime. Generated array types alone do not prove that the database enforces a matching unique key. Other engines gain no native array support from binary type inference.

D1/Worker generation, Record and Date collisions, declared temporal types, canonical/producer behavior, seed/core aliases, MySQL recovery/streaming and the 66-label ENUM fixture remain required product checks. Main 152000 and edge 117000 byte limits stay fixed. SQLite and MySQL each allow 134000 bytes under the documented 5% engine-headroom convention after early read-only validation measured 127101 and 127091 bytes; the other 23 limit definitions remain unchanged.

Stock fixture cleanup remains unchanged. Only available state after actual closure can support a closed-state archive claim. Missing deleted fixtures, unavailable hosted prerequisites, legacy-driver limits and incomplete process or stream observations require explicit qualification. Package distribution checks do not constitute a full regression coverage, whole-engine compatibility, performance guarantees or release readiness.
