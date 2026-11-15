# Local persistent D1 projects

This optional CLI workflow uses an actual Miniflare/workerd D1 binding. Install
`miniflare@4.20260730.0` in the project. The ordinary package keeps its mandatory
`pg` dependency; Miniflare is an optional tooling peer. It is not downloaded or
replaced with a generic SQLite driver when missing.

The accompanying `src/test/fixtures/d1-local-project/d1-shared.patch` is an
**UNAPPLIED integration proposal** for the shared CLI configuration, dispatch,
help and optional peer metadata. The new implementation files do not enable
shared dispatch until that patch is integrated. The patch is tested only in a
copied-source build and its normally packed, actually installed archive.

Start in a fresh project with:

```sh
npm install turbine-orm
npm install --save-dev --save-exact miniflare@4.20260730.0
npx turbine init --engine d1
```

Fresh init explicitly scaffolds the local defaults `binding: 'DB'`,
`databaseId: 'turbine-local'`, and `persist: './.turbine/d1'` in
`turbine.config.mjs`. Its complete migration plan starts empty. Existing project
configuration may instead select an explicit binding:

```js
export default {
  engine: 'd1',
  d1: { binding: 'DB', databaseId: 'my-local-db', persist: './.turbine/d1' },
  out: './generated/turbine',
  migrationsDir: './turbine/migrations',
};
```

Later commands require this exact configured identity and the marker written by
successful init. The marker pins the persistence version, runtime version,
binding, database ID and required database file. Missing state is refused before
runtime startup. Existing unrelated persistence is never adopted. This does not
import Wrangler state or certify a hosted D1 deployment.

Write the **complete immutable ordered history** to
`turbine/migrations/plan.json`:

```json
[
  {
    "id": "0001_items",
    "statements": [
      "CREATE TABLE items(id INTEGER PRIMARY KEY,label TEXT NOT NULL)",
      "INSERT INTO items VALUES(1,'first')"
    ]
  }
]
```

Each array entry contains one complete SQL statement. The existing native D1
migration helper admits the same conservative SQL subset, ordered IDs, checksums
and journal semantics. Scripts, triggers, transaction control and administrative
SQL are refused. Invalid pending SQL refuses before opening the local runtime.

```sh
npx turbine migrate status
npx turbine migrate deploy
npx turbine pull --out ./generated/first
# Append the next migration to the complete plan, retaining all previous entries.
npx turbine migrate deploy
npx turbine generate --out ./generated/second
npx turbine status
npx turbine migrate list
```

Generation requires a **fresh output directory**. In-place regeneration is
unimplemented. Use an explicit fresh `--out` for each later generation; existing
and edited generated files are preserved. Persistence, migration, configuration
and output paths must be disjoint project paths without symbolic links. Plan
files must not be hard-linked. Scaffolding creates files exclusively and rolls
back its own files on failure. Fresh generation renders every file first and
publishes through a staged directory and its own empty reservation.

Status/list read one consistent native SELECT snapshot of the schema and history.
They validate the canonical journal schema, complete history, checksums and head
hash. They never invoke deploy or create a journal. Opening Miniflare may still
maintain bookkeeping and WAL files; this is SQL/data read-only inspection, not a
promise of zero filesystem activity.

Deploy passes the complete captured plan to `migrateD1`. Native SQL failures roll
back according to D1's batch contract. A lost, malformed or partial response has
**unknown outcome**. Retry the identical complete plan to reconcile durable
history. In-flight work is not cancellable, and cleanup failure never proves a
rollback.

Before creating local state, the CLI probes the exact workerd executable with a
ten-second bound. A missing or unusable binary refuses before scaffolding.

Only one CLI runtime may own a persistence directory at a time. Startup and
binding acquisition are bounded to 30 seconds, disposal to five seconds. If
runtime cleanup fails or times out, the lock and state remain and cleanup is
reported as unresolved. A timeout alone does not prove the runtime stopped.
Before manually removing a stale `.turbine-d1.lock`, inspect its PID and prove the
owner and its admitted operations have stopped. Locks are never automatically
removed based only on age or a failed command. Do not remove another live
process's lock or persistence.

The fixture `d1-installed.mjs` exercises a normal archive install with no
optional runtime, genuine missing-tool refusal, help/aliases without tooling or
state, the repeated CLI lifecycle, persistent reopen, strict generated ESM/CJS
consumers in Node and workerd, read-only journal parity, races and malformed
responses. Its lifecycle fault fixture uses real workerd instances under the
existing bounded command/subreaper owner, with independent process cleanup
reports. Full combined coverage, fixed package budgets, runtime compatibility and
acceptance remain separate integration gates.
