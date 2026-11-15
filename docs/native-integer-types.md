# Exact native integer generation

`generate({ exactNativeIntegers: true, target: 'sqlite' | 'mysql' | 'mssql', ... })`
opts into types that match the native adapters' existing integer read policy.
Safe integers read as JavaScript numbers; integers outside
`[-9007199254740991, 9007199254740991]` read as decimal strings. Reads do not
return JavaScript `bigint`. This option changes declarations and optional Zod
validators, without changing runtime coercion, parsers, schema metadata or SQL.

```ts
import { generate } from 'turbine-orm';

generate({
  schema, // SchemaMetadata from the matching native introspector
  target: 'mysql',
  exactNativeIntegers: true,
  outDir: './generated',
  noTimestamp: true,
});
```

The programmatic generator and CLI/config accept the option. An explicit native
target is required. `true` with an omitted or `postgresql`
target throws `ValidationError` before `generate()` creates its output
directory. Nonboolean values are refused. Omitted and `false` preserve default
emitted bytes on all four targets, including PostgreSQL.

| Native declaration | Row value | Create/update value |
| --- | --- | --- |
| MySQL `BIGINT`, including unsigned, and code-first `int8`/`bigserial` | `number \| string` | `number \| string \| bigint` |
| SQL Server `BIGINT`, and code-first `int8`/`bigserial` | `number \| string` | `number \| string \| bigint` |
| SQLite integer affinity, any declared type containing `INT` | `number \| string` | `number \| string \| bigint` |

Nullable columns add `null`. Existing optional/default/key rules still apply.
Computed columns appear in row types and remain absent from create/update
inputs. Nested creates and update `set` values use write types. Selections,
relations, global filters and unique selectors retain the corresponding row
types. Filters and connect selectors accept numbers and decimal strings; their
existing row-based contract does not add `bigint` operands. Atomic arithmetic
operators keep their existing number operands.

Explicit `columnTypes` entries win over this option and code-first
`declaredTsType` declarations retain their existing precedence below
`columnTypes`. An override is the caller's compile-time assertion, without
stored-value validation. Optional Zod row schemas use a number/string union;
create/update schemas also accept `bigint`. The generator's existing treatment
of arbitrary TypeScript overrides in Zod is unchanged: custom validators are
still needed for those assertions. These unions do not validate decimal syntax,
safe-number input, or database range.

MySQL/SQL Server narrow integer columns, DECIMAL/NUMERIC, floating types,
booleans, enums and arrays are not widened by this option. PostgreSQL read/write
contracts and generated clients are unchanged. A large integer should be passed
as decimal text or `bigint`; an already rounded unsafe JavaScript number cannot
be repaired by a type declaration. Native database ranges still govern writes,
including MySQL unsigned BIGINT's different range.

## SQLite boundaries

SQLite's `INTEGER`, `INT2`, `TINYINT`, `BIGINT` and even an unusual declaration
such as `POINT` all have integer affinity. Declared width does not enforce a
narrow numeric range: integer storage can hold the full signed 64-bit range,
`-9223372036854775808` through `9223372036854775807`. Numeric affinity can also
store int64 values, but this option deliberately covers integer affinity only;
it does not fix the existing general DECIMAL/NUMERIC mapping.

Affinity also permits REAL, TEXT and BLOB storage in an ordinary table. The
number/string row union describes integer storage read through a compatible
adapter; it does not certify arbitrary mixed storage. Fractional REAL values can
read as numbers, arbitrary TEXT as strings, and a stored BLOB falls outside the
union. Use application validation, suitable CHECK constraints, or appropriate
STRICT tables when storage must be constrained. STRICT `INTEGER` still has the
full signed int64 range. This option does not inspect constraints or infer a
narrow range from the type name.

The native `node:sqlite` path calls `setReadBigInts(true)` and normalizes bigint
cells, including relation reads. Exact Node 22.16.0 and 24.10.0 are exercised by
the verifier. Older Node versions and third-party SQLite handles need compatible
binding, bigint-read and statement-metadata behavior; merely having an API named
`prepare()` is insufficient. The default `node:sqlite` integer read mode can
throw on an int64 outside the safe-number range. A custom driver which rounds
before Turbine sees a value cannot be made exact by this generator option.
Likewise, supplied MySQL pools must retain exact large integers, for example
with mysql2 `supportBigNumbers: true, bigNumberStrings: false`. No arbitrary
external driver configuration is certified here.

## Verification

Generation tests pin the preceding generator's output hashes for all four
emitters and all four targets. They cover nullability, computed columns, key
rules, explicit overrides, code-first types, affinity spelling and refusals.

The separate packed verifier installs a SHA256-pinned candidate archive into an
ordinary temporary application. It introspects real SQLite and newly owned
MySQL 8.4.0 databases, then compiles and runs strict ESM and CommonJS clients.
There is no manual BIGINT column override in those native clients. Values cover
both signs around 2^53 and both signed int64 bounds; MySQL also checks unsigned
BIGINT's upper bound. It checks direct and relation reads, exact stored casts,
create/update, nullable values, computed columns, selected fields and filters.
MySQL uses a borrowed, exact-integer-compatible pool so each of the two server
SQL modes actually reaches the application unchanged.

Each negative consumer must compile with its individual `@ts-expect-error` and
produce a diagnostic on that same line after the directive is removed.
Prerequisite controls fail before installation or service startup. A deliberately
rounded oracle must fail. SQL Server has deterministic metadata and packed
declaration checks only; native SQL Server verification remains pending.
A 128-table generated relation graph compiles real accessor calls with compiler
diagnostics retained, without changing any size or type-cost budget.

```bash
node --import tsx --test src/test/generate-native-integers.test.ts
node --test tooling/native-integer-types/harness.test.mjs

MYSQL_BASEDIR=/absolute/path/to/mysql-8.4.0 \
MYSQL_LIBRARY_PATH=/absolute/path/to/mysql-libraries \
node tooling/native-integer-types/verify.mjs \
  --engine all --tarball /absolute/path/to/candidate.tgz \
  --sha256 YOUR_CANDIDATE_SHA256 --exact-node 24.10.0 \
  --out /tmp/native-integers-new-evidence
```

Use an output directory that does not exist. Missing required services fail,
without skips or borrowing an external database URL. The verifier records
commands, exact runtime/dependency/service versions, archive and installed-byte
hashes, generated sources, native observations, compiler refusals and cleanup.
It independently checks that owned service PIDs, ports, sockets, datadirs and
the temporary application are gone. It preserves failed attempts in their own
evidence directories. This is targeted integer evidence, not general engine
certification or a performance benchmark.

## CLI generation

Set `exactNativeIntegers: true` in the project configuration for native
SQLite/MySQL/SQL Server `pull` and `generate`, or pass
`--exact-native-integers` to the generation command. Defaults remain unchanged.
The generator refuses this option for PostgreSQL.
