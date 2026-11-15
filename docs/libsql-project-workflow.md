# Installed local libSQL project and seed workflow

The combined CLI route supports persistent local native libSQL files. Install the optional `@libsql/client` peer and project-local `tsx` for TypeScript config or seed files. `pg` remains mandatory. No hosted provider, remote/sync URL, Turso rewrite or `node:sqlite` fallback is part of this workflow.

```sh
turbine init --engine libsql --url file:./app.sqlite --yes
# Create your native database schema with your own local schema tooling.
turbine generate --no-timestamp
turbine seed
turbine pull --no-timestamp
turbine status
```

Init creates an empty database and generated client. It does not create a schema or seed. After creating native tables, generate produces the typed client. Configure `seedFile` or use the existing default discovery (`seed` remains the legacy config alias). Export a trusted callback:

```ts
import { defineLibsqlSeed } from 'turbine-orm/libsql/seed';

export default defineLibsqlSeed(async (tx) => {
  await tx.table<{ id: number; label: string }>('items').create({
    data: { id: 1, label: 'local' },
  });
});
```

The shared route normalizes the persistent file URL, validates raw config and argv, and resolves the real main catalog through `resolveLibsqlProjectContext` and `introspectLibsqlProject` before importing seed code. Relative and absolute URL spellings use the same normalized target. Unsupported seed options, missing databases, lifecycle config, non-main schemas, and remote/sync config fail before seed import. Config files themselves are trusted executable modules.

Await every query. Callback failure rolls back the database transaction, and a separately reopened native connection observes the result. Imports, other connections and filesystem/network effects do not roll back. See [seed lifecycle details](libsql-seeding.md).

Status reports filtered main base tables. `migrate status` separately inspects existing migration history and files without executing SQL; additive-only `migrate deploy` is available through its [separate contract](libsql-native-deploy.md). Other migration writes, push, schema, doctor, MCP and tools remain refused. Existing PG/SQLite/MySQL/MSSQL routes and generation behavior keep their current contracts. Native SQL Server and hosted providers are unverified by this gate.

## Durable installed-project gate

```sh
node scripts/check-libsql-project.mjs /absolute/tested-package.tgz \
  --sha256 <exact-tested-archive-sha256> --report /absolute/report.json
```

The gate consumes the supplied archive without rebuilding or altering it. It installs an independent consumer, compares every installed distribution file with the archive, and uses both the installed ESM `.bin/turbine` and CommonJS CLI. It exercises ESM/CommonJS projects, fresh init, native schema creation, strict generated consumers, typed seed, reopen/rollback, pull and honest catalog status. Filters, main-only catalog selection, relation cardinality and renames, raw column names, type overrides and four import modes are admitted through the real CLI. Six seed extensions, discovery, legacy config, help, unknown config, strict seed refusals and missing peer/native/tsx/mandatory-pg controls are included.

Generation regression controls require selected-database collision refusal at all three generated destinations, including hard links and paths through parent aliases. Invalid init generation must preserve the project tree before creating a database, directories, ignores, examples or generated output. Run these controls against the installed package to check the complete workflow.

TypeScript import mode uses Bundler resolution with `allowImportingTsExtensions`; extensionless mode also uses Bundler resolution. Default JavaScript output is compiled and executed under NodeNext in each project module mode. The generated native runtime is additionally executed with `node:sqlite` forbidden.

Scratch defaults to a unique owned directory under `~/.cache`; `TURBINE_LIBSQL_PROJECT_SCRATCH` can select another parent. Temporary fixtures contain no `.git`. Existing kernel ownership helpers bound subprocesses and record PID, starttime, group, command and cwd, including failure and signal cleanup. No database or web service is launched. The report retains command outcomes, archive and installed hashes, and an independent process/group and fixture cleanup audit.

This command is integrated into the existing `pack-smoke` job using that job's tested tarball and hash. A separate `./libsql/seed` size entry measures the optional surface; existing limits and coverage thresholds remain unchanged. Broad CLI coverage and final package checks remain required before promotion.
