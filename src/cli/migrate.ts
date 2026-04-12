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
import { MigrationError } from '../errors.js';
import { quoteIdent } from '../query/index.js';

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
}

// ---------------------------------------------------------------------------
// Tracking table management
// ---------------------------------------------------------------------------

const TRACKING_TABLE = '_turbine_migrations';
const QUOTED_TRACKING_TABLE = quoteIdent(TRACKING_TABLE);

const CREATE_TRACKING_TABLE = `
  CREATE TABLE IF NOT EXISTS ${QUOTED_TRACKING_TABLE} (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    checksum TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

async function ensureTrackingTable(client: pg.Client): Promise<void> {
  await client.query(CREATE_TRACKING_TABLE);
}

async function getAppliedMigrations(client: pg.Client): Promise<AppliedMigration[]> {
  await ensureTrackingTable(client);
  const result = await client.query<AppliedMigration>(
    `SELECT id, name, applied_at, checksum FROM ${QUOTED_TRACKING_TABLE} ORDER BY id ASC`,
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
// Commands
// ---------------------------------------------------------------------------

/**
 * Create a new migration file.
 * If `autoContent` is provided, the UP/DOWN sections are pre-populated with the given SQL.
 */
export function createMigration(
  migrationsDir: string,
  name: string,
  autoContent?: { up: string; down: string },
): MigrationFile {
  mkdirSync(migrationsDir, { recursive: true });

  const now = new Date();
  const ts = formatTimestamp(now);
  const safeName = sanitizeName(name);

  const filename = `${ts}_${safeName}.sql`;
  const filePath = join(migrationsDir, filename);

  let template: string;
  if (autoContent) {
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

async function acquireLock(client: pg.Client, lockId: number): Promise<boolean> {
  const result = await client.query<{ locked: boolean }>(`SELECT pg_try_advisory_lock($1) AS locked`, [lockId]);
  return result.rows[0]?.locked ?? false;
}

async function releaseLock(client: pg.Client, lockId: number): Promise<void> {
  await client.query(`SELECT pg_advisory_unlock($1)`, [lockId]);
}

// ---------------------------------------------------------------------------
// Checksum validation
// ---------------------------------------------------------------------------

interface ChecksumMismatch {
  name: string;
  expected: string;
  actual: string;
  /** 'modified' if file changed, 'missing' if file deleted */
  type: 'modified' | 'missing';
}

/**
 * Validate that applied migration files have not been modified or deleted since they were run.
 * Returns an array of mismatched migrations (empty if all are clean).
 */
async function validateChecksums(client: pg.Client, migrationsDir: string): Promise<ChecksumMismatch[]> {
  const applied = await getAppliedMigrations(client);
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
        await client.query(`UPDATE ${QUOTED_TRACKING_TABLE} SET checksum = $1 WHERE name = $2`, [
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
  options?: { step?: number; allowDrift?: boolean /** @deprecated use allowDrift */; force?: boolean },
): Promise<{ applied: MigrationFile[]; errors: Array<{ file: MigrationFile; error: string }> }> {
  const client = new pg.Client({ connectionString });
  await client.connect();

  // Treat `force` as an alias for `allowDrift` for backwards compatibility.
  const allowDrift = options?.allowDrift === true || options?.force === true;

  try {
    // Derive an advisory lock ID per-database so concurrent migrations in
    // sibling databases on the same Postgres cluster do not contend.
    const dbName = await getCurrentDatabaseName(client);
    const lockId = deriveLockId(dbName);

    // Acquire advisory lock to prevent concurrent migrations
    const gotLock = await acquireLock(client, lockId);
    if (!gotLock) {
      throw new MigrationError('[turbine] Could not acquire migration lock — another migration is already running');
    }

    try {
      await ensureTrackingTable(client);

      // Validate checksums of already-applied migrations.
      // Drift = an APPLIED migration's on-disk file has changed (or been deleted)
      // since it was run. Either situation means the database state and the
      // migration history no longer agree, so we BLOCK the run by default.
      // Users can pass `allowDrift: true` (CLI: `--allow-drift`) to force past
      // the block when they are intentionally rewriting history.
      if (!allowDrift) {
        const mismatches = await validateChecksums(client, migrationsDir);
        if (mismatches.length > 0) {
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
          lines.push('  2. Roll back the affected migrations with `npx turbine migrate down`, OR');
          lines.push(
            '  3. Pass `--allow-drift` to bypass this check (advanced — make sure you know what you are doing).',
          );
          throw new MigrationError(lines.join('\n'));
        }
      }

      const applied = await getAppliedMigrations(client);
      const appliedNames = new Set(applied.map((m) => m.name));

      const allFiles = listMigrationFiles(migrationsDir);
      let pending = allFiles.filter((f) => !appliedNames.has(f.name));

      if (options?.step != null && options.step > 0) {
        pending = pending.slice(0, options.step);
      }

      const results: MigrationFile[] = [];
      const errors: Array<{ file: MigrationFile; error: string }> = [];

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
          await client.query(
            `INSERT INTO ${QUOTED_TRACKING_TABLE} (name, checksum) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING`,
            [file.name, hash],
          );
          await client.query('COMMIT');
          results.push(file);
        } catch (err) {
          await client.query('ROLLBACK');
          const msg = err instanceof Error ? err.message : String(err);
          errors.push({ file, error: msg });
          // Stop on first error
          break;
        }
      }

      return { applied: results, errors };
    } finally {
      await releaseLock(client, lockId);
    }
  } finally {
    await client.end();
  }
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
  options?: { step?: number },
): Promise<{ rolledBack: MigrationFile[]; errors: Array<{ file: MigrationFile; error: string }> }> {
  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    // Derive a per-database advisory lock ID so concurrent migrations in
    // sibling databases on the same cluster do not contend.
    const dbName = await getCurrentDatabaseName(client);
    const lockId = deriveLockId(dbName);

    const gotLock = await acquireLock(client, lockId);
    if (!gotLock) {
      throw new MigrationError('[turbine] Could not acquire migration lock — another migration is already running');
    }

    try {
      await ensureTrackingTable(client);
      const applied = await getAppliedMigrations(client);

      if (applied.length === 0) {
        return { rolledBack: [], errors: [] };
      }

      const allFiles = listMigrationFiles(migrationsDir);
      const fileMap = new Map(allFiles.map((f) => [f.name, f]));

      // Reverse order — rollback most recent first
      const toRollback = applied.reverse().slice(0, options?.step ?? 1);

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
          await client.query(`DELETE FROM ${QUOTED_TRACKING_TABLE} WHERE name = $1`, [migration.name]);
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
      await releaseLock(client, lockId);
    }
  } finally {
    await client.end();
  }
}

/**
 * Get the status of all migrations (applied vs pending).
 * Includes checksum validation for applied migrations.
 */
export async function migrateStatus(connectionString: string, migrationsDir: string): Promise<MigrationStatus[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    await ensureTrackingTable(client);
    const applied = await getAppliedMigrations(client);
    const appliedMap = new Map(applied.map((m) => [m.name, m]));

    const allFiles = listMigrationFiles(migrationsDir);

    return allFiles.map((file) => {
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
  } finally {
    await client.end();
  }
}
