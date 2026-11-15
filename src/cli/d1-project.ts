/** Local D1 project lifecycle. Shared CLI dispatch/configuration is supplied separately. */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { generateD1Files } from '../d1/generate.js';
import { type D1IntrospectOptions, introspectD1 } from '../d1/introspect.js';
import { migrateD1 } from '../d1/migrate.js';
import { ValidationError } from '../errors.js';
import { resolveImportExtension } from '../generate.js';
import { findConfigFile } from './config.js';
import { assertD1Config } from './d1-config.js';
import {
  type D1ProjectConfig,
  d1CleanupResolved,
  d1ProjectPath,
  loadD1Runtime,
  requireD1State,
  resolveD1Context,
  withLocalD1,
  writeD1Marker,
} from './d1-local.js';
import { inspectD1Migrations, readD1Plan } from './d1-migrations.js';
import { executeD1Seed, readD1Seed } from './d1-seed.js';

export interface D1ProjectArgs {
  subcommand?: string;
  allowEmpty?: boolean;
  noTimestamp?: boolean;
  help?: boolean;
}
const aliases: Record<string, string> = {
  pull: 'generate',
  gen: 'generate',
  g: 'generate',
  info: 'status',
  migration: 'migrate',
  m: 'migrate',
  s: 'seed',
};
/** Call before the shared parser when raw argv explicitly selects d1. */
export function assertD1Arguments(raw: readonly string[]): void {
  const command = aliases[raw[0] ?? ''] ?? raw[0];
  if (!['init', 'generate', 'status', 'migrate', 'seed'].includes(command ?? ''))
    throw new ValidationError('Local D1 supports init, pull/generate, status, seed and migrate deploy/status/list.');
  let start = 1;
  if (command === 'migrate') {
    const action = raw[1];
    if (action && !action.startsWith('-')) {
      if (!['deploy', 'status', 'list'].includes(action))
        throw new ValidationError('Local D1 supports migrate deploy/status/list only.');
      start++;
    } else if (!raw.includes('--help') && !raw.includes('-h'))
      throw new ValidationError('Choose migrate deploy, status or list.');
  }
  const values = new Set(['--engine', '--schema']);
  const flags = new Set(['--help', '-h', '--verbose', '-v']);
  if (command === 'generate' || command === 'init') {
    values.add('--out');
    values.add('-o');
  }
  if (command === 'init') {
    flags.add('--yes');
    flags.add('-y');
  }
  if (command === 'generate') {
    for (const flag of ['--include', '--exclude', '--import-ext']) values.add(flag);
    for (const flag of ['--allow-empty', '--no-timestamp', '--keep-column-names', '--legacy-to-many-uniques'])
      flags.add(flag);
  }
  for (let i = start; i < raw.length; i++) {
    const token = raw[i]!;
    if (values.has(token)) {
      const value = raw[++i];
      if (!value || value.startsWith('-')) throw new ValidationError(`Missing value for ${token}.`);
      if (token === '--engine' && value !== 'd1') throw new ValidationError('Conflicting D1 engine selection.');
    } else if (!flags.has(token)) throw new ValidationError(`Unsupported local D1 argument: ${token}.`);
  }
}
function capturedConfig(input: D1ProjectConfig): D1ProjectConfig {
  assertD1Config(input);
  if (
    !Array.isArray(input.include) ||
    !Array.isArray(input.exclude) ||
    (input.relationNames !== undefined &&
      (!input.relationNames ||
        typeof input.relationNames !== 'object' ||
        Array.isArray(input.relationNames) ||
        Object.values(input.relationNames).some(
          (value) => !value || typeof value !== 'object' || Array.isArray(value),
        ))) ||
    (input.columnTypes !== undefined &&
      (!input.columnTypes || typeof input.columnTypes !== 'object' || Array.isArray(input.columnTypes)))
  )
    throw new ValidationError('Invalid local D1 generation option records.');
  // All generator/introspection inputs are captured before optional runtime loading.
  const config = {
    ...input,
    d1: input.d1 && { ...input.d1 },
    include: [...input.include],
    exclude: [...input.exclude],
    relationNames:
      input.relationNames === undefined
        ? undefined
        : Object.fromEntries(Object.entries(input.relationNames).map(([key, value]) => [key, { ...value }])),
    columnTypes: input.columnTypes === undefined ? undefined : { ...input.columnTypes },
  };
  if (
    config.include.some((value) => typeof value !== 'string') ||
    config.exclude.some((value) => typeof value !== 'string') ||
    typeof config.keepColumnNames !== 'boolean' ||
    typeof config.legacyToManyUniques !== 'boolean' ||
    !['js', 'ts', 'none', 'auto'].includes(config.importExtension)
  )
    throw new ValidationError('Invalid local D1 generation options.');
  if (
    config.relationNames &&
    Object.values(config.relationNames).some((mapping) =>
      Object.values(mapping).some((name) => typeof name !== 'string'),
    )
  )
    throw new ValidationError('D1 relationNames must map relation names to strings.');
  if (
    config.columnTypes &&
    Object.values(config.columnTypes).some(
      (value) => typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value),
    )
  )
    throw new ValidationError('D1 columnTypes must contain single-line type strings.');
  return config;
}
type Owned = { path: string; dev: number; ino: number; directory: boolean };
function own(path: string, directory: boolean): Owned {
  const stat = lstatSync(path);
  return { path, dev: stat.dev, ino: stat.ino, directory };
}
function matches(item: Owned): boolean {
  if (!existsSync(item.path)) return false;
  const stat = lstatSync(item.path);
  return stat.dev === item.dev && stat.ino === item.ino;
}
function makeDirectories(path: string, created: Owned[]): void {
  if (existsSync(path)) return;
  makeDirectories(dirname(path), created);
  mkdirSync(path);
  created.push(own(path, true));
}
function rollback(created: Owned[]): void {
  for (const item of [...created].reverse()) {
    try {
      if (matches(item)) {
        if (item.directory) rmdirSync(item.path);
        else unlinkSync(item.path);
      }
    } catch {
      /* Never remove a replaced or nonempty shared parent. */
    }
  }
}
function assertFreshOutput(path: string): void {
  d1ProjectPath(path);
  if (existsSync(path))
    throw new ValidationError(
      'D1 generation requires a fresh --out directory. In-place regeneration is not implemented; existing generated and edited files are preserved.',
    );
}
function publishOutput(path: string, files: Record<string, string>): void {
  const created: Owned[] = [];
  let stage: string | undefined;
  try {
    assertFreshOutput(path);
    makeDirectories(dirname(path), created);
    stage = mkdtempSync(join(dirname(path), '.turbine-d1-generation-'));
    for (const [name, contents] of Object.entries(files)) writeFileSync(join(stage, name), contents, { flag: 'wx' });
    mkdirSync(path);
    const reserved = own(path, true);
    created.push(reserved);
    // Replace only the empty reservation created above; no existing generated file is overwritten.
    if (!matches(reserved)) throw new ValidationError('D1 output reservation changed.');
    renameSync(stage, path);
    stage = undefined;
  } catch (error) {
    try {
      if (stage) rmSync(stage, { recursive: true, force: true });
    } catch {}
    rollback(created);
    throw error;
  }
}
export async function initD1Project(input: D1ProjectConfig): Promise<void> {
  const config = capturedConfig(input);
  const context = resolveD1Context(config);
  assertFreshOutput(context.out);
  for (const path of [context.persist, context.migrations])
    if (existsSync(path))
      throw new ValidationError(
        'D1 init requires fresh persistence and migration directories. Existing state is never adopted.',
      );
  const configExists = !!findConfigFile();
  const Runtime = await loadD1Runtime();
  // Revalidate after loading optional code and before the first filesystem effect.
  resolveD1Context(config);
  assertFreshOutput(context.out);
  const created: Owned[] = [];
  let persistent: Owned | undefined;
  try {
    makeDirectories(dirname(context.persist), created);
    mkdirSync(context.persist);
    persistent = own(context.persist, true);
    makeDirectories(dirname(context.migrations), created);
    mkdirSync(context.migrations);
    created.push(own(context.migrations, true));
    writeFileSync(context.planPath, '[]\n', { flag: 'wx' });
    created.push(own(context.planPath, false));
    if (!configExists) {
      const text = `// Local Miniflare D1 only. Install optional miniflare@4.20260730.0.\nexport default ${JSON.stringify({ engine: 'd1', d1: config.d1, out: config.out, migrationsDir: config.migrationsDir }, null, 2)};\n`;
      writeFileSync(context.configPath, text, { flag: 'wx' });
      created.push(own(context.configPath, false));
    }
    await withLocalD1(
      context,
      async (binding) => {
        const result = await binding.prepare('SELECT 1 AS ready').all<{ ready: number }>();
        if (result.success !== true || result.results[0]?.ready !== 1)
          throw new Error('Local D1 binding readiness failed.');
      },
      Runtime,
    );
    writeD1Marker(context);
  } catch (error) {
    try {
      if (persistent && d1CleanupResolved(context) && matches(persistent)) rmSync(persistent.path, { recursive: true });
    } catch {}
    rollback(created);
    throw error;
  }
}
export async function generateD1Project(input: D1ProjectConfig, args: D1ProjectArgs = {}) {
  const config = capturedConfig(input);
  const context = resolveD1Context(config);
  const allowEmpty = args.allowEmpty === true;
  const noTimestamp = args.noTimestamp === true;
  assertFreshOutput(context.out);
  requireD1State(context);
  readD1Plan(context.planPath); // Invalid pending SQL refuses before optional runtime startup.
  const { ext: importExt, mode: importMode } = resolveImportExtension(context.out, config.importExtension);
  const options: D1IntrospectOptions = {
    schema: 'main',
    include: config.include,
    exclude: config.exclude,
    keepColumnNames: config.keepColumnNames,
    legacyToManyUniques: config.legacyToManyUniques,
    relationNames: config.relationNames,
    logger: {},
  };
  const result = await withLocalD1(context, async (binding) => {
    const schema = await introspectD1(binding, options);
    // Internal migration metadata must never become a generated user accessor.
    delete schema.tables._turbine_d1_migrations;
    if (!allowEmpty && !Object.keys(schema.tables).length)
      throw new ValidationError('D1 has no selected user tables. Deploy migrations first or use --allow-empty.');
    const files = generateD1Files(schema, {
      noTimestamp,
      importExt,
      importMode,
      columnTypes: config.columnTypes,
      keepColumnNames: config.keepColumnNames,
      logger: {},
    });
    return { schema, files };
  });
  publishOutput(context.out, result.files);
  return { schema: result.schema, outDir: context.out, files: Object.keys(result.files) };
}
export async function statusD1Project(input: D1ProjectConfig) {
  const config = capturedConfig(input);
  const context = resolveD1Context(config);
  requireD1State(context);
  const plan = readD1Plan(context.planPath);
  return withLocalD1(context, (binding) => inspectD1Migrations(binding, plan));
}
export async function deployD1Project(input: D1ProjectConfig) {
  const config = capturedConfig(input);
  const context = resolveD1Context(config);
  requireD1State(context);
  const plan = readD1Plan(context.planPath);
  return withLocalD1(context, (binding) => migrateD1(binding, plan));
}
export async function seedD1Project(input: D1ProjectConfig) {
  const config = capturedConfig(input);
  const context = resolveD1Context(config);
  requireD1State(context);
  const migrations = readD1Plan(context.planPath);
  const inserts = readD1Seed(context);
  return withLocalD1(context, (binding) => executeD1Seed(binding, inserts, migrations));
}
export function showD1Help(): void {
  console.log(
    'Local D1: init --engine d1; pull/generate [--out <fresh directory>]; status; seed; migrate deploy|status|list.',
  );
  console.log(
    'Configure d1: { binding, databaseId, persist }; install optional miniflare@4.20260730.0. No URL or hosted operations.',
  );
  console.log(
    'migrationsDir/plan.json is the complete ordered [{id,statements}] history, one admitted SQL statement per entry.',
  );
  console.log(
    'init creates fresh local state and an empty plan. Deploy the plan, then generate to a fresh directory. Repeat with a fresh --out after later deploys; in-place regeneration is unimplemented.',
  );
  console.log(
    'status/list only SELECT catalog/history, never create a journal. Miniflare can maintain bookkeeping/WAL files on reopen.',
  );
  console.log(
    'A dispatched batch cannot be cancelled. Unknown outcomes require reconciling the identical complete plan, never assuming rollback.',
  );
  console.log(
    'seed reads migrationsDir/seed.json: version 1 declarative table/columns/rows inserts, bound values, one atomic batch. No SQL/callback seeds or automatic retry; reconcile unknown seed rows manually.',
  );
}
export async function cmdD1Project(
  command: string,
  args: D1ProjectArgs,
  config: D1ProjectConfig,
  raw: readonly string[],
): Promise<void> {
  assertD1Arguments(raw);
  if (args.help) {
    showD1Help();
    return;
  }
  const canonical = aliases[command] ?? command;
  if (canonical === 'init') {
    await initD1Project(config);
    console.log('Initialized local D1 binding and complete empty migration plan.');
  } else if (canonical === 'generate') {
    const result = await generateD1Project(config, args);
    console.log(`Generated ${result.files.length} D1 files in ${result.outDir}.`);
  } else if (canonical === 'migrate' && args.subcommand === 'deploy')
    console.log(JSON.stringify(await deployD1Project(config)));
  else if (canonical === 'seed') console.log(JSON.stringify(await seedD1Project(config)));
  else console.log(JSON.stringify(await statusD1Project(config)));
}
