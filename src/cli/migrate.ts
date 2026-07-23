/**
 * turbine-orm CLI — Migration system
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
  /** Timestamp prefix (e.g. "20260325120000") — YYYYMMDDHHMMSS */
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
}

/** Extract the YYYYMMDDHHMMSS timestamp prefix from a migration name, or null. */
export function migrationTimestamp(name: string): string | null {
  const m = name.match(/^(\d{14})(?:_|$)/);
  return m ? m[1]! : null;
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

function quotedTrackingTable(dialect: Dialect): string {
  return dialect.quoteIdentifier(TRACKING_TABLE);
}

async function ensureTrackingTable(client: pg.Client, dialect: Dialect = postgresDialect): Promise<void> {
  await client.query(dialect.buildMigrationTrackingTable(quotedTrackingTable(dialect)));
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
 * Get pending migration files — those not yet applied.
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
 * Parse migration content string into UP and DOWN sections.
 * Exported for unit testing.
 */
export function parseMigrationContent(content: string): { up: string; down: string } {
  const lines = content.split('\n');

  let section: 'none' | 'up' | 'down' = 'none';
  const upLines: string[] = [];
  const downLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim().toUpperCase();
    if (trimmed === '-- UP') {
      section = 'up';
      continue;
    }
    if (trimmed === '-- DOWN') {
      section = 'down';
      continue;
    }

    if (section === 'up') upLines.push(line);
    else if (section === 'down') downLines.push(line);
  }

  return {
    up: upLines.join('\n').trim(),
    down: downLines.join('\n').trim(),
  };
}

/**
 * Parse a migration file into UP and DOWN sections.
 */
export function parseMigrationSQL(filePath: string): { up: string; down: string } {
  const content = readFileSync(filePath, 'utf-8');
  return parseMigrationContent(content);
}

/**
 * SHA-256 checksum for migration drift detection.
 * Returns a hex-encoded hash of the file content.
 */
function checksum(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

/** Detect legacy djb2 checksums (short alphanumeric strings, pre-v0.6) */
function isLegacyChecksum(hash: string): boolean {
  return hash.length < 64;
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
-- into its place, in one transaction so readers never see a missing column.
-- BEGIN;
--   ALTER TABLE "my_table" RENAME COLUMN "old_col" TO "old_col_retired";
--   ALTER TABLE "my_table" RENAME COLUMN "new_col" TO "old_col";
-- COMMIT;`;

  const down = `-- Reverse the Phase 4 atomic swap (only if you ran it).
-- BEGIN;
--   ALTER TABLE "my_table" RENAME COLUMN "old_col" TO "new_col";
--   ALTER TABLE "my_table" RENAME COLUMN "old_col_retired" TO "old_col";
-- COMMIT;
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
 */
export function createMigration(
  migrationsDir: string,
  name: string,
  autoContent?: { up: string; down: string },
  options?: { recipe?: string },
): MigrationFile {
  mkdirSync(migrationsDir, { recursive: true });

  const now = new Date();
  const ts = formatTimestamp(now);
  const safeName = sanitizeName(name);

  const filename = `${ts}_${safeName}.sql`;
  const filePath = join(migrationsDir, filename);

  let template: string;
  if (options?.recipe) {
    const recipe = MIGRATION_RECIPES[options.recipe];
    if (!recipe) {
      const known = Object.keys(MIGRATION_RECIPES).join(', ') || '(none)';
      throw new MigrationError(`[turbine] Unknown migration recipe "${options.recipe}". Available recipes: ${known}`);
    }
    const body = recipe.build(name);
    template = `-- Migration: ${name} (${options.recipe} recipe scaffold)
-- Created: ${now.toISOString()}
-- Fill in the placeholders and review before running: npx turbine migrate up

-- UP
${body.up}

-- DOWN
${body.down}
`;
  } else if (autoContent) {
    template = `-- Migration: ${name} (auto-generated from schema diff)
-- Created: ${now.toISOString()}
-- Review this file before running: npx turbine migrate up

-- UP
${autoContent.up}

-- DOWN
${autoContent.down}
`;
  } else {
    template = `-- Migration: ${name}
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
 * Uses FNV-1a 32-bit hash — a well-known, stable, non-cryptographic hash with
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

async function acquireLock(client: pg.Client, lockId: number, adapter?: DatabaseAdapter): Promise<boolean> {
  const a = adapter ?? postgresql;
  // pg.Client satisfies PgCompatPoolClient (query + release)
  return a.acquireLock(client as unknown as import('../client.js').PgCompatPoolClient, lockId);
}

async function releaseLock(client: pg.Client, lockId: number, adapter?: DatabaseAdapter): Promise<void> {
  const a = adapter ?? postgresql;
  await a.releaseLock(client as unknown as import('../client.js').PgCompatPoolClient, lockId);
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
 */
async function validateChecksums(
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
      // Auto-upgrade legacy djb2 checksums to SHA-256 without flagging as modified
      if (isLegacyChecksum(migration.checksum)) {
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
    '[turbine] Migration drift detected — refusing to apply pending migrations.',
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
  lines.push('  3. Pass `--allow-drift` to bypass this check (advanced — make sure you know what you are doing).');
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

    const currentHash = checksum(readFileSync(file.path, 'utf-8'));
    if (currentHash !== migration.checksum && !isLegacyChecksum(migration.checksum)) {
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
  options?: { dialect?: Dialect },
): Promise<MigrationDeployPlan> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const dialect = options?.dialect ?? postgresDialect;

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
 * - Checksum validation: detects modified migration files (BLOCKING — use
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
    dialect?: Dialect;
  },
): Promise<MigrationRunResult> {
  const client = new pg.Client({ connectionString });
  await client.connect();

  // Treat `force` as an alias for `allowDrift` for backwards compatibility.
  const allowDrift = options?.allowDrift === true || options?.force === true;
  const dialect = options?.dialect ?? postgresDialect;

  try {
    // Derive an advisory lock ID per-database so concurrent migrations in
    // sibling databases on the same Postgres cluster do not contend.
    const dbName = await getCurrentDatabaseName(client);
    const lockId = deriveLockId(dbName);

    // Acquire lock to prevent concurrent migrations.
    // The adapter determines the strategy (advisory lock vs table lock).
    const adapter = options?.adapter;
    const gotLock = await acquireLock(client, lockId, adapter);
    if (!gotLock) {
      throw new MigrationError('[turbine] Could not acquire migration lock — another migration is already running');
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

      // Destructive statements in the pending batch, computed once. Returned in
      // the result regardless of the gate so `deploy` can print a notice even
      // though it proceeds by design.
      const destructive = collectUpDestructive(pending);

      // Data-loss gate: refuse to run pending migrations containing destructive
      // statements unless the caller has EXPLICITLY opted in. The CLI layers an
      // interactive typed confirmation on top of this; programmatic callers must
      // pass `allowDestructive: true`. Safe-by-default is the whole point — a
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

      for (const file of pending) {
        const { up } = parseMigrationSQL(file.path);
        if (!up) {
          errors.push({ file, error: 'No UP section found in migration file' });
          continue;
        }

        const content = readFileSync(file.path, 'utf-8');
        const hash = checksum(content);

        try {
          await client.query('BEGIN');
          await client.query(up);
          await client.query(dialect.buildMigrationInsertApplied(quotedTrackingTable(dialect)), [file.name, hash]);
          await client.query('COMMIT');
          results.push(file);
          // Flag an out-of-order apply: this file's timestamp is older than a
          // migration that was already applied before this run started.
          if (newestPrior && file.timestamp && file.timestamp < newestPrior.ts) {
            outOfOrder.push({ applied: file.filename, newestPrior: `${newestPrior.name}.sql` });
          }
        } catch (err) {
          await client.query('ROLLBACK');
          const msg = err instanceof Error ? err.message : String(err);
          errors.push({ file, error: msg });
          // Stop on first error
          break;
        }
      }

      return { applied: results, errors, destructive, outOfOrder };
    } finally {
      await releaseLock(client, lockId, adapter);
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
  options?: { adapter?: DatabaseAdapter; dialect?: Dialect; allowDrift?: boolean },
): Promise<MigrationRunResult> {
  return migrateUp(connectionString, migrationsDir, {
    // Honor `--allow-drift` on deploy exactly as `up` does: deploy's own drift
    // error recommends this flag, so it must actually bypass the checksum block.
    allowDrift: options?.allowDrift === true,
    allowDestructive: true,
    adapter: options?.adapter,
    dialect: options?.dialect,
  });
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
  options?: { step?: number; allowDestructive?: boolean; adapter?: DatabaseAdapter; dialect?: Dialect },
): Promise<{ rolledBack: MigrationFile[]; errors: Array<{ file: MigrationFile; error: string }> }> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const dialect = options?.dialect ?? postgresDialect;

  try {
    // Derive a per-database advisory lock ID so concurrent migrations in
    // sibling databases on the same cluster do not contend.
    const dbName = await getCurrentDatabaseName(client);
    const lockId = deriveLockId(dbName);

    const adapter = options?.adapter;
    const gotLock = await acquireLock(client, lockId, adapter);
    if (!gotLock) {
      throw new MigrationError('[turbine] Could not acquire migration lock — another migration is already running');
    }

    try {
      await ensureTrackingTable(client, dialect);
      const applied = await getAppliedMigrations(client, dialect);

      if (applied.length === 0) {
        return { rolledBack: [], errors: [] };
      }

      const allFiles = listMigrationFiles(migrationsDir);
      const fileMap = new Map(allFiles.map((f) => [f.name, f]));

      // Reverse order — rollback most recent first
      const toRollback = applied.reverse().slice(0, options?.step ?? 1);

      // Same data-loss gate as migrateUp — DOWN sections routinely contain
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

      const results: MigrationFile[] = [];
      const errors: Array<{ file: MigrationFile; error: string }> = [];

      for (const migration of toRollback) {
        const file = fileMap.get(migration.name);
        if (!file) {
          errors.push({
            file: { filename: `${migration.name}.sql`, path: '', name: migration.name, timestamp: '' },
            error: `Migration file not found for "${migration.name}"`,
          });
          continue;
        }

        const { down } = parseMigrationSQL(file.path);
        if (!down) {
          errors.push({ file, error: 'No DOWN section found in migration file' });
          continue;
        }

        try {
          await client.query('BEGIN');
          await client.query(down);
          await client.query(dialect.buildMigrationDeleteApplied(quotedTrackingTable(dialect)), [migration.name]);
          await client.query('COMMIT');
          results.push(file);
        } catch (err) {
          await client.query('ROLLBACK');
          const msg = err instanceof Error ? err.message : String(err);
          errors.push({ file, error: msg });
          break;
        }
      }

      return { rolledBack: results, errors };
    } finally {
      await releaseLock(client, lockId, adapter);
    }
  } finally {
    await client.end();
  }
}

/**
 * Get the status of all migrations (applied vs pending).
 * Includes checksum validation for applied migrations.
 */
export async function migrateStatus(
  connectionString: string,
  migrationsDir: string,
  options?: { dialect?: Dialect },
): Promise<MigrationStatus[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const dialect = options?.dialect ?? postgresDialect;

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
        const content = readFileSync(file.path, 'utf-8');
        const currentHash = checksum(content);
        checksumValid = currentHash === record.checksum;
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
