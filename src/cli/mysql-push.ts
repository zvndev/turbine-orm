/** Conservative schema push through the ordinary native migration journal. */
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, openSync, readFileSync } from 'node:fs';
import { MigrationError, ValidationError } from '../errors.js';
import type { SchemaDef } from '../schema-builder.js';
import {
  createMigration,
  listIgnoredSqlFiles,
  listMigrationFiles,
  type MigrationFile,
  parseMigrationContent,
} from './migrate.js';
import { type MysqlMigrationDeployPlan, withMysqlMigrationWorkspace } from './mysql-migrate.js';
import { inspectMysqlSchema, type MysqlSchemaPlan, planMysqlSchema } from './mysql-schema.js';
import { modelMysqlSchema } from './mysql-schema-ddl.js';
import { MYSQL_SCHEMA_EXCLUDED, type MysqlCatalogRow, type MysqlSchemaSnapshot } from './mysql-schema-snapshot.js';

export interface MysqlPushOptions {
  /** Exactly one of dryRun or apply must be true. */
  dryRun?: boolean;
  apply?: boolean;
  allowDestructive?: boolean;
}

export interface MysqlPushResult {
  plan: MysqlSchemaPlan;
  file?: MigrationFile;
}

const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

function inventory(dir: string): string {
  if (listIgnoredSqlFiles(dir).length)
    throw new MigrationError('MySQL push refuses ignored SQL files in the migrations directory.');
  return JSON.stringify(listMigrationFiles(dir).map((file) => [file.filename, sha(readFileSync(file.path))]));
}

function clean(history: MysqlMigrationDeployPlan): void {
  if (history.dirty || history.pending.length || history.mismatches.length)
    throw new MigrationError(
      'MySQL push requires clean migration history: dirty, pending, drifted or missing files must be reconciled explicitly first.',
    );
}

// Metadata tables may first appear when the runner initializes its journal.
function catalog(snapshot: MysqlSchemaSnapshot): string {
  const excluded = new Set<string>(MYSQL_SCHEMA_EXCLUDED);
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(snapshot.facts).map(([key, rows]) => [
        key,
        (rows as MysqlCatalogRow[]).filter((row) => !excluded.has(String(row.TABLE_NAME))),
      ]),
    ),
  );
}

function syncPath(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** No preview effects; apply persists one immutable SQL file before journaled execution. */
export async function pushMysqlSchema(
  url: string,
  migrationsDir: string,
  schema: SchemaDef,
  options: MysqlPushOptions,
): Promise<MysqlPushResult> {
  if ((options.dryRun === true) === (options.apply === true))
    throw new ValidationError('MySQL push requires exactly one of --dry-run or --yes (explicit apply).');
  if (typeof migrationsDir !== 'string' || !migrationsDir.trim() || migrationsDir.includes('\0'))
    throw new ValidationError('MySQL push requires a nonempty migrations directory path.');
  modelMysqlSchema(schema);
  return withMysqlMigrationWorkspace(
    url,
    migrationsDir,
    { allowDestructive: options.allowDestructive },
    async (workspace) => {
      const originalFiles = inventory(migrationsDir);
      clean(await workspace.inspect());
      const snapshot = await inspectMysqlSchema(url);
      const plan = planMysqlSchema(schema, snapshot);
      if (inventory(migrationsDir) !== originalFiles)
        throw new MigrationError('MySQL push migration files changed during planning.');
      clean(await workspace.inspect());
      if (options.dryRun || !plan.steps.length) return { plan };
      if (plan.requiresAlterConsent && options.allowDestructive !== true)
        throw new MigrationError('Every MySQL ALTER requires --allow-destructive, including additive ALTER.');
      const before = await inspectMysqlSchema(url);
      if (catalog(before) !== catalog(snapshot))
        throw new MigrationError('MySQL push catalog changed before persistence; no migration was created.');
      if (inventory(migrationsDir) !== originalFiles)
        throw new MigrationError('MySQL push migration files changed before persistence.');
      // Shared writer uses exclusive wx creation. Never overwrite or remove any file,
      // including this one after a later failure. Random suffix avoids clock collisions.
      const file = createMigration(migrationsDir, `schema_push_${randomBytes(6).toString('hex')}`, plan, {
        header: `-- MySQL catalog fingerprint: ${plan.fingerprint}\n-- DOWN can delete data. Every ALTER requires --allow-destructive.\n-- MySQL DDL implicitly commits; inspect partial state and recover manually.`,
      });
      const content = readFileSync(file.path, 'utf8');
      const sections = parseMigrationContent(content, file.path);
      if (sections.up !== plan.up.trim() || sections.down !== plan.down.trim())
        throw new MigrationError('MySQL push scaffold changed before it could be frozen.');
      syncPath(file.path);
      syncPath(migrationsDir);
      const expectedFiles = JSON.parse(originalFiles) as string[][];
      const checksum = sha(content);
      expectedFiles.push([file.filename, checksum]);
      expectedFiles.sort(([a], [b]) => (a! < b! ? -1 : a! > b! ? 1 : 0));
      const frozen = JSON.stringify(expectedFiles);
      const result = await workspace.apply({ name: file.name, checksum }, async (completed) => {
        if (inventory(migrationsDir) !== frozen)
          throw new MigrationError('MySQL push migration files changed; preserved the scaffold for inspection.');
        const current = await inspectMysqlSchema(url);
        if (completed === 0 && catalog(current) !== catalog(snapshot))
          throw new MigrationError('MySQL push catalog changed before execution.');
        const remaining = planMysqlSchema(schema, current);
        if (
          remaining.up !==
          plan.steps
            .slice(completed)
            .map((step) => step.sql)
            .join('\n')
        )
          throw new MigrationError('MySQL push catalog no longer matches the remaining planned statements.');
      });
      if (result.errors.length)
        throw new MigrationError(
          `${result.errors.map((entry) => entry.error).join('\n')} Preserved migration: ${file.filename}.`,
        );
      return { plan, file };
    },
  );
}
