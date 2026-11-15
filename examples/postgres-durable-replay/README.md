# Durable PostgreSQL application replay

This finite local order workflow composes the existing public `TurbineClient.transaction`,
notification hub and `liveQuery` APIs. It atomically writes an order and its complete
outbox record, then durably checkpoints a tenant-scoped consumer. Only orders written
through this application are captured. The example has no new package export.

Use an existing disposable local PostgreSQL database and an installed, built
`turbine-orm` package with `pg`, `typescript`, `@types/pg`, `@types/node` and `tsx`.
Copy `application.ts` and `demo.ts` into that consumer project, then run:

```sh
DATABASE_URL=postgresql://... NOTIFICATION_ENDPOINT=direct \
  node --import tsx demo.ts
```

The demo creates a unique schema, appends an exact-value order, delivers it,
closes/recreates the application, verifies the persisted checkpoint, and drops
its schema. It closes the caller's pool only after application cleanup. SIGINT
and SIGTERM abort the request and follow the same cleanup path. This is an
executable application example, not a migration or long-running service manager.

For a source checkout, use the focused source alias configuration:

```sh
TSX_TSCONFIG_PATH=src/test/fixtures/postgres-durable-replay/source-tsconfig.json \
DATABASE_URL=postgresql://... NOTIFICATION_ENDPOINT=direct \
  node --import tsx examples/postgres-durable-replay/demo.ts
```

Read the [durability contract](../../docs/postgres-durable-replay.md) before adapting
the workflow. In particular, callbacks can repeat, including a successful prefix
of a failed batch. External side effects require destination idempotency using
`(tenant, consumer, eventId)`. A progress snapshot is never an acknowledgement.

The [native runner](../../src/test/fixtures/postgres-durable-replay/native-run.mjs) owns a fresh
PostgreSQL 18.6 service using the existing bounded lifecycle/subreaper helpers.
It requires an immutable normal package archive and its explicit SHA256:

```sh
PG_PREFIX=/absolute/postgresql-18.6/usr \
  /absolute/node-22.16.0/bin/node \
  src/test/fixtures/postgres-durable-replay/native-run.mjs \
  /absolute/turbine-orm-0.93.1.tgz <sha256> /short/home-cache/new-output
# Repeat with exact Node 24.10.0 and a different new output directory.
```

The runner puts the selected runtime first on PATH, announces its owned native
root and selected ephemeral port before spawn, and records exact source/runtime/
driver/archive/payload identities. It retains failures, consumer locks, generated
declarations and output. It strictly compiles unchanged example files and positive/
negative type consumers in ESM and CJS, generates real clients from the native
application schema using both installed CLI formats, and executes the generated
typed projection. That read-only generated consumer explicitly configures its
own PostgreSQL `search_path`; the application uses qualified SQL throughout.

Source-native and both installed formats execute the same eleven material
controls, with zero skipped cases when the PostgreSQL prerequisite is required.
Missing required PostgreSQL is tested as a refusal. Ordinary repository unit
runs can skip this native suite when `DATABASE_URL` is absent.

An independent read-only audit rechecks every retained native run, including
failures, after services stop:

```sh
node tooling/optional-pg-transports/campaign/audit.mjs \
  /absolute/cleanup-audit.json /absolute/run22/report.json /absolute/run24/report.json
```

No benchmark timing, database-wide CDC, logical replication, hosted gateway,
non-PostgreSQL certification or support-tier promotion is claimed.
