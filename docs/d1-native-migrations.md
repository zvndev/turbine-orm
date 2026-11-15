# Optional D1 binding migrations

`migrateD1` applies a selected contiguous prefix of an ordered SQL plan in one D1 native transactional batch. It is a bounded binding API, tested with local workerd. It does not provide an interactive transaction, callback migration, remote CLI, rollback command, hosted D1 certification, cancellation after dispatch, or connection ownership.

The `turbine-orm/d1/migrate` entry was added in 0.94.0 with a separate size gate. It adds no mandatory dependency. Existing D1 factory, pool, types, catalogs, exports and all 24 existing size budgets remain unchanged.

```ts
import { migrateD1, D1MigrationError } from 'turbine-orm/d1/migrate';

const plan = [
  {
    id: '0001_accounts',
    statements: ['CREATE TABLE accounts(id INTEGER PRIMARY KEY, name TEXT NOT NULL)'],
  },
  {
    id: '0002_name_index',
    statements: ['CREATE UNIQUE INDEX accounts_name ON accounts(name)'],
  },
] as const;

// env.DB is the original caller-owned Worker D1Database binding.
const report = await migrateD1(env.DB, plan);
// report.applied and report.alreadyApplied contain ordered migration ids.
```

Supply the complete plan every time, including already applied and currently unselected entries. IDs are unique, strictly increasing ASCII strings matching a numeric prefix and lowercase name, for example `0001_accounts`. `through: '0001_accounts'` selects that complete prefix. It cannot skip history or rewind an applied prefix. Append new entries instead of changing prior IDs, order, comments, whitespace or SQL.

Every plan entry, statement string and option is captured synchronously before the first WebCrypto or native await. SHA-256 covers the exact UTF-8 encoding of `turbine-d1-migration-v1\n` followed by `JSON.stringify([id, statements])`. Execution strips outer comments, BOM, whitespace and the optional final semicolon, because workerd rejects a comment-only prepared-statement tail. Checksums retain the original text.

The durable `_turbine_d1_migrations` table stores ordered `(position, id, checksum)` rows. Position zero holds the format marker `!turbine-d1-v1` and SHA-256 of the complete ordered history tuples with the `turbine-d1-history-v1\n` domain. This head detects deleted suffixes, erased rows and missing heads as well as altered checksums and gaps. The helper never rewrites a historical checksum to admit drift.

Admission first checks the exact journal definition, permitted existing schema and complete supplied history. The dispatched batch then contains:

1. `CREATE TABLE IF NOT EXISTS` for the journal.
2. A native SQL assertion matching the entire schema and every history row to the admitted snapshots, including the head. A mismatch evaluates deliberately malformed JSON inside a SQLite `CASE`, producing a native error independently of journal constraints, triggers or affected-row counts.
3. Every selected pending SQL statement, ordered journal inserts and the updated history head.

The pre-read does not lock anything. The assertion executes inside the same native transaction before user SQL. A racing deployment or schema edit makes a stale batch fail before its migration statements. Native failure rolls back the batch, including new schema, writes, history and journal bootstrap. An identical concurrent first deployment has one admitted winner; the stale caller receives an uncertain dispatch error and can reconcile by retrying the identical complete plan. An unguarded native batch control demonstrates duplicate effects without this assertion.

The native proof also replaces the journal with an unconstrained table after pre-read. This must still fail the assertion, leave replacement history intact, and produce no migration effects. A guard based only on a journal CHECK constraint would fail this control.

Ordinary table/index CREATE, ALTER, DROP and INSERT/UPDATE/DELETE are admitted as individual statements. Native SQLite validates their grammar and constraints. The helper refuses scripts, transaction control, PRAGMA, ATTACH/DETACH, VACUUM, EXPLAIN, SELECT entry points, WITH entry points, REPLACE entry points, views, temporary objects, virtual tables and triggers. Existing triggers, virtual tables, views and schema outside this conservative subset also cause refusal. This avoids claiming authorizer capabilities that the D1 binding does not expose.

SQLite comments, BOM and all quote forms are recognized independently of the PostgreSQL CLI tokenizer. Decoded single/double/backtick/bracket quoted values and unquoted tokens cannot contain reserved `_turbine_`, `_cf_`, `sqlite_` or `d1_` fragments. This intentionally refuses some harmless string values. Bind parameters, NUL bytes, non-ASCII unquoted tokens, unterminated comments/quotes, and statements larger than 100,000 UTF-8 bytes are refused before preparation. Snapshot bound values are limited to 2 MB. There is no heuristic script splitting or use of the node:sqlite authorizer.

The guarantee concerns cooperating callers of this helper on the original binding. Application writes can still make migration constraints fail. Administrative writers can destroy or forge the entire journal and its head; checksums are integrity evidence, not authentication. A journal dropped before admission is indistinguishable from a fresh database. Protect journal access, retain the source plan and use database backups for administrative recovery. The helper does not certify arbitrary application-schema drift or restore lost journal evidence.

`signal` is checked before admission and immediately before batch dispatch. Aborted signals refuse the operation with the original reason. Once `batch()` has been called, aborting the signal does not cancel it, reject a committed result, or shorten the wait. D1 has no in-flight batch cancellation API.

`D1MigrationError` reports `phase` and `outcome`:

This optional binding helper uses its own error class rather than importing the
query runtime's `TurbineError` graph. Internal SQL/result errors are retained as
its `cause`; the repository guard registers only these two migration modules.

| Phase | Outcome | Meaning |
|---|---|---|
| `admission` | `not-dispatched` | Invalid SQL/options/plan, history drift, collision, unsupported schema or preparation failure |
| `read` | `not-dispatched` | Native schema/history read failed before migration dispatch |
| `dispatch` | `unknown` | The batch was called; failure, response loss or malformed results prevent a reliable success conclusion |

Although native SQL errors roll back, the helper conservatively reports every dispatch exception as unknown. An exception alone cannot prove the response was not lost after commit. Do not announce rollback, close the binding, start compensating SQL or assume cancellation. Retry the identical complete plan when appropriate; a committed plan reconciles to `applied: []`, and an uncommitted plan is guarded and attempted atomically. There is no automatic retry. A changed or incomplete plan is refused. The real-binding tests simulate response loss only after an actual successful commit and verify there is no duplicated effect on retry.

Cloudflare documents [ordered transactional batches and rollback](https://developers.cloudflare.com/d1/worker-api/d1-database/), [SQLite support](https://developers.cloudflare.com/d1/sql-api/sql-statements/), and [per-statement and bound-value limits](https://developers.cloudflare.com/d1/platform/limits/). SQLite documents [lexical tokens](https://www.sqlite.org/draft/tokenreq.html) and [lazy CASE evaluation](https://www.sqlite.org/lang_expr.html#the_case_expression). Local native proof does not replace hosted testing or expand the candidate's support tier.
