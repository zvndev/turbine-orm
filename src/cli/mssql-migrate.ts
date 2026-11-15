/** Native SQL Server SQL-first migrations. No PostgreSQL pool/dialect emulation. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { MigrationError } from '../errors.js';
import {
  type AppliedMigration,
  type ChecksumMismatch,
  canUpgradeLegacyChecksum,
  type DestructiveOffender,
  isChecksumValid,
  listMigrationFiles,
  type MigrationDeployPlan,
  type MigrationFile,
  type MigrationRunResult,
  type MigrationStatus,
  parseMigrationFilename,
  predictOutOfOrder,
  type RebaselinedChecksum,
} from './migrate.js';
import {
  type MssqlMigrationDriver,
  type MssqlMigrationOptions,
  type MssqlMigrationSession,
  type MssqlMigrationTarget,
  mssqlMigrationConfig,
  quoteMssqlMigrationIdentifier,
  validateMssqlMigrationOptions,
  withMssqlMigrationSession,
} from './mssql-migrate-connection.js';
import {
  assertMssqlMigrationSql,
  mssqlMigrationIdentifiers,
  parseMssqlMigrationContent,
  scanMssqlMigrationDestructive,
  splitMssqlMigrationBatches,
} from './mssql-migrate-sql.js';

export type { MssqlMigrationConfig, MssqlMigrationOptions, MssqlMigrationTarget } from './mssql-migrate-connection.js';
export interface MssqlMigrationUpOptions extends MssqlMigrationOptions {
  step?: number;
  allowDestructive?: boolean;
  /** Drift overrides are intentionally unsupported by the native runner. */
  allowDrift?: boolean;
  force?: boolean;
}
export interface MssqlMigrationDownOptions extends MssqlMigrationOptions {
  step?: number;
  allowDestructive?: boolean;
  allowDrift?: boolean;
}
export interface MssqlMigrationDeployOptions extends MssqlMigrationOptions {
  allowDrift?: boolean;
  force?: boolean;
  step?: never;
}
export interface MssqlMigrationDownResult {
  rolledBack: MigrationFile[];
  errors: Array<{ file: MigrationFile; error: string }>;
  rebaselined: RebaselinedChecksum[];
}
interface Snapshot {
  file: MigrationFile;
  content: string;
  checksum: string;
}
const TRACKING = '_turbine_migrations';

function validate(target: MssqlMigrationTarget, options: MssqlMigrationUpOptions): void {
  validateMssqlMigrationOptions(options);
  mssqlMigrationConfig(target);
  if (options.step !== undefined && (!Number.isSafeInteger(options.step) || options.step < 1)) {
    throw new MigrationError('SQL Server migration step must be a positive safe integer.');
  }
  if (options.allowDrift || options.force || (options as { noTransaction?: boolean }).noTransaction) {
    throw new MigrationError(
      'SQL Server migrations refuse allowDrift, force and noTransaction overrides. Restore the original migration files.',
    );
  }
}

function snapshots(dir: string): Snapshot[] {
  return listMigrationFiles(dir).map((file) => {
    if (file.name.length > 255) throw new MigrationError('SQL Server migration names must fit nvarchar(255).');
    const content = readFileSync(file.path, 'utf8');
    return { file, content, checksum: createHash('sha256').update(content, 'utf8').digest('hex') };
  });
}

function executable(snapshot: Snapshot, section: 'up' | 'down'): string[] {
  const parsed = parseMssqlMigrationContent(snapshot.content, snapshot.file.filename);
  if (parsed.noTransaction) throw new MigrationError('SQL Server migrations refuse turbine:no-transaction.');
  const sql = parsed[section];
  if (!sql)
    throw new MigrationError(
      `SQL Server migration ${snapshot.file.filename} has no executable ${section.toUpperCase()} SQL.`,
    );
  assertMssqlMigrationSql(sql);
  return splitMssqlMigrationBatches(sql);
}

export function assertMssqlMigrationFiles(files: readonly MigrationFile[], section: 'up' | 'down'): void {
  for (const file of files) executable({ file, content: readFileSync(file.path, 'utf8'), checksum: '' }, section);
}

function table(options: MssqlMigrationOptions): string {
  return `${quoteMssqlMigrationIdentifier(options.schema ?? 'dbo')}.[${TRACKING}]`;
}

async function readHistory(
  session: MssqlMigrationSession,
  options: MssqlMigrationOptions,
): Promise<{ applied: AppliedMigration[]; exists: boolean }> {
  const params = { schema: options.schema ?? 'dbo', tracking: TRACKING };
  if (!(await session.query('SELECT SCHEMA_ID(@schema) AS schemaId;', params))[0]?.schemaId) {
    throw new MigrationError('SQL Server migration schema does not exist; create it separately before migrating.');
  }
  const object = (
    await session.query(
      `SELECT o.object_id AS objectId, RTRIM(o.type) AS objectType
    FROM sys.objects o JOIN sys.schemas s ON s.schema_id=o.schema_id
    WHERE s.name=@schema AND o.name=@tracking;`,
      params,
    )
  )[0];
  if (!object) return { applied: [], exists: false };
  if (object.objectType !== 'U')
    throw new MigrationError('Invalid SQL Server migration tracking metadata: expected a user table.');
  const valid = (
    await session.query(
      `SELECT CASE WHEN
    (SELECT COUNT(*) FROM sys.columns WHERE object_id=@id)=4
    AND EXISTS (SELECT 1 FROM sys.columns WHERE object_id=@id AND name='id' AND system_type_id=56 AND is_identity=1 AND is_nullable=0 AND is_computed=0)
    AND EXISTS (SELECT 1 FROM sys.columns WHERE object_id=@id AND name='name' AND system_type_id=231 AND max_length=510 AND is_nullable=0 AND is_computed=0)
    AND EXISTS (SELECT 1 FROM sys.columns WHERE object_id=@id AND name='checksum' AND system_type_id=167 AND max_length=64 AND is_nullable=0 AND is_computed=0)
    AND EXISTS (SELECT 1 FROM sys.columns WHERE object_id=@id AND name='applied_at' AND system_type_id=42 AND is_nullable=0 AND is_computed=0)
    AND EXISTS (SELECT 1 FROM sys.indexes i WHERE i.object_id=@id AND i.is_primary_key=1 AND i.is_disabled=0
      AND (SELECT COUNT(*) FROM sys.index_columns c WHERE c.object_id=i.object_id AND c.index_id=i.index_id AND c.key_ordinal>0)=1
      AND EXISTS (SELECT 1 FROM sys.index_columns ic JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id
        WHERE ic.object_id=i.object_id AND ic.index_id=i.index_id AND ic.key_ordinal=1 AND c.name='id'))
    AND EXISTS (SELECT 1 FROM sys.indexes i WHERE i.object_id=@id AND i.is_unique=1 AND i.has_filter=0 AND i.is_disabled=0
      AND (SELECT COUNT(*) FROM sys.index_columns c WHERE c.object_id=i.object_id AND c.index_id=i.index_id AND c.key_ordinal>0)=1
      AND EXISTS (SELECT 1 FROM sys.index_columns ic JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id
        WHERE ic.object_id=i.object_id AND ic.index_id=i.index_id AND ic.key_ordinal=1 AND c.name='name'))
    AND NOT EXISTS (SELECT 1 FROM sys.triggers WHERE parent_id=@id)
    AND NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE parent_object_id=@id OR referenced_object_id=@id)
    AND NOT EXISTS (SELECT 1 FROM sys.tables WHERE object_id=@id AND (temporal_type<>0 OR is_memory_optimized=1 OR is_filetable=1))
    AND NOT EXISTS (SELECT 1 FROM sys.security_predicates WHERE target_object_id=@id)
    THEN 1 ELSE 0 END AS valid;`,
      { id: object.objectId },
    )
  )[0]?.valid;
  if (valid !== 1)
    throw new MigrationError(
      'Invalid SQL Server migration tracking metadata: expected the native id/name/checksum/applied_at shape, unique name, no triggers or foreign keys.',
    );
  const rows = await session.query(`SELECT id, name, checksum, applied_at FROM ${table(options)} ORDER BY id;`);
  const seen = new Set<string>();
  const applied: AppliedMigration[] = rows.map((row) => {
    if (
      !Number.isSafeInteger(row.id) ||
      Number(row.id) <= 0 ||
      typeof row.name !== 'string' ||
      !parseMigrationFilename(`${row.name}.sql`) ||
      seen.has(row.name) ||
      typeof row.checksum !== 'string' ||
      !(row.applied_at instanceof Date) ||
      !Number.isFinite(row.applied_at.getTime())
    ) {
      throw new MigrationError('Invalid SQL Server migration tracking row.');
    }
    seen.add(row.name);
    return { id: Number(row.id), name: row.name, checksum: row.checksum, applied_at: row.applied_at };
  });
  return { applied, exists: true };
}

async function assertNoTriggers(session: MssqlMigrationSession): Promise<void> {
  // Existing triggers can hide dynamic SQL/transaction control and evade source preflight.
  const triggers = await session.query(
    'SELECT TOP (1) name FROM sys.triggers WHERE is_disabled=0 AND is_ms_shipped=0;',
  );
  if (triggers.length)
    throw new MigrationError(
      'SQL Server migrations refuse enabled user DML/DDL triggers; disable and review them separately.',
    );
}

async function assertNoReservedAliases(session: MssqlMigrationSession, sql: string[]): Promise<void> {
  const names = [...new Set(sql.flatMap(mssqlMigrationIdentifiers))];
  // SQL Server identifiers follow database collation (case/accent/width and
  // trailing-space equivalence), not JavaScript string equality. Bind every
  // candidate; generated parameter names never contain user text.
  for (let offset = 0; offset < names.length; offset += 500) {
    const params: Record<string, unknown> = { tracking: TRACKING };
    const values = names.slice(offset, offset + 500).map((name, index) => {
      params[`identifier${index}`] = name;
      return `(@identifier${index})`;
    });
    const aliases = await session.query(
      `SELECT TOP (1) 1 AS reserved FROM (VALUES ${values.join(',')})
      AS migrationIdentifiers(name) WHERE name COLLATE DATABASE_DEFAULT = @tracking COLLATE DATABASE_DEFAULT;`,
      params,
    );
    if (aliases.length)
      throw new MigrationError(
        'SQL Server migration SQL references reserved tracking metadata under the database collation.',
      );
  }
}

function plan(all: Snapshot[], applied: AppliedMigration[]): MigrationDeployPlan {
  const byName = new Map(all.map((s) => [s.file.name, s]));
  const names = new Set(applied.map((a) => a.name));
  const mismatches: ChecksumMismatch[] = [];
  for (const row of applied) {
    const source = byName.get(row.name);
    if (!source || !isChecksumValid(row.checksum, source.content)) {
      mismatches.push({
        name: row.name,
        expected: row.checksum,
        actual: source?.checksum ?? '',
        type: source ? 'modified' : 'missing',
      });
    }
  }
  const pending = all.filter((s) => !names.has(s.file.name)).map((s) => s.file);
  return { pending, mismatches, outOfOrder: predictOutOfOrder(applied, pending) };
}
function assertNoDrift(value: MigrationDeployPlan): void {
  if (value.mismatches.length)
    throw new MigrationError(
      `SQL Server migration checksum drift or missing files: ${value.mismatches.map((m) => `${m.name} (${m.type})`).join(', ')}. Restore the original files before retrying.`,
    );
}
function rollbackPlan(
  all: Snapshot[],
  applied: AppliedMigration[],
  step = 1,
): { files: MigrationFile[]; missing: string[] } {
  const byName = new Map(all.map((s) => [s.file.name, s.file]));
  const rows = [...applied].sort((a, b) => b.id - a.id).slice(0, step);
  const files: MigrationFile[] = [];
  const missing: string[] = [];
  for (const row of rows) {
    const file = byName.get(row.name);
    if (file) files.push(file);
    else missing.push(row.name);
  }
  return { files, missing };
}

/** Internal driver factory keeps fault tests isolated without mutating global driver state. */
export function createMssqlMigrationRunner(driverLoader?: () => Promise<MssqlMigrationDriver>) {
  async function inspect<T>(
    target: MssqlMigrationTarget,
    dir: string,
    options: MssqlMigrationUpOptions,
    use: (all: Snapshot[], applied: AppliedMigration[]) => T,
  ): Promise<T> {
    validate(target, options);
    const all = snapshots(dir);
    return withMssqlMigrationSession(
      target,
      options,
      async (session) => use(all, (await readHistory(session, options)).applied),
      driverLoader,
    );
  }
  async function write(
    target: MssqlMigrationTarget,
    dir: string,
    options: MssqlMigrationUpOptions,
    direction: 'up' | 'down',
  ) {
    validate(target, options);
    const all = snapshots(dir);
    // History determines the selection under the lock. Validate selected SQL before creating history/DDL.
    return withMssqlMigrationSession(
      target,
      options,
      async (session) => {
        const history = await readHistory(session, options);
        const deployPlan = plan(all, history.applied);
        assertNoDrift(deployPlan);
        const selected =
          direction === 'up'
            ? deployPlan.pending.slice(0, options.step)
            : rollbackPlan(all, history.applied, options.step ?? 1).files;
        const byName = new Map(all.map((s) => [s.file.name, s]));
        const scripts = selected.map((file) => {
          const snapshot = byName.get(file.name)!;
          return { snapshot, batches: executable(snapshot, direction) };
        });
        const destructive: DestructiveOffender[] = scripts.flatMap(({ snapshot }) => {
          const sql = parseMssqlMigrationContent(snapshot.content)[direction];
          const hits = scanMssqlMigrationDestructive(sql);
          return hits.length ? [{ file: snapshot.file.filename, hits }] : [];
        });
        if (destructive.length && !options.allowDestructive) {
          throw new MigrationError(
            `DESTRUCTIVE SQL Server migration requires allowDestructive: ${destructive.map((d) => d.file).join(', ')}.`,
          );
        }
        await assertNoReservedAliases(
          session,
          scripts.flatMap((script) => script.batches),
        );
        await assertNoTriggers(session);
        if (!history.exists && scripts.length) {
          await session.query(`CREATE TABLE ${table(options)} (
          id int IDENTITY(1,1) NOT NULL PRIMARY KEY,
          name nvarchar(255) NOT NULL UNIQUE,
          checksum varchar(64) NOT NULL,
          applied_at datetime2(7) NOT NULL DEFAULT SYSUTCDATETIME()
        );`);
        }
        for (const { snapshot, batches } of scripts) {
          for (const sql of batches) {
            await session.assertActive();
            await session.batch(sql);
            await session.assertActive();
          }
          if (direction === 'up') {
            const written = await session.query(
              `INSERT INTO ${table(options)} (name,checksum,applied_at)
            OUTPUT INSERTED.name AS name, INSERTED.checksum AS checksum VALUES (@name,@checksum,SYSUTCDATETIME());`,
              { name: snapshot.file.name, checksum: snapshot.checksum },
            );
            if (
              written.length !== 1 ||
              written[0]?.name !== snapshot.file.name ||
              written[0]?.checksum !== snapshot.checksum
            ) {
              throw new MigrationError('SQL Server migration history write did not record the exact source checksum.');
            }
          } else {
            const removed = await session.query(
              `DELETE FROM ${table(options)} OUTPUT DELETED.name AS name WHERE name=@name;`,
              { name: snapshot.file.name },
            );
            if (removed.length !== 1 || removed[0]?.name !== snapshot.file.name)
              throw new MigrationError('SQL Server migration history delete did not remove exactly one row.');
          }
        }
        // Preserve only verifiable old hashes; read inspectors never perform this write.
        const remaining = new Set(direction === 'down' ? selected.map((f) => f.name) : []);
        for (const row of history.applied) {
          const source = byName.get(row.name)!;
          if (!remaining.has(row.name) && canUpgradeLegacyChecksum(row.checksum, source.content)) {
            const updated = await session.query(
              `UPDATE ${table(options)} SET checksum=@checksum
            OUTPUT INSERTED.name AS name, INSERTED.checksum AS checksum WHERE name=@name AND checksum=@previous;`,
              { name: row.name, checksum: source.checksum, previous: row.checksum },
            );
            if (updated.length !== 1 || updated[0]?.checksum !== source.checksum)
              throw new MigrationError('SQL Server legacy checksum upgrade failed.');
          }
        }
        return {
          selected,
          destructive,
          outOfOrder: direction === 'up' ? predictOutOfOrder(history.applied, selected) : [],
        };
      },
      driverLoader,
    );
  }
  return {
    inspectMssqlMigrationDeploy: (
      target: MssqlMigrationTarget,
      dir: string,
      options: MssqlMigrationOptions = {},
    ): Promise<MigrationDeployPlan> => inspect(target, dir, options, plan),
    planMssqlMigrationRollback: (
      target: MssqlMigrationTarget,
      dir: string,
      options: MssqlMigrationDownOptions = {},
    ): Promise<{ files: MigrationFile[]; missing: string[] }> =>
      inspect(target, dir, options, (all, applied) => rollbackPlan(all, applied, options.step ?? 1)),
    migrateMssqlStatus: (
      target: MssqlMigrationTarget,
      dir: string,
      options: MssqlMigrationOptions = {},
    ): Promise<MigrationStatus[]> =>
      inspect(target, dir, options, (all, applied) => {
        const sources = new Map(all.map((s) => [s.file.name, s]));
        const records = new Map(applied.map((r) => [r.name, r]));
        const statuses: MigrationStatus[] = all.map((s) => {
          const row = records.get(s.file.name);
          return {
            file: s.file,
            applied: !!row,
            appliedAt: row?.applied_at,
            checksumValid: row ? isChecksumValid(row.checksum, s.content) : undefined,
          };
        });
        for (const row of applied)
          if (!sources.has(row.name))
            statuses.push({
              file: { ...parseMigrationFilename(`${row.name}.sql`)!, path: '' },
              applied: true,
              appliedAt: row.applied_at,
              checksumValid: false,
              missingFile: true,
            });
        return statuses.sort((a, b) => (a.file.name < b.file.name ? -1 : a.file.name > b.file.name ? 1 : 0));
      }),
    migrateMssqlUp: async (
      target: MssqlMigrationTarget,
      dir: string,
      options: MssqlMigrationUpOptions = {},
    ): Promise<MigrationRunResult> => {
      const result = await write(target, dir, options, 'up');
      return {
        applied: result.selected,
        errors: [],
        destructive: result.destructive,
        outOfOrder: result.outOfOrder,
        noTransaction: [],
        rebaselined: [],
      };
    },
    migrateMssqlDeploy: async (
      target: MssqlMigrationTarget,
      dir: string,
      options: MssqlMigrationDeployOptions = {},
    ): Promise<MigrationRunResult> => {
      if (options.step !== undefined)
        throw new MigrationError('SQL Server migrate deploy applies all pending migrations; step is unsupported.');
      const result = await write(target, dir, { ...options, allowDestructive: true }, 'up');
      return {
        applied: result.selected,
        errors: [],
        destructive: result.destructive,
        outOfOrder: result.outOfOrder,
        noTransaction: [],
        rebaselined: [],
      };
    },
    migrateMssqlDown: async (
      target: MssqlMigrationTarget,
      dir: string,
      options: MssqlMigrationDownOptions = {},
    ): Promise<MssqlMigrationDownResult> => {
      const result = await write(target, dir, options, 'down');
      return { rolledBack: result.selected, errors: [], rebaselined: [] };
    },
  };
}

export const {
  inspectMssqlMigrationDeploy,
  planMssqlMigrationRollback,
  migrateMssqlStatus,
  migrateMssqlUp,
  migrateMssqlDeploy,
  migrateMssqlDown,
} = createMssqlMigrationRunner();
