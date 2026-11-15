# Local libSQL project commands

The local libSQL CLI helpers support `init`, `pull`, `generate` (aliases `gen`, `g`), and catalog `status` (alias `info`). They use the optional native `@libsql/client/node` driver and the existing `turbine-orm/libsql/introspect` and `turbine-orm/libsql/generate` contracts. Install `@libsql/client` and `tsx` in the consuming project. No new mandatory dependency is added; `pg` remains mandatory for Turbine.

These commands, `engine: 'libsql'` configuration, and actual CLI dispatch were added in 0.94.0; earlier versions do not include this workflow.

```sh
npm install turbine-orm @libsql/client tsx
npx turbine init --engine libsql --url file:./turbine/dev.sqlite --yes
npx tsx libsql-example.ts
npx turbine status
npx turbine pull --allow-empty --no-timestamp
```

`init` creates an empty persistent native database, a typed `turbine.config.ts`, a runnable `libsql-example.ts`, and generated client files. It adds `.env` and SQLite sidecar patterns to `.gitignore` without replacing existing content. It creates no `.env`, credentials, schema file, migration or seed. Existing config, examples, database contents and generated files are preserved, including with `--force`. `--skip-generate` omits generation. A preexisting schema can be introspected during init. An empty new database is valid for init; later generation requires `--allow-empty` when no tables match.

When generation is planned, init validates the catalog options and renders all generated files before creating a persistent database or scaffolding. A new database uses an empty native in-memory catalog for this validation. Invalid column type overrides leave the project unchanged, including preexisting config, examples, ignore rules, output directories and databases.

```ts
import type { TurbineCliConfig } from 'turbine-orm/cli';

export default {
  engine: 'libsql',
  url: 'file:./turbine/dev.sqlite',
  out: './generated/turbine',
  include: ['users', 'profiles'],
  exclude: [],
  legacyToManyUniques: false,
  relationNames: { users: { profile: 'ownProfile' } },
  columnTypes: { 'users.settings': '{ theme: string }' },
  keepColumnNames: false,
  importExtension: 'js',
} satisfies TurbineCliConfig;
```

URL precedence remains CLI `--url`, `DATABASE_URL`, then config. Use a `file:` URL pointing to a real local file. Plain filenames, network file hosts, remote libSQL/HTTP URLs, URL query parameters/fragments and malformed escapes are refused. The runtime's `:memory:` URL remains supported by its existing API; project commands refuse it and `file::memory:` because independent CLI processes need persistence. `pull`, `generate` and `status` refuse missing database files instead of creating them. There is no `node:sqlite` fallback.

`pull` and `generate` emit the existing libSQL factory, metadata and exact native declarations. They forward include/exclude filters, relation renames, `legacyToManyUniques`, raw column names, column type overrides, sibling import modes and `--no-timestamp`. Type overrides for filtered tables are validated against the full catalog, then omitted from filtered output. Files are rendered before output writes, so invalid type overrides do not replace prior generated files. Large integer declarations retain the existing native input/read unions; blob reads use `Uint8Array` and decimals retain the existing libSQL declaration contract. The libSQL generator always uses its established exact integer mode, regardless of the SQLite-specific `exactNativeIntegers` setting. `--exact-native-integers` and `--zod` are refused here; the existing libSQL generator has no Zod output contract.

Before opening a native database, generation and init reject generated destinations that collide with the database by normalized filesystem path or device/inode identity. This includes escaped local URLs, database directory aliases and real hardlinks. Output symlinks, symlinked output ancestors and hardlinks between generated files are refused as well. Refusal preserves existing database and output bytes. Database filenames have no extension restriction: a database ending in `.ts` remains valid when its path and inode are separate from generated output.

`status` lists the filtered main base tables and their column/relation counts. It reports **catalog observations only**, explicitly stating that migration history/status is unavailable. It does not manufacture pending/applied migrations or create a tracking table.

Remote/auth/sync/replica/Turso rewrite configuration is refused. Views, non-main schemas, PostgreSQL adapters, schema lifecycle files, migration create/up/down/recovery, push/diff/schema/doctor/MCP/tool commands and their aliases are refused before database or project effects. [Typed seed callbacks](libsql-seeding.md) and [read-only `migrate status`/`list`](libsql-migration-inspection.md) have separate integrated command paths. Native SQL Server and hosted providers are outside this verification scope.

## Seed integration contract

`resolveLibsqlProjectContext(config, args?)` is a synchronous, effect-free helper exported from the internal `src/cli/libsql-project.ts`. It returns `{ url, databasePath, introspectOptions }`: an absolute local file URL, its native filesystem path, and the unchanged main-catalog filter/rename/column-name/cardinality options. It validates the engine, persistent local target, schema and unsupported transport/lifecycle settings. It does not open, create or check existence of the database. The seed lane can use this context without importing or modifying its source here. `introspectLibsqlProject` additionally requires an existing regular database file and closes its owned native client through the existing introspector.

## Verification scope

The owned tests use the real native `@libsql/client` prerequisite and fail if it is absent. They cover persistence, repeat-init preservation, native catalog and generated bytes, bigint/blob relation reads, filters/renames/type overrides, import options, all three database/output collisions, real hardlinks, output links and invalid-init preservation. The [installed workflow gate](libsql-project-workflow.md) exercises the actual package ESM/CJS commands, including config-free malformed engine operands. Each refusal must preserve the project tree. Source and installed-package evidence remain separately identified.
