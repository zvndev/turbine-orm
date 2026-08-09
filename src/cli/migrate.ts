/**
 * turbine-orm CLI, Migration system
 *
 * SQL-first migrations with UP/DOWN sections, tracked in _turbine_migrations.
 * Migration files are timestamp-prefixed .sql files.
 *
 * File format:
 *   -- UP
 *   CREATE TABLE users (...);
 *
 *   -- DOWN
 *   DROP TABLE users;
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import type { DatabaseAdapter } from '../adapters/index.js';
import { postgresql } from '../adapters/index.js';
import { type Dialect, postgresDialect } from '../dialect.js';
import { MigrationError } from '../errors.js';
import { DESTRUCTIVE_KIND_LABEL, type DestructiveStatement, scanDestructiveSql } from './destructive.js';
import { splitSqlStatements, tokenizeSql } from './sql-statements.js';

/**
 * Re-exported from `./sql-statements.js`, which owns the one tokenizer this
 * module and `destructive.js` both speak. It used to live here, and the guard
 * carried a second, subtly different copy: see that module's header for what
 * they disagreed about and what it cost.
 */
export { splitSqlStatements };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MigrationFile {
  /** Full filename (e.g. "20260325120000_create_users.sql") */
  filename: string;
  /** Absolute path to the file */
  path: string;
  /** Extracted name portion (e.g. "20260325120000_create_users") */
  name: string;
  /** Timestamp prefix (e.g. "20260325120000"), YYYYMMDDHHMMSS */
  timestamp: string;
}

export interface AppliedMigration {
  id: number;
  name: string;
  applied_at: Date;
  checksum: string;
}

export interface MigrationStatus {
  file: MigrationFile;
  applied: boolean;
  appliedAt?: Date;
  /** True if the file checksum matches the stored checksum (only set for applied migrations) */
  checksumValid?: boolean;
  /** True when the migration was applied but its file is missing from disk. */
  missingFile?: boolean;
}

/** A pending migration whose UP section contains data-destroying statements. */
export interface DestructiveOffender {
  file: string;
  hits: DestructiveStatement[];
}

/**
 * A migration that was applied even though an already-applied migration carries
 * a newer timestamp prefix, i.e. history was written out of order.
 */
export interface OutOfOrderApply {
  /** The out-of-order migration that was just applied. */
  applied: string;
  /** The newest previously-applied migration it landed behind. */
  newestPrior: string;
}

export interface MigrationRunResult {
  applied: MigrationFile[];
  errors: Array<{ file: MigrationFile; error: string }>;
  /**
   * Destructive statements found in the pending batch. Populated whether or not
   * the run was allowed to proceed, so a caller (deploy) can print a notice even
   * when it applies them by design.
   */
  destructive: DestructiveOffender[];
  /** Migrations applied with a timestamp older than an already-applied one. */
  outOfOrder: OutOfOrderApply[];
  /**
   * Migrations applied WITHOUT a transaction (they carried the
   * `-- turbine:no-transaction` directive). The CLI prints a loud notice for
   * each: a mid-file failure leaves earlier statements applied and the migration
   * unrecorded, so every statement in one of these must be idempotent.
   */
  noTransaction: MigrationFile[];
}

/** Extract the YYYYMMDDHHMMSS timestamp prefix from a migration name, or null. */
export function migrationTimestamp(name: string): string | null {
  const m = name.match(/^(\d{14})(?:_|$)/);
  return m ? m[1]! : null;
}

/**
 * Refuse any migration in the batch that manages its own transactions.
 *
 * `-- turbine:no-transaction` files are exempt: they were never wrapped, so
 * theirs is a real (and supported) transaction to manage. Pre-flight over the
 * WHOLE batch, before anything runs, so a bad file at position 3 does not leave
 * migrations 1 and 2 applied.
 *
 * @internal exported for tests.
 */
export function assertNoEmbeddedTransactions(files: MigrationFile[], section: 'up' | 'down'): void {
  const offenders: Array<{ file: string; statements: string[] }> = [];
  for (const file of files) {
    const parsed = parseMigrationSQL(file.path);
    if (parsed.noTransaction) continue;
    const statements = findTransactionControlStatements(section === 'up' ? parsed.up : parsed.down);
    if (statements.length > 0) offenders.push({ file: file.filename, statements });
  }
  if (offenders.length === 0) return;

  const lines = [
    `[turbine] Refusing to run migrations that manage transactions themselves (${section.toUpperCase()} section):`,
    '',
  ];
  for (const o of offenders) {
    lines.push(`  ${o.file}`);
    for (const s of o.statements) lines.push(`    - ${s}`);
  }
  lines.push('');
  lines.push('`turbine migrate` already runs each migration file inside exactly ONE transaction.');
  lines.push('An embedded COMMIT ends that wrapper: everything before it becomes durable,');
  lines.push('everything after runs unprotected, and the migration is recorded nowhere, so a');
  lines.push('rerun fails forever on "already exists".');
  lines.push('');
  lines.push('Delete the BEGIN/COMMIT/ROLLBACK statements (the runner supplies the transaction),');
  lines.push('or, if this migration genuinely cannot run inside one (CREATE INDEX CONCURRENTLY),');
  lines.push('add `-- turbine:no-transaction` to the file header and manage it yourself.');
  throw new MigrationError(lines.join('\n'));
}

/** Scan a set of migration files' UP sections for data-destroying statements. */
export function collectUpDestructive(files: MigrationFile[]): DestructiveOffender[] {
  const offenders: DestructiveOffender[] = [];
  for (const file of files) {
    const { up } = parseMigrationSQL(file.path);
    if (!up) continue;
    const hits = scanDestructiveSql(up);
    if (hits.length > 0) offenders.push({ file: file.filename, hits });
  }
  return offenders;
}

// ---------------------------------------------------------------------------
// Tracking table management
// ---------------------------------------------------------------------------

const TRACKING_TABLE = '_turbine_migrations';

/**
 * The dialect the migration runner speaks.
 *
 * The runner connects with `pg.Client`, so Postgres (and the Postgres-compatible
 * engines behind `adapters/`) is the only thing it can actually reach. The
 * dialect is still threaded through every tracking-table statement, so making
 * migrations dialect-aware is a matter of teaching this layer to build the
 * engine's own client. Until then there is deliberately NO caller-supplied
 * dialect option: accepting one would advertise sqlite/mysql/mssql migrations
 * that silently run their SQL against Postgres.
 */
function migrationDialect(): Dialect {
  return postgresDialect;
}

function quotedTrackingTable(dialect: Dialect): string {
  return dialect.quoteIdentifier(TRACKING_TABLE);
}

/**
 * Postgres error codes that mean "someone else created this table between our
 * existence check and our CREATE".
 *
 * `CREATE TABLE IF NOT EXISTS` is NOT race-free: the existence check and the
 * catalog insert are separate steps, so two concurrent sessions can both pass
 * the check and the loser gets a hard error rather than a quiet no-op. Measured
 * on a fresh database with 12 concurrent `migrate status` calls: 1 succeeded and
 * 11 crashed, on `duplicate key value violates unique constraint
 * "pg_type_typname_nsp_index"` (23505) and `relation "_turbine_migrations"
 * already exists` (42P07). `migrate up`/`down` hold the migration lock before
 * they reach here, but `migrate status` and the deploy inspector deliberately do
 * not, and read-only commands should not need a lock to survive each other.
 */
const TABLE_ALREADY_EXISTS_CODES = new Set(['23505', '42P07']);

async function ensureTrackingTable(client: pg.Client, dialect: Dialect = postgresDialect): Promise<void> {
  const sql = dialect.buildMigrationTrackingTable(quotedTrackingTable(dialect));
  try {
    await client.query(sql);
  } catch (err) {
    if (!TABLE_ALREADY_EXISTS_CODES.has(String((err as { code?: string }).code))) throw err;
    // The winner has committed by the time we see its error, so the retry finds
    // the table present and the statement really is a no-op. Retried ONCE: a
    // second failure is not this race and must surface.
    await client.query(sql);
  }
}

async function getAppliedMigrations(
  client: pg.Client,
  dialect: Dialect = postgresDialect,
): Promise<AppliedMigration[]> {
  await ensureTrackingTable(client, dialect);
  const result = await client.query<AppliedMigration>(
    dialect.buildMigrationSelectApplied(quotedTrackingTable(dialect)),
  );
  return result.rows;
}

// ---------------------------------------------------------------------------
// File operations
// ---------------------------------------------------------------------------

/**
 * Parse a migration filename into its components.
 * Expected format: YYYYMMDDHHMMSS_description.sql
 */
export function parseMigrationFilename(filename: string): MigrationFile | null {
  const match = filename.match(/^(\d{14})_(.+)\.sql$/);
  if (!match) return null;
  return {
    filename,
    path: '', // Set by caller
    name: filename.replace(/\.sql$/, ''),
    timestamp: match[1]!,
  };
}

/**
 * A migration name as it can safely appear in a file's `-- Migration:` header
 * comment.
 *
 * The header sits ABOVE the `-- UP` marker, and the raw CLI argument used to be
 * interpolated into it verbatim. A `--` comment ends at the first newline, so a
 * name carrying one closes the comment and everything after it becomes file
 * content: a name of `x\n-- turbine:no-transaction\n-- UP\nDROP TABLE users;`
 * wrote both an execution directive and executable SQL into a migration the
 * user never authored. Only the FILENAME was sanitized, which is the one place
 * the injection could not reach.
 *
 * Collapsing every run of whitespace to a single space is the whole fix: the
 * argument then cannot leave the one comment line it was written on, and `\s`
 * covers `\r` and the Unicode line separators too, all of which Postgres also
 * treats as ending a `--` comment. The readable spelling is preserved, unlike
 * {@link sanitizeName}, because this is documentation for a human.
 */
export function headerSafeName(name: string): string {
  return name.replace(/\s+/g, ' ').trim();
}

/**
 * Sanitize a migration name: lowercase, replace non-alnum with _, collapse duplicates, trim.
 */
export function sanitizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Generate a YYYYMMDDHHMMSS timestamp string from a Date.
 */
export function formatTimestamp(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
    String(date.getSeconds()).padStart(2, '0'),
  ].join('');
}

/**
 * Get pending migration files, those not yet applied.
 * Returns files sorted by timestamp (ascending).
 */
export function getPendingMigrations(migrationsDir: string, applied: string[]): MigrationFile[] {
  const appliedSet = new Set(applied);
  return listMigrationFiles(migrationsDir).filter((f) => !appliedSet.has(f.name));
}

/**
 * List all migration files in the migrations directory, sorted by name.
 */
export function listMigrationFiles(migrationsDir: string): MigrationFile[] {
  if (!existsSync(migrationsDir)) return [];

  const entries = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const files: MigrationFile[] = [];
  for (const entry of entries) {
    const parsed = parseMigrationFilename(entry);
    if (parsed) {
      parsed.path = join(migrationsDir, entry);
      files.push(parsed);
    }
  }
  return files;
}

/**
 * The `-- turbine:no-transaction` directive: when present in a migration's
 * header (before `-- UP`), the runner applies the file WITHOUT wrapping it in
 * BEGIN/COMMIT and runs one statement per `client.query()` call. Required for
 * `CREATE INDEX CONCURRENTLY`, which Postgres forbids inside any transaction,
 * including the implicit transaction a multi-statement simple query creates.
 */
const NO_TRANSACTION_DIRECTIVE = /^--\s*turbine:no-transaction\s*$/i;

/**
 * A section marker line.
 *
 * Matching the exact strings `-- UP` and `-- DOWN` was too strict for the ways
 * people actually write them: `--DOWN`, `--  DOWN`, and `-- DOWN;` all read as
 * ordinary comments, so the whole rollback section silently folded into the UP
 * section and RAN as part of the migration. `migrate up` was saved from the
 * worst of that by the destructive gate, but `migrate deploy` passes
 * `allowDestructive: true` unconditionally, so a create-then-drop pair applied
 * as one "successful" migration.
 *
 * Deliberately still anchored end-to-end: `-- UPDATE the widgets table` is a
 * comment, not a marker.
 */
const SECTION_MARKER = /^--\s*(UP|DOWN)\s*;?\s*$/i;

/** The parsed sections of a migration file plus its execution directives. */
export interface ParsedMigration {
  up: string;
  down: string;
  /** True when the `-- turbine:no-transaction` directive is present in the header. */
  noTransaction: boolean;
}

/**
 * Parse migration content string into UP and DOWN sections plus directives.
 *
 * Throws `MigrationError` when the file carries no `-- UP` marker at all.
 * Returning `{ up: '', down: '' }` there meant the entire file was treated as
 * preamble and the migration recorded as applied having executed nothing, which
 * is worse than any error: the database is missing the change and the history
 * says it is present. `source` (a path) is only used to name the file.
 *
 * Exported for unit testing.
 */
export function parseMigrationContent(content: string, source?: string): ParsedMigration {
  const lines = content.split('\n');

  let section: 'none' | 'up' | 'down' = 'none';
  let sawUpMarker = false;
  let noTransaction = false;
  const upLines: string[] = [];
  const downLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // The directive is only honored in the header (before -- UP), so it can
    // never be smuggled in via a DOWN-section comment.
    if (section === 'none' && NO_TRANSACTION_DIRECTIVE.test(trimmed)) {
      noTransaction = true;
      continue;
    }
    const marker = SECTION_MARKER.exec(trimmed);
    if (marker) {
      const isUp = marker[1]!.toUpperCase() === 'UP';
      section = isUp ? 'up' : 'down';
      sawUpMarker ||= isUp;
      continue;
    }

    if (section === 'up') upLines.push(line);
    else if (section === 'down') downLines.push(line);
  }

  if (!sawUpMarker) {
    throw new MigrationError(
      [
        `[turbine] Migration file has no \`-- UP\` section marker${source ? `: ${source}` : '.'}`,
        '',
        'A migration must contain a line reading `-- UP` (a `-- DOWN` line is optional).',
        'Without it the whole file is a header comment: nothing would run, and the',
        'migration would still be recorded as applied.',
        '',
        'Accepted spellings: `-- UP`, `--UP`, `-- up`, `-- UP;` (leading/trailing spaces fine).',
      ].join('\n'),
    );
  }

  return {
    up: upLines.join('\n').trim(),
    down: downLines.join('\n').trim(),
    noTransaction,
  };
}

/**
 * Statements that end (or restart) the transaction the runner wraps a migration
 * file in.
 *
 * `runMigrationInTransaction` issues `BEGIN`, the file body, the tracking-table
 * write, then `COMMIT`. An embedded `COMMIT;` in the body commits THAT wrapper:
 * everything before it becomes durable, everything after runs unprotected, the
 * tracking write happens outside any transaction the failure path can undo, and
 * a mid-file error leaves the migration recorded nowhere. Rerunning then fails
 * forever on "already exists". So the runner refuses the file instead.
 *
 * `END` is deliberately NOT in this list even though Postgres accepts it as a
 * synonym for COMMIT: a PG14+ `CREATE FUNCTION ... BEGIN ATOMIC ... END;` body
 * splits at its inner semicolons, leaving a bare `END` fragment, and refusing
 * that would break working migrations to catch a spelling nobody writes.
 * `ROLLBACK TO [SAVEPOINT] x` is excluded for the opposite reason: it is the one
 * ROLLBACK form that leaves the wrapping transaction open, so it is legitimate.
 */
const TRANSACTION_CONTROL = /^(BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK|ABORT)\b/i;
const ROLLBACK_TO_SAVEPOINT = /^ROLLBACK\s+TO\b/i;

/**
 * Top-level transaction-control statements in a migration body, as displayable
 * text. Empty for a clean file. Comment- and literal-aware via the shared
 * tokenizer, so a `COMMIT` inside a comment or a string is not flagged.
 *
 * @internal exported for tests.
 */
export function findTransactionControlStatements(body: string): string[] {
  const found: string[] = [];
  for (const statement of tokenizeSql(body)) {
    if (statement.commentOnly) continue;
    const head = statement.stripped;
    if (!TRANSACTION_CONTROL.test(head) || ROLLBACK_TO_SAVEPOINT.test(head)) continue;
    found.push(head.replace(/\s+/g, ' ').slice(0, 80));
  }
  return found;
}

/**
 * Parse a migration file into UP and DOWN sections.
 */
export function parseMigrationSQL(filePath: string): ParsedMigration {
  const content = readFileSync(filePath, 'utf-8');
  return parseMigrationContent(content, filePath);
}

/**
 * SHA-256 checksum for migration drift detection.
 * Returns a hex-encoded hash of the file content.
 */
function checksum(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

/**
 * The pre-v0.6 checksum algorithm (a 32-bit rolling hash rendered as base36).
 * Kept verbatim so a legacy stored value can be RE-DERIVED from the current
 * file content before we upgrade the row to SHA-256. Never used for new rows.
 */
function legacyChecksum(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const chr = content.charCodeAt(i);
    hash = ((hash << 5) - hash + chr) | 0;
  }
  return Math.abs(hash).toString(36);
}

/**
 * Detect legacy checksums (short alphanumeric strings, pre-v0.6).
 * An EMPTY checksum is never legacy: blessing it would silently disarm drift
 * detection for a row whose stored hash was lost or never written.
 */
function isLegacyChecksum(hash: string): boolean {
  return hash.length > 0 && hash.length < 64;
}

/**
 * Can a stored pre-v0.6 checksum be safely upgraded to SHA-256?
 *
 * Only when the LEGACY algorithm, run over the file's CURRENT content,
 * reproduces the stored value: that is what proves the file has not changed
 * since it was applied. Upgrading without this proof blesses whatever the file
 * says today and permanently disables drift detection for that migration.
 *
 * @internal exported for tests.
 */
export function canUpgradeLegacyChecksum(stored: string, content: string): boolean {
  return isLegacyChecksum(stored) && legacyChecksum(content) === stored;
}

/**
 * Is an applied migration's stored checksum still valid for the file on disk?
 *
 * A SHA-256 match is the normal case. A pre-v0.6 row that {@link
 * canUpgradeLegacyChecksum} would upgrade counts as valid too: `migrate up`
 * accepts and upgrades it, so reporting it as invalid in `migrate status` would
 * have the two commands disagree about the same unchanged file. Genuine drift
 * (a legacy hash the current content no longer reproduces) still reports false.
 *
 * @internal exported for tests.
 */
export function isChecksumValid(stored: string, content: string): boolean {
  return checksum(content) === stored || canUpgradeLegacyChecksum(stored, content);
}

// ---------------------------------------------------------------------------
// Migration recipes: scaffolds for sanctioned multi-step patterns
// ---------------------------------------------------------------------------

/**
 * A named migration scaffold. `build()` returns the commented-SQL UP/DOWN body
 * for the recipe; `createMigration({ recipe })` wraps it in the file header.
 */
export interface MigrationRecipe {
  /** One-line description shown in CLI help. */
  description: string;
  /** Build the UP/DOWN body (commented scaffold with placeholders). */
  build(name: string): { up: string; down: string };
}

/** The sanctioned two-phase (add nullable, batched backfill, swap) recipe. */
function buildBackfillRecipe(): { up: string; down: string } {
  const up = `-- Two-phase backfill scaffold. Every statement below is COMMENTED OUT: fill in
-- your table, the new column, the old column, and the transform, then uncomment
-- the phases you need and review before running \`npx turbine migrate up\`.
--
-- Do NOT add BEGIN/COMMIT of your own anywhere in this file. \`turbine migrate\`
-- already runs each migration file inside exactly ONE transaction, so every
-- statement here commits or rolls back together. An embedded COMMIT would end
-- that wrapper early, leaving the first half durable and the migration recorded
-- nowhere; the runner refuses a file that contains one.
--
-- Phase 1: add the new column as NULLABLE. This is a fast, non-blocking change
-- (no table rewrite, no long lock), so it is safe to ship ahead of the backfill.
-- ALTER TABLE "my_table" ADD COLUMN "new_col" text;
--
-- Phase 2: backfill in bounded batches. Repeat this UPDATE until it reports
-- 0 rows affected. \`turbine migrate\` runs each file exactly once, so for large
-- tables drive the loop from psql or your app rather than inlining it here.
-- Tune the LIMIT (batch size) to your row width and lock tolerance.
-- UPDATE "my_table"
--    SET "new_col" = transform("old_col")
--  WHERE "new_col" IS NULL
--    AND "id" IN (
--      SELECT "id" FROM "my_table" WHERE "new_col" IS NULL LIMIT 5000
--    );
--
-- Phase 3: once every row is populated, enforce NOT NULL.
-- Note: SET NOT NULL takes an exclusive lock and scans the table. On huge
-- tables, first ADD CONSTRAINT ... CHECK ("new_col" IS NOT NULL) NOT VALID,
-- then VALIDATE CONSTRAINT (PG 12+ uses the validated check to skip the scan).
-- ALTER TABLE "my_table" ALTER COLUMN "new_col" SET NOT NULL;
--
-- Phase 4 (optional atomic swap): retire the old column and rename the new one
-- into its place. Both renames land in the runner's single per-file
-- transaction, so readers never see a missing column: no BEGIN/COMMIT needed.
-- ALTER TABLE "my_table" RENAME COLUMN "old_col" TO "old_col_retired";
-- ALTER TABLE "my_table" RENAME COLUMN "new_col" TO "old_col";`;

  const down = `-- Reverse the Phase 4 atomic swap (only if you ran it). Same single
-- transaction as the UP direction, so again no BEGIN/COMMIT of your own.
-- ALTER TABLE "my_table" RENAME COLUMN "old_col" TO "new_col";
-- ALTER TABLE "my_table" RENAME COLUMN "old_col_retired" TO "old_col";
--
-- If you stopped after phases 1 to 3, drop the added column instead:
-- ALTER TABLE "my_table" DROP COLUMN "new_col";`;

  return { up, down };
}

/**
 * Registry of migration recipes, keyed by `--recipe <name>`. New recipes slot
 * in here without touching {@link createMigration} or the CLI handler.
 */
export const MIGRATION_RECIPES: Record<string, MigrationRecipe> = {
  backfill: {
    description: 'Two-phase column backfill (add nullable, batched UPDATE, SET NOT NULL, rename swap)',
    build: buildBackfillRecipe,
  },
};

// ---------------------------------------------------------------------------
// Diff-based migration body (`migrate create --from-diff`)
// ---------------------------------------------------------------------------

/**
 * The UP/DOWN body produced by {@link buildDiffMigrationBody}, plus the
 * destructive statements found in each direction so the CLI can warn loudly.
 */
export interface DiffMigrationBody {
  /** Annotated UP SQL (destructive statements flagged with loud comments). */
  up: string;
  /** Annotated DOWN SQL, or an irreversible placeholder when none is derivable. */
  down: string;
  /** Destructive statements detected in the UP direction. */
  destructiveUp: DestructiveStatement[];
  /** Destructive statements detected in the DOWN direction. */
  destructiveDown: DestructiveStatement[];
}

/** Loud file-level banner prepended when a diff migration contains destructive statements. */
const DESTRUCTIVE_MIGRATION_BANNER = [
  '-- ============================================================',
  '-- WARNING: this migration contains DESTRUCTIVE statement(s).',
  '-- Each one is flagged inline below. `turbine migrate up` refuses',
  '-- destructive statements by default: it asks you to confirm',
  '-- interactively, or you must pass --allow-destructive. Review',
  '-- every flagged statement carefully before running.',
  '-- ============================================================',
];

/**
 * Annotate a list of SQL statements: scan each for data-destroying operations
 * (via {@link scanDestructiveSql}) and prefix any offender with loud, commented
 * warnings. Statements are left intact so the existing `migrate up` gate still
 * refuses them by default; the comments just make the danger visible on review.
 */
function annotateDiffStatements(statements: string[]): { text: string; destructive: DestructiveStatement[] } {
  const destructive: DestructiveStatement[] = [];
  const out: string[] = [];

  for (const raw of statements) {
    const stmt = raw.trim();
    if (!stmt) continue;

    const hits = scanDestructiveSql(stmt);
    if (hits.length > 0) {
      destructive.push(...hits);
      for (const h of hits) {
        out.push(`-- !! DESTRUCTIVE [${h.kind}] ${h.target}: ${DESTRUCTIVE_KIND_LABEL[h.kind]}`);
      }
      out.push('-- !! Refused by default. Confirm interactively or pass --allow-destructive to run it.');
    }
    out.push(stmt.endsWith(';') ? stmt : `${stmt};`);
  }

  return { text: out.join('\n'), destructive };
}

/**
 * Build a migration UP/DOWN body from a `schemaDiff()` result.
 *
 * - UP is the diff's forward statements. DOWN is the diff's reverse statements
 *   when derivable, otherwise a clearly-commented "irreversible" placeholder.
 * - Destructive statements in EITHER direction (a lossy `ALTER COLUMN ... TYPE`
 *   in UP, a `DROP TABLE`/`DROP COLUMN` reverse in DOWN) are flagged inline and,
 *   when any exist, a loud file-level banner is prepended to UP.
 * - Any diff `warnings` (changes the diff refuses to apply automatically, e.g.
 *   enum value removals) are surfaced as `-- NOTE:` comments in UP.
 *
 * Pure and DB-free, so it is unit-testable from a synthesized diff.
 */
export function buildDiffMigrationBody(diff: {
  statements: string[];
  reverseStatements: string[];
  warnings?: string[];
}): DiffMigrationBody {
  const up = annotateDiffStatements(diff.statements);
  const hasReverse = diff.reverseStatements.length > 0;
  const down = hasReverse
    ? annotateDiffStatements(diff.reverseStatements)
    : { text: '', destructive: [] as DestructiveStatement[] };

  const upParts: string[] = [];
  if (up.destructive.length > 0 || down.destructive.length > 0) {
    upParts.push(...DESTRUCTIVE_MIGRATION_BANNER, '');
  }
  if (diff.warnings && diff.warnings.length > 0) {
    for (const w of diff.warnings) upParts.push(`-- NOTE: ${w}`);
    upParts.push('');
  }
  upParts.push(up.text || '-- (no statements: schema already matches the database)');

  const downText = hasReverse
    ? down.text
    : [
        '-- irreversible, write manually',
        '-- The diff produced no reversible statements for this change. Write the',
        '-- rollback SQL by hand, or leave this section empty for a one-way migration.',
      ].join('\n');

  return {
    up: upParts.join('\n'),
    down: downText,
    destructiveUp: up.destructive,
    destructiveDown: down.destructive,
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Create a new migration file.
 *
 * - `autoContent`: pre-populate UP/DOWN from a schema diff.
 * - `options.recipe`: scaffold a named recipe (see {@link MIGRATION_RECIPES}).
 *   Mutually exclusive with `autoContent`; an unknown recipe throws.
 * - `options.header`: extra header line(s) injected BEFORE `-- UP` (the only
 *   place a `-- turbine:no-transaction` directive is honored). Used with
 *   `autoContent`.
 */
export function createMigration(
  migrationsDir: string,
  name: string,
  autoContent?: { up: string; down: string },
  options?: { recipe?: string; header?: string },
): MigrationFile {
  mkdirSync(migrationsDir, { recursive: true });

  const now = new Date();
  const ts = formatTimestamp(now);
  const safeName = sanitizeName(name);
  // The header comment is the ONLY place the caller's raw string reaches the
  // file, and it sits above `-- UP`: see headerSafeName for what that allowed.
  const headerName = headerSafeName(name);

  const filename = `${ts}_${safeName}.sql`;
  const filePath = join(migrationsDir, filename);

  let template: string;
  if (options?.recipe) {
    const recipe = MIGRATION_RECIPES[options.recipe];
    if (!recipe) {
      const known = Object.keys(MIGRATION_RECIPES).join(', ') || '(none)';
      throw new MigrationError(`[turbine] Unknown migration recipe "${options.recipe}". Available recipes: ${known}`);
    }
    // A recipe builds the BODY, below `-- UP`, where a newline is not merely a
    // comment break but directly executable, so it gets the safe name too.
    const body = recipe.build(headerName);
    template = `-- Migration: ${headerName} (${options.recipe} recipe scaffold)
-- Created: ${now.toISOString()}
-- Fill in the placeholders and review before running: npx turbine migrate up

-- UP
${body.up}

-- DOWN
${body.down}
`;
  } else if (autoContent) {
    const headerBlock = options?.header ? `${options.header}\n` : '';
    template = `-- Migration: ${headerName} (auto-generated)
-- Created: ${now.toISOString()}
-- Review this file before running: npx turbine migrate up
${headerBlock}
-- UP
${autoContent.up}

-- DOWN
${autoContent.down}
`;
  } else {
    template = `-- Migration: ${headerName}
-- Created: ${now.toISOString()}

-- UP
-- Write your migration SQL here

-- DOWN
-- Write your rollback SQL here
`;
  }

  writeFileSync(filePath, template, 'utf-8');

  return {
    filename,
    path: filePath,
    name: filename.replace(/\.sql$/, ''),
    timestamp: ts,
  };
}

// ---------------------------------------------------------------------------
// Advisory lock for concurrent migration safety
// ---------------------------------------------------------------------------

/**
 * Derive a Postgres advisory lock ID (positive int4) from the database name.
 *
 * Uses FNV-1a 32-bit hash, a well-known, stable, non-cryptographic hash with
 * excellent distribution over short strings (database names are typically <64
 * chars). Chosen over alternatives because it's:
 *   - deterministic (same input → same output, across processes/machines)
 *   - tiny (two lines, no allocations, no imports)
 *   - well-distributed (low collision rate for typical DB-name distributions)
 *
 * The top bit is cleared so the result fits in a positive int4, which is the
 * range `pg_advisory_lock` expects for the single-argument form. Two databases
 * in the same Postgres cluster can now run `turbine migrate` concurrently
 * without contending on a single hardcoded lock ID.
 */
export function deriveLockId(databaseName: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < databaseName.length; i++) {
    hash ^= databaseName.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 1; // positive int4 (top bit cleared)
}

/**
 * Fetch the current database name from the connected client. Used to derive
 * the advisory lock ID so concurrent migrations in sibling databases do not
 * contend on one another.
 */
async function getCurrentDatabaseName(client: pg.Client): Promise<string> {
  const result = await client.query<{ current_database: string }>(`SELECT current_database()`);
  return result.rows[0]?.current_database ?? '';
}

/** Open the second, lock-only connection. Separated so tests can fake it. */
async function openLockConnection(connectionString: string): Promise<MigrationLockClient> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  return client;
}

/**
 * The connection surface the migration lock needs. `pg.Client` satisfies it;
 * tests substitute a fake so the dedicated-connection wiring can be exercised
 * without a database.
 *
 * @internal
 */
export interface MigrationLockClient {
  query(sql: string, params?: unknown[]): Promise<unknown>;
  end(): Promise<void>;
}

/** A held (or refused) migration lock, and whatever must be released with it. */
export interface MigrationLock {
  /** False when another migration already holds the lock. */
  acquired: boolean;
  lockId: number;
  adapter: DatabaseAdapter;
  /**
   * The dedicated connection holding the lock, present only for adapters whose
   * lock lives in an open transaction. Closed by {@link releaseMigrationLock}.
   */
  lockClient?: MigrationLockClient;
}

/**
 * Take the migration lock, on a DEDICATED connection when the adapter needs one.
 *
 * The CockroachDB and YugabyteDB adapters lock a row in `_turbine_lock` with
 * `SELECT ... FOR UPDATE NOWAIT` and deliberately leave that transaction OPEN,
 * because a row lock only exists for as long as its transaction does. The runner
 * then applies every migration on the SAME connection, and
 * `runMigrationInTransaction` issues BEGIN ... COMMIT per file. That COMMIT ends
 * the LOCK's transaction: from migration 2 onward the run was unprotected, a
 * concurrent `turbine migrate` could take the lock and replay those files, and
 * `releaseLock`'s later COMMIT was a no-op that warned rather than failed, so
 * nothing surfaced. The same collision had a second face: a
 * `-- turbine:no-transaction` migration running FIRST executed inside the still
 * open lock transaction, so `CREATE INDEX CONCURRENTLY` failed with "cannot run
 * inside a transaction block" while the identical file placed second succeeded.
 *
 * A second connection separates the two transaction scopes, which is the only
 * thing that makes the lock outlive a migration. The advisory-lock path (plain
 * Postgres, AlloyDB, Timescale) is session-scoped rather than
 * transaction-scoped, opens NO second connection, and is byte-identical to what
 * it has always done.
 *
 * @internal exported for tests.
 */
export async function acquireMigrationLock(
  runner: MigrationLockClient,
  lockId: number,
  adapter: DatabaseAdapter | undefined,
  openLockConnection: () => Promise<MigrationLockClient>,
): Promise<MigrationLock> {
  const a = adapter ?? postgresql;
  const lockClient = a.lockHoldsOpenTransaction ? await openLockConnection() : undefined;
  try {
    // pg.Client satisfies PgCompatPoolClient (query + release)
    const acquired = await a.acquireLock(
      (lockClient ?? runner) as unknown as import('../client.js').PgCompatPoolClient,
      lockId,
    );
    if (!acquired && lockClient) await lockClient.end();
    return { acquired, lockId, adapter: a, lockClient: acquired ? lockClient : undefined };
  } catch (err) {
    if (lockClient) {
      try {
        await lockClient.end();
      } catch {
        // Best effort: the acquire error below is what the user needs to see.
      }
    }
    throw err;
  }
}

/**
 * Release a lock taken by {@link acquireMigrationLock}, and close the dedicated
 * connection when there is one. A refused lock owns nothing, so releasing it is
 * a no-op rather than an unlock of somebody else's lock.
 *
 * @internal exported for tests.
 */
export async function releaseMigrationLock(lock: MigrationLock, runner: MigrationLockClient): Promise<void> {
  if (!lock.acquired) return;
  try {
    await lock.adapter.releaseLock(
      (lock.lockClient ?? runner) as unknown as import('../client.js').PgCompatPoolClient,
      lock.lockId,
    );
  } finally {
    if (lock.lockClient) await lock.lockClient.end();
  }
}

// ---------------------------------------------------------------------------
// Transactional migration body
// ---------------------------------------------------------------------------

/**
 * The minimal query surface a transactional migration body needs.
 * `pg.Client` satisfies it; tests supply a fake.
 */
export interface MigrationTxClient {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

/**
 * Run one migration body (UP or DOWN) plus its tracking-table write inside a
 * single transaction. Returns `null` on success, or the error message on
 * failure, leaving the caller to record it and stop.
 *
 * The ROLLBACK is best-effort: if the connection died, ROLLBACK throws too, and
 * letting that escape would replace the real migration failure with a
 * connection error. Same guard as `client.ts`, `query/builder.ts`, `dialect.ts`.
 *
 * @internal exported for tests; not part of the CLI's public surface.
 */
export async function runMigrationInTransaction(
  client: MigrationTxClient,
  body: string,
  tracking: { sql: string; params: unknown[] },
): Promise<string | null> {
  try {
    await client.query('BEGIN');
    await client.query(body);
    await client.query(tracking.sql, tracking.params);
    await client.query('COMMIT');
    return null;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Best effort: the original error below is what the user needs to see.
    }
    return err instanceof Error ? err.message : String(err);
  }
}

// ---------------------------------------------------------------------------
// Checksum validation
// ---------------------------------------------------------------------------

export interface ChecksumMismatch {
  name: string;
  expected: string;
  actual: string;
  /** 'modified' if file changed, 'missing' if file deleted */
  type: 'modified' | 'missing';
}

export interface MigrationDeployPlan {
  pending: MigrationFile[];
  mismatches: ChecksumMismatch[];
}

/**
 * Validate that applied migration files have not been modified or deleted since they were run.
 * Returns an array of mismatched migrations (empty if all are clean).
 *
 * @internal exported for tests; not part of the CLI's public surface.
 */
export async function validateChecksums(
  client: pg.Client,
  migrationsDir: string,
  dialect: Dialect = postgresDialect,
): Promise<ChecksumMismatch[]> {
  const applied = await getAppliedMigrations(client, dialect);
  const allFiles = listMigrationFiles(migrationsDir);
  const fileMap = new Map(allFiles.map((f) => [f.name, f]));
  const mismatches: ChecksumMismatch[] = [];

  for (const migration of applied) {
    const file = fileMap.get(migration.name);
    if (!file) {
      mismatches.push({
        name: migration.name,
        expected: migration.checksum,
        actual: '',
        type: 'missing',
      });
      continue;
    }
    const content = readFileSync(file.path, 'utf-8');
    const currentHash = checksum(content);
    if (currentHash !== migration.checksum) {
      // Auto-upgrade a pre-v0.6 checksum to SHA-256 without flagging it as
      // modified, but ONLY when the legacy hash of the current content still
      // matches what was stored. A legacy row whose file HAS changed falls
      // through to the mismatch path below (bypassable with --allow-drift).
      if (canUpgradeLegacyChecksum(migration.checksum, content)) {
        await client.query(dialect.buildMigrationUpdateChecksum(quotedTrackingTable(dialect)), [
          currentHash,
          migration.name,
        ]);
        continue;
      }
      mismatches.push({
        name: migration.name,
        expected: migration.checksum,
        actual: currentHash,
        type: 'modified',
      });
    }
  }

  return mismatches;
}

export function formatChecksumMismatchError(mismatches: ChecksumMismatch[]): string {
  const modified = mismatches.filter((m) => m.type === 'modified');
  const missing = mismatches.filter((m) => m.type === 'missing');
  const lines: string[] = [
    '[turbine] Migration drift detected, refusing to apply pending migrations.',
    '',
    'Applied migrations should be immutable. The following files no longer match their applied state:',
    '',
  ];
  for (const m of modified) {
    lines.push(`  - ${m.name}.sql  (modified on disk)`);
  }
  for (const m of missing) {
    lines.push(`  - ${m.name}.sql  (deleted from disk)`);
  }
  lines.push('');
  lines.push('Fix one of these:');
  lines.push('  1. Restore the file(s) to their original content, OR');
  if (modified.length > 0) {
    // `migrate down` needs the file on disk to read its DOWN section, so it is
    // only a remedy for MODIFIED files, never for deleted ones.
    lines.push('  2. Roll back the affected migrations with `npx turbine migrate down` (modified files only), OR');
  }
  if (missing.length > 0) {
    lines.push('     (deleted files cannot be rolled back: restore the file, then run `migrate down` if needed), OR');
  }
  lines.push('  3. Pass `--allow-drift` to bypass this check (advanced, make sure you know what you are doing).');
  return lines.join('\n');
}

/**
 * Build a deploy plan from local migration files and applied migration rows.
 * This is pure file-system planning; callers with a database connection should
 * use `inspectMigrationDeploy()` to preserve legacy checksum upgrades.
 */
export function planMigrationDeploy(migrationsDir: string, applied: AppliedMigration[]): MigrationDeployPlan {
  const allFiles = listMigrationFiles(migrationsDir);
  const fileMap = new Map(allFiles.map((f) => [f.name, f]));
  const appliedNames = new Set(applied.map((m) => m.name));
  const mismatches: ChecksumMismatch[] = [];

  for (const migration of applied) {
    const file = fileMap.get(migration.name);
    if (!file) {
      mismatches.push({
        name: migration.name,
        expected: migration.checksum,
        actual: '',
        type: 'missing',
      });
      continue;
    }

    const content = readFileSync(file.path, 'utf-8');
    const currentHash = checksum(content);
    // A pre-v0.6 checksum is only forgiven when the legacy algorithm over the
    // current content still reproduces it: otherwise the file really has drifted.
    if (currentHash !== migration.checksum && !canUpgradeLegacyChecksum(migration.checksum, content)) {
      mismatches.push({
        name: migration.name,
        expected: migration.checksum,
        actual: currentHash,
        type: 'modified',
      });
    }
  }

  return {
    pending: allFiles.filter((f) => !appliedNames.has(f.name)),
    mismatches,
  };
}

/**
 * Inspect deploy status without applying migrations.
 */
export async function inspectMigrationDeploy(
  connectionString: string,
  migrationsDir: string,
): Promise<MigrationDeployPlan> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const dialect = migrationDialect();

  try {
    await ensureTrackingTable(client, dialect);
    const mismatches = await validateChecksums(client, migrationsDir, dialect);
    const applied = await getAppliedMigrations(client, dialect);
    const appliedNames = new Set(applied.map((m) => m.name));
    return {
      pending: listMigrationFiles(migrationsDir).filter((f) => !appliedNames.has(f.name)),
      mismatches,
    };
  } finally {
    await client.end();
  }
}

/**
 * Apply all pending migrations (UP).
 *
 * Features:
 * - Idempotent: running twice is safe (already-applied migrations are skipped)
 * - Advisory lock: prevents concurrent migration runs
 * - Checksum validation: detects modified migration files (BLOCKING, use
 *   `allowDrift: true` to bypass when intentionally rewriting history)
 * - Each migration runs in its own transaction
 *
 * Throws `MigrationError` if any applied migration has been modified or deleted
 * on disk, listing the offending files. Pass `{ allowDrift: true }` to bypass
 * this check (the CLI exposes this as `--allow-drift`).
 */
export async function migrateUp(
  connectionString: string,
  migrationsDir: string,
  options?: {
    step?: number;
    allowDrift?: boolean;
    force?: boolean /** @deprecated use allowDrift */;
    /** Run migrations even when they contain data-destroying statements. Default false. */
    allowDestructive?: boolean;
    adapter?: DatabaseAdapter;
    /**
     * Called right before a `-- turbine:no-transaction` migration runs, so the
     * CLI can print its loud pre-run notice (a concurrent index build can wait a
     * long time on other transactions and otherwise looks hung).
     */
    onNoTransaction?: (file: MigrationFile) => void;
  },
): Promise<MigrationRunResult> {
  const client = new pg.Client({ connectionString });
  await client.connect();

  // Treat `force` as an alias for `allowDrift` for backwards compatibility.
  const allowDrift = options?.allowDrift === true || options?.force === true;
  const dialect = migrationDialect();

  try {
    // Derive an advisory lock ID per-database so concurrent migrations in
    // sibling databases on the same Postgres cluster do not contend.
    const dbName = await getCurrentDatabaseName(client);
    const lockId = deriveLockId(dbName);

    // Acquire lock to prevent concurrent migrations.
    // The adapter determines the strategy (advisory lock vs table lock), and a
    // table-lock adapter gets its OWN connection so the per-migration
    // BEGIN/COMMIT below cannot end the transaction the lock lives in.
    const adapter = options?.adapter;
    const lock = await acquireMigrationLock(client, lockId, adapter, () => openLockConnection(connectionString));
    if (!lock.acquired) {
      throw new MigrationError('[turbine] Could not acquire migration lock, another migration is already running');
    }

    try {
      await ensureTrackingTable(client, dialect);

      // Validate checksums of already-applied migrations.
      // Drift = an APPLIED migration's on-disk file has changed (or been deleted)
      // since it was run. Either situation means the database state and the
      // migration history no longer agree, so we BLOCK the run by default.
      // Users can pass `allowDrift: true` (CLI: `--allow-drift`) to force past
      // the block when they are intentionally rewriting history.
      if (!allowDrift) {
        const mismatches = await validateChecksums(client, migrationsDir, dialect);
        if (mismatches.length > 0) {
          throw new MigrationError(formatChecksumMismatchError(mismatches));
        }
      }

      const applied = await getAppliedMigrations(client, dialect);
      const appliedNames = new Set(applied.map((m) => m.name));

      // Newest already-applied timestamp. Anything applied below this line is
      // going in out of order (an older migration created/applied after a newer
      // one). Used to surface a warning; never blocks.
      const newestPrior = applied
        .map((m) => ({ ts: migrationTimestamp(m.name), name: m.name }))
        .filter((m): m is { ts: string; name: string } => m.ts !== null)
        .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))[0];

      const allFiles = listMigrationFiles(migrationsDir);
      let pending = allFiles.filter((f) => !appliedNames.has(f.name));

      if (options?.step != null && options.step > 0) {
        pending = pending.slice(0, options.step);
      }

      // Structural check before any policy gate: a file that manages its own
      // transactions cannot be run safely at all, so it is refused for everyone,
      // deploy included. Pre-flight over the whole batch, so nothing is applied.
      assertNoEmbeddedTransactions(pending, 'up');

      // Destructive statements in the pending batch, computed once. Returned in
      // the result regardless of the gate so `deploy` can print a notice even
      // though it proceeds by design.
      const destructive = collectUpDestructive(pending);

      // Data-loss gate: refuse to run pending migrations containing destructive
      // statements unless the caller has EXPLICITLY opted in. The CLI layers an
      // interactive typed confirmation on top of this; programmatic callers must
      // pass `allowDestructive: true`. Safe-by-default is the whole point, a
      // DROP TABLE should never run just because a file exists.
      if (!options?.allowDestructive && destructive.length > 0) {
        const lines = ['[turbine] Refusing to apply migrations containing DESTRUCTIVE statements:', ''];
        for (const o of destructive) {
          lines.push(`  ${o.file}`);
          for (const h of o.hits) {
            lines.push(`    - [${h.kind}] ${h.target}: ${DESTRUCTIVE_KIND_LABEL[h.kind]}`);
          }
        }
        lines.push('');
        lines.push('Review the statements above. To proceed: run `npx turbine migrate up` interactively');
        lines.push('and confirm, pass --allow-destructive, or set allowDestructive: true programmatically.');
        throw new MigrationError(lines.join('\n'));
      }

      const results: MigrationFile[] = [];
      const errors: Array<{ file: MigrationFile; error: string }> = [];
      const outOfOrder: OutOfOrderApply[] = [];
      const noTransactionApplied: MigrationFile[] = [];

      const flagOutOfOrder = (file: MigrationFile): void => {
        // Flag an out-of-order apply: this file's timestamp is older than a
        // migration that was already applied before this run started.
        if (newestPrior && file.timestamp && file.timestamp < newestPrior.ts) {
          outOfOrder.push({ applied: file.filename, newestPrior: `${newestPrior.name}.sql` });
        }
      };

      for (const file of pending) {
        const parsed = parseMigrationSQL(file.path);
        const up = parsed.up;
        if (!up) {
          // STOP, do not skip. Continuing applied later migrations over the gap
          // this one left, which is the same hazard as continuing past a SQL
          // failure: the batch is ordered, and a later file may depend on this
          // one. The SQL-failure path below has always broken here.
          errors.push({ file, error: 'No UP section found in migration file' });
          break;
        }

        const content = readFileSync(file.path, 'utf-8');
        const hash = checksum(content);
        const insertApplied = dialect.buildMigrationInsertApplied(quotedTrackingTable(dialect));

        if (parsed.noTransaction) {
          // No BEGIN/COMMIT: run ONE statement per query() call (a multi-statement
          // simple query would be wrapped in an implicit transaction, breaking
          // CREATE INDEX CONCURRENTLY). Recording happens only after all statements
          // succeed: a mid-file failure leaves earlier (idempotent) statements
          // applied and the migration unrecorded, so a rerun resumes it.
          options?.onNoTransaction?.(file);
          noTransactionApplied.push(file);
          try {
            for (const stmt of splitSqlStatements(up)) {
              await client.query(stmt);
            }
            await client.query(insertApplied, [file.name, hash]);
            results.push(file);
            flagOutOfOrder(file);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push({ file, error: msg });
            break;
          }
          continue;
        }

        const failure = await runMigrationInTransaction(client, up, {
          sql: insertApplied,
          params: [file.name, hash],
        });
        if (failure !== null) {
          errors.push({ file, error: failure });
          // Stop on first error
          break;
        }
        results.push(file);
        flagOutOfOrder(file);
      }

      return { applied: results, errors, destructive, outOfOrder, noTransaction: noTransactionApplied };
    } finally {
      await releaseMigrationLock(lock, client);
    }
  } finally {
    await client.end();
  }
}

/**
 * Production migration apply. This intentionally applies files as written and
 * never performs interactive destructive confirmation.
 */
export async function migrateDeploy(
  connectionString: string,
  migrationsDir: string,
  options?: { adapter?: DatabaseAdapter; allowDrift?: boolean },
): Promise<MigrationRunResult> {
  return migrateUp(connectionString, migrationsDir, {
    // Honor `--allow-drift` on deploy exactly as `up` does: deploy's own drift
    // error recommends this flag, so it must actually bypass the checksum block.
    allowDrift: options?.allowDrift === true,
    allowDestructive: true,
    adapter: options?.adapter,
  });
}

/**
 * Roll back a prepared LIFO batch, newest first, stopping at the first
 * migration that cannot be rolled back.
 *
 * A rollback batch is strictly LIFO and must have NO GAPS. The
 * "file not found" and "no DOWN section" branches used to `continue`, so a
 * `--step 3` whose middle migration had no DOWN section rolled back 3 and then
 * 1: the oldest migration's schema was torn down while the data migration 2 had
 * seeded into it was still expected to exist, and the tracking table was left
 * claiming migration 2 alone was applied. The next `migrate up` then re-ran 1
 * and 3 and never re-ran 2, so that data was gone permanently. Both branches
 * now stop, which is what the SQL-failure branches have always done.
 *
 * Split out of {@link migrateDown} so the ordering contract is testable against
 * a fake client, without a database.
 *
 * @internal exported for tests; not part of the CLI's public surface.
 */
export async function rollbackMigrations(
  client: MigrationTxClient,
  toRollback: Array<{ name: string }>,
  fileMap: Map<string, MigrationFile>,
  deleteApplied: string,
): Promise<{ rolledBack: MigrationFile[]; errors: Array<{ file: MigrationFile; error: string }> }> {
  const results: MigrationFile[] = [];
  const errors: Array<{ file: MigrationFile; error: string }> = [];

  for (const migration of toRollback) {
    const file = fileMap.get(migration.name);
    if (!file) {
      errors.push({
        file: { filename: `${migration.name}.sql`, path: '', name: migration.name, timestamp: '' },
        error: `Migration file not found for "${migration.name}"`,
      });
      break;
    }

    const parsed = parseMigrationSQL(file.path);
    const down = parsed.down;
    if (!down) {
      errors.push({ file, error: 'No DOWN section found in migration file' });
      break;
    }

    if (parsed.noTransaction) {
      // Untransacted rollback (DROP INDEX CONCURRENTLY IF EXISTS), one
      // statement per query() call: same contract as the untransacted UP.
      try {
        for (const stmt of splitSqlStatements(down)) {
          await client.query(stmt);
        }
        await client.query(deleteApplied, [migration.name]);
        results.push(file);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push({ file, error: msg });
        break;
      }
      continue;
    }

    const failure = await runMigrationInTransaction(client, down, {
      sql: deleteApplied,
      params: [migration.name],
    });
    if (failure !== null) {
      errors.push({ file, error: failure });
      break;
    }
    results.push(file);
  }

  return { rolledBack: results, errors };
}

/**
 * Rollback the last N migrations (DOWN).
 *
 * Features:
 * - Advisory lock: prevents concurrent rollback runs
 * - Each rollback runs in its own transaction
 * - Properly reverses changes in reverse application order
 */
export async function migrateDown(
  connectionString: string,
  migrationsDir: string,
  options?: { step?: number; allowDestructive?: boolean; adapter?: DatabaseAdapter },
): Promise<{ rolledBack: MigrationFile[]; errors: Array<{ file: MigrationFile; error: string }> }> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const dialect = migrationDialect();

  try {
    // Derive a per-database advisory lock ID so concurrent migrations in
    // sibling databases on the same cluster do not contend.
    const dbName = await getCurrentDatabaseName(client);
    const lockId = deriveLockId(dbName);

    const adapter = options?.adapter;
    const lock = await acquireMigrationLock(client, lockId, adapter, () => openLockConnection(connectionString));
    if (!lock.acquired) {
      throw new MigrationError('[turbine] Could not acquire migration lock, another migration is already running');
    }

    try {
      await ensureTrackingTable(client, dialect);
      const applied = await getAppliedMigrations(client, dialect);

      if (applied.length === 0) {
        return { rolledBack: [], errors: [] };
      }

      const allFiles = listMigrationFiles(migrationsDir);
      const fileMap = new Map(allFiles.map((f) => [f.name, f]));

      // Reverse order, rollback most recent first
      const toRollback = applied.reverse().slice(0, options?.step ?? 1);

      // Same structural pre-flight as migrateUp: a DOWN body is wrapped in the
      // same single transaction, so it cannot manage its own either.
      assertNoEmbeddedTransactions(
        toRollback.map((m) => fileMap.get(m.name)).filter((f): f is MigrationFile => f !== undefined),
        'down',
      );

      // Same data-loss gate as migrateUp, DOWN sections routinely contain
      // DROP TABLE (the legitimate reverse of a CREATE), which still destroys
      // every row written since the migration ran. Explicit opt-in required.
      if (!options?.allowDestructive) {
        const offenders: Array<{ file: string; hits: DestructiveStatement[] }> = [];
        for (const migration of toRollback) {
          const file = fileMap.get(migration.name);
          if (!file) continue;
          const { down } = parseMigrationSQL(file.path);
          if (!down) continue;
          const hits = scanDestructiveSql(down);
          if (hits.length > 0) offenders.push({ file: file.filename, hits });
        }
        if (offenders.length > 0) {
          const lines = ['[turbine] Refusing to roll back migrations whose DOWN sections are DESTRUCTIVE:', ''];
          for (const o of offenders) {
            lines.push(`  ${o.file}`);
            for (const h of o.hits) {
              lines.push(`    - [${h.kind}] ${h.target}: ${DESTRUCTIVE_KIND_LABEL[h.kind]}`);
            }
          }
          lines.push('');
          lines.push('To proceed: run `npx turbine migrate down` interactively and confirm, pass');
          lines.push('--allow-destructive, or set allowDestructive: true programmatically.');
          throw new MigrationError(lines.join('\n'));
        }
      }

      return await rollbackMigrations(
        client,
        toRollback,
        fileMap,
        dialect.buildMigrationDeleteApplied(quotedTrackingTable(dialect)),
      );
    } finally {
      await releaseMigrationLock(lock, client);
    }
  } finally {
    await client.end();
  }
}

/**
 * Get the status of all migrations (applied vs pending).
 *
 * Applied rows carry `checksumValid`, decided by {@link isChecksumValid} so an
 * unchanged pre-v0.6 row reports the same way `migrate up` treats it (valid,
 * pending an in-place hash upgrade) rather than looking like drift.
 */
export async function migrateStatus(connectionString: string, migrationsDir: string): Promise<MigrationStatus[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const dialect = migrationDialect();

  try {
    await ensureTrackingTable(client, dialect);
    const applied = await getAppliedMigrations(client, dialect);
    const appliedMap = new Map(applied.map((m) => [m.name, m]));

    const allFiles = listMigrationFiles(migrationsDir);
    const fileNames = new Set(allFiles.map((f) => f.name));

    const fromFiles = allFiles.map((file) => {
      const record = appliedMap.get(file.name);
      let checksumValid: boolean | undefined;

      if (record) {
        checksumValid = isChecksumValid(record.checksum, readFileSync(file.path, 'utf-8'));
      }

      return {
        file,
        applied: !!record,
        appliedAt: record?.applied_at,
        checksumValid,
      };
    });

    // Applied migrations whose file was deleted from disk. up/deploy already
    // catch this as drift; status must not silently drop them from history.
    const missing: MigrationStatus[] = applied
      .filter((m) => !fileNames.has(m.name))
      .map((m) => ({
        file: parseMigrationFilename(`${m.name}.sql`) ?? {
          filename: `${m.name}.sql`,
          path: '',
          name: m.name,
          timestamp: '',
        },
        applied: true,
        appliedAt: m.applied_at,
        checksumValid: false,
        missingFile: true,
      }));

    // Keep the overall list in timestamp order so a deleted entry appears where
    // it belongs in history, not tacked on at the end.
    return [...fromFiles, ...missing].sort((a, b) =>
      a.file.name < b.file.name ? -1 : a.file.name > b.file.name ? 1 : 0,
    );
  } finally {
    await client.end();
  }
}
