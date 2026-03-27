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

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import pg from 'pg';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MigrationFile {
  /** Full filename (e.g. "20260325_001_create_users.sql") */
  filename: string;
  /** Absolute path to the file */
  path: string;
  /** Extracted name portion (e.g. "create_users") */
  name: string;
  /** Timestamp prefix (e.g. "20260325") */
  timestamp: string;
  /** Sequence number (e.g. "001") */
  sequence: string;
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

const CREATE_TRACKING_TABLE = `
  CREATE TABLE IF NOT EXISTS ${TRACKING_TABLE} (
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
    `SELECT id, name, applied_at, checksum FROM ${TRACKING_TABLE} ORDER BY id ASC`,
  );
  return result.rows;
}

// ---------------------------------------------------------------------------
// File operations
// ---------------------------------------------------------------------------

/**
 * Parse a migration filename into its components.
 * Expected format: YYYYMMDD_NNN_description.sql
 */
function parseMigrationFilename(filename: string): MigrationFile | null {
  const match = filename.match(/^(\d{8})_(\d{3})_(.+)\.sql$/);
  if (!match) return null;
  return {
    filename,
    path: '', // Set by caller
    name: filename.replace(/\.sql$/, ''),
    timestamp: match[1]!,
    sequence: match[2]!,
  };
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
 * Parse a migration file into UP and DOWN sections.
 */
export function parseMigrationSQL(filePath: string): { up: string; down: string } {
  const content = readFileSync(filePath, 'utf-8');
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
 * Simple checksum for a migration file (for drift detection).
 */
function checksum(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const chr = content.charCodeAt(i);
    hash = ((hash << 5) - hash + chr) | 0;
  }
  return Math.abs(hash).toString(36);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Create a new migration file.
 */
export function createMigration(
  migrationsDir: string,
  name: string,
): MigrationFile {
  mkdirSync(migrationsDir, { recursive: true });

  // Get today's date as YYYYMMDD
  const now = new Date();
  const datePart = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('');

  // Find the next sequence number for today
  const existing = listMigrationFiles(migrationsDir);
  const todayMigrations = existing.filter((f) => f.timestamp === datePart);
  const nextSeq = String(todayMigrations.length + 1).padStart(3, '0');

  // Sanitize name: lowercase, replace spaces/special chars with underscores
  const safeName = name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');

  const filename = `${datePart}_${nextSeq}_${safeName}.sql`;
  const filePath = join(migrationsDir, filename);

  const template = `-- UP
-- Write your migration SQL here


-- DOWN
-- Write the rollback SQL here

`;

  writeFileSync(filePath, template, 'utf-8');

  return {
    filename,
    path: filePath,
    name: filename.replace(/\.sql$/, ''),
    timestamp: datePart,
    sequence: nextSeq,
  };
}

// ---------------------------------------------------------------------------
// Advisory lock for concurrent migration safety
// ---------------------------------------------------------------------------

/** Fixed lock ID for Turbine migrations — prevents concurrent migrate runs */
const MIGRATION_LOCK_ID = 8_347_291; // arbitrary but stable

async function acquireLock(client: pg.Client): Promise<boolean> {
  const result = await client.query<{ pg_try_advisory_lock: boolean }>(
    `SELECT pg_try_advisory_lock($1)`,
    [MIGRATION_LOCK_ID],
  );
  return result.rows[0]?.pg_try_advisory_lock ?? false;
}

async function releaseLock(client: pg.Client): Promise<void> {
  await client.query(`SELECT pg_advisory_unlock($1)`, [MIGRATION_LOCK_ID]);
}

// ---------------------------------------------------------------------------
// Checksum validation
// ---------------------------------------------------------------------------

/**
 * Validate that applied migration files have not been modified since they were run.
 * Returns an array of mismatched migrations (empty if all are clean).
 */
async function validateChecksums(
  client: pg.Client,
  migrationsDir: string,
): Promise<Array<{ name: string; expected: string; actual: string }>> {
  const applied = await getAppliedMigrations(client);
  const allFiles = listMigrationFiles(migrationsDir);
  const fileMap = new Map(allFiles.map((f) => [f.name, f]));
  const mismatches: Array<{ name: string; expected: string; actual: string }> = [];

  for (const migration of applied) {
    const file = fileMap.get(migration.name);
    if (!file) continue; // file deleted — not a checksum issue
    const content = readFileSync(file.path, 'utf-8');
    const currentHash = checksum(content);
    if (currentHash !== migration.checksum) {
      mismatches.push({
        name: migration.name,
        expected: migration.checksum,
        actual: currentHash,
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
 * - Checksum validation: detects modified migration files
 * - Each migration runs in its own transaction
 */
export async function migrateUp(
  connectionString: string,
  migrationsDir: string,
  options?: { step?: number },
): Promise<{ applied: MigrationFile[]; errors: Array<{ file: MigrationFile; error: string }> }> {
  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    // Acquire advisory lock to prevent concurrent migrations
    const gotLock = await acquireLock(client);
    if (!gotLock) {
      return {
        applied: [],
        errors: [{
          file: { filename: '', path: '', name: '', timestamp: '', sequence: '' },
          error: 'Could not acquire migration lock — another migration is already running',
        }],
      };
    }

    try {
      await ensureTrackingTable(client);

      // Validate checksums of already-applied migrations
      const mismatches = await validateChecksums(client, migrationsDir);
      if (mismatches.length > 0) {
        const names = mismatches.map((m) => m.name).join(', ');
        return {
          applied: [],
          errors: [{
            file: { filename: '', path: '', name: '', timestamp: '', sequence: '' },
            error: `Checksum mismatch: migration file(s) modified after application: ${names}. This is dangerous — applied migrations should be immutable. Use --force to skip this check.`,
          }],
        };
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
            `INSERT INTO ${TRACKING_TABLE} (name, checksum) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING`,
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
      await releaseLock(client);
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
    const gotLock = await acquireLock(client);
    if (!gotLock) {
      return {
        rolledBack: [],
        errors: [{
          file: { filename: '', path: '', name: '', timestamp: '', sequence: '' },
          error: 'Could not acquire migration lock — another migration is already running',
        }],
      };
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
            file: { filename: migration.name + '.sql', path: '', name: migration.name, timestamp: '', sequence: '' },
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
          await client.query(
            `DELETE FROM ${TRACKING_TABLE} WHERE name = $1`,
            [migration.name],
          );
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
      await releaseLock(client);
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
): Promise<MigrationStatus[]> {
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
