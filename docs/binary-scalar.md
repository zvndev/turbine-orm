# Binary scalar names in generated clients

An earlier generator let an entity named `Uint8Array` shadow the inferred scalar type of a SQLite `BLOB` column. A native byte array then failed strict TypeScript assignment while a plain entity object could incorrectly compile. The three historical correction candidates below were rejected because each exceeded the then-current main-entry size budget. A later correction uses explicit [binary provenance](binary-scalar-provenance.md).

For example, that generator emitted public entity `Uint8Array` and an unqualified `Asset.data: Uint8Array` when introspecting `uint8_arrays(id, title)` alongside `assets(id, data BLOB)`. SQLite returns the bytes as the JavaScript intrinsic. Public entity names and caller declarations must keep their meanings.

A proposed correction qualifies generator-owned references as `globalThis.Uint8Array` for the exact native BLOB mapping and `globalThis.Buffer` for PostgreSQL's canonical bytea mapping. Explicit `columnTypes`, `declaredTsType`, enum resolution and custom type expressions keep precedence. The code-first bytea bridge establishes the Buffer type surface; it does not establish native PostgreSQL verification. Other engine-specific binary type names need their own provenance and validation.

| Candidate | Main entry bytes | Fixed limit | Targeted source tests |
| --- | ---: | ---: | --- |
| Direct provenance guard | 150076 | 150000 | 5 passed |
| Canonical nullable comparison | 150029 | 150000 | 5 passed |
| Shared comparison | 150091 | 150000 | 5 passed |

Each candidate built successfully and passed the other 24 unchanged size gates. These results do not admit a production fix. Broader installed/native qualification was intentionally deferred after the bounded size attempts failed.

The [unapplied candidate patch](../src/test/fixtures/binary-candidate.patch) and [candidate regression fixture](../src/test/fixtures/binary-scalar.test.ts.txt) retain the proposed implementation and useful source controls. The fixture is evidence for an unadmitted candidate, not a passing regression suite for current production source. The installed baseline failure was separately reproduced against native builtin SQLite on Node 22.16.0 with strict TypeScript and `skipLibCheck: false`.

The historical candidates above were not adopted. Current binary scalar inference is described in [Binary scalar provenance](binary-scalar-provenance.md). No runtime binding, metadata, Date/Record correction, public name, dependency, export or size budget changed. No performance or broader engine support claim follows from these results.
