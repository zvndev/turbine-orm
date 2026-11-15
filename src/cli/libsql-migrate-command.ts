/** Local native inspection and bounded additive deployment. */
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { ValidationError } from '../errors.js';
import { findConfigFile } from './config.js';
import type { CliArgs } from './index.js';
import { migrateLibsqlDeploy } from './libsql-migrate.js';
import { inspectLibsqlMigrations } from './libsql-migrate-status.js';
import { type LibsqlProjectConfig, resolveLibsqlProjectContext } from './libsql-project.js';
import { statusGateProblems, summarizeMigrationStatus } from './migrate.js';

export function showLibsqlMigrateHelp(): void {
  console.log('Local libSQL: turbine migrate status --engine libsql [--exit-code] (list is an alias).');
  console.log('Deploy: turbine migrate deploy --engine libsql. Existing local database; all pending files atomically.');
  console.log(
    'Additive CREATE TABLE/INDEX and INSERT VALUES only. Triggers, views, destructive SQL and ambiguous forms refuse.',
  );
  console.log('Read-only history, checksums and file inspection. Config migrationsDir selects the SQL directory.');
  console.log(
    'Exit 2 with --exit-code for uninitialized history, pending, drift, missing, ignored or out-of-order files.',
  );
  console.log('No create, up, down, repair, reset, checksum rewrite, remote database or sync support.');
}

export function assertLibsqlMigrationArguments(args: CliArgs, raw: readonly string[]): void {
  if ((!args.help && !args.subcommand) || (args.subcommand && !['status', 'list', 'deploy'].includes(args.subcommand)))
    throw new ValidationError('Local libSQL migrations support status/list and bounded additive deploy only.');
  let subcommand = false;
  for (let i = 1; i < raw.length; i++) {
    const token = raw[i]!;
    if (['--engine', '--url', '-u', '--schema', '-s'].includes(token)) {
      const value = raw[++i];
      if (!value?.trim() || value.startsWith('-')) throw new ValidationError(`Missing value for ${token}.`);
    } else if (!subcommand && token === args.subcommand) subcommand = true;
    else if (!['--exit-code', '--help', '-h'].includes(token))
      throw new ValidationError(`Unsupported local libSQL migration argument: ${token}.`);
    else if (token === '--exit-code' && args.subcommand === 'deploy')
      throw new ValidationError('--exit-code is supported only for local libSQL migration status/list.');
  }
}

export async function cmdLibsqlMigrate(args: CliArgs, config: LibsqlProjectConfig): Promise<void> {
  const context = resolveLibsqlProjectContext(config);
  if (args.subcommand === 'deploy') {
    const database = statSync(context.databasePath);
    for (const path of [
      findConfigFile(),
      config.schemaFile,
      config.seedFile,
      ...['index.ts', 'types.ts', 'metadata.ts'].map((name) => resolve(config.out, name)),
    ]) {
      if (!path || !existsSync(path)) continue;
      const other = statSync(path);
      if (database.dev === other.dev && database.ino === other.ino)
        throw new ValidationError(
          'Local libSQL database must not alias project config, schema, seed or generated files.',
        );
    }
    console.log(JSON.stringify(await migrateLibsqlDeploy(context.databasePath, config.migrationsDir), null, 2));
    return;
  }
  const result = await inspectLibsqlMigrations(context.databasePath, config.migrationsDir);
  const health = summarizeMigrationStatus(result.statuses);
  const problems = statusGateProblems(health, result.ignoredFiles);
  if (result.historyState === 'uninitialized') problems.push('Migration history is uninitialized.');
  if (result.outOfOrder.length) problems.push('Applied migration history is out of timestamp order.');
  console.log(
    JSON.stringify(
      {
        scope: 'local-read-only',
        ...result,
        statuses: result.statuses.map(({ file, applied, checksumValid, missingFile }) => ({
          name: file.name,
          applied,
          checksumValid,
          missingFile,
        })),
        health,
        problems,
      },
      null,
      2,
    ),
  );
  if (args.exitCode && problems.length) process.exitCode = 2;
}
