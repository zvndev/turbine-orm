/**
 * turbine-orm, Code generator
 *
 * Takes an IntrospectedSchema and emits TypeScript files:
 *   - types.ts    , Entity interfaces, Create/Update input types
 *   - metadata.ts , Runtime schema metadata (column maps, relations, etc.)
 *   - index.ts    , Configured TurbineClient with typed table accessors
 *
 * Output goes to the specified directory (default: ./generated/turbine/).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { ValidationError } from './errors.js';
import { assertDistinctColumnFields, printableCatalogName } from './introspect.js';
import { closestName } from './query/utils.js';
import {
  type ColumnMetadata,
  type PrismaCompatMap,
  pgTypeToTs,
  pgTypeToTsInput,
  type RelationDef,
  type SchemaMetadata,
  singularize,
  snakeToPascal,
  type TableMetadata,
  timeOfDayKind,
  withDbFieldNames,
} from './schema.js';
import { tsTypeTextProblem } from './schema-builder.js';

/** Get the TypeScript type name for a table (singularized PascalCase) */
function entityName(tableName: string): string {
  return snakeToPascal(singularize(tableName));
}

/**
 * Per-column TypeScript overrides from {@link GenerateOptions.columnTypes},
 * keyed by database table name, then database column name.
 */
type ColumnTypeOverrides = ReadonlyMap<string, ReadonlyMap<string, string>>;

/** The override for one column, or `undefined`. */
function overrideFor(overrides: ColumnTypeOverrides | undefined, table: string, column: string): string | undefined {
  return overrides?.get(table)?.get(column);
}

/**
 * Resolve the TypeScript type for a column, mapping enum-typed columns to their
 * generated string-literal union (PascalCase enum name) instead of the
 * `unknown` that {@link pgTypeToTs} yields for user-defined types. A
 * `columnTypes` override replaces the type outright (nullability is still
 * added). Falls back to the introspected `col.tsType` for everything else.
 */
export function columnTsType(col: ColumnMetadata, enums: Record<string, string[]>, override?: string): string {
  if (override !== undefined) return col.nullable ? `${override} | null` : override;
  const dt = col.dialectType ?? col.pgType;
  const isArray = col.isArray || dt.startsWith('_');
  const base = isArray && dt.startsWith('_') ? dt.slice(1) : dt;
  if (Object.hasOwn(enums, base)) {
    let t = snakeToPascal(base);
    if (isArray) t += '[]';
    return col.nullable ? `${t} | null` : t;
  }
  return col.tsType;
}

/**
 * Resolve the TypeScript type a column accepts on the WRITE path (the `*Create`
 * / `*Update` input types). It differs from the row type where the runtime
 * accepts more than one spelling or cannot take the parsed read value back
 * ({@link pgTypeToTsInput}), and for time-of-day columns.
 *
 * A `time` / `timetz` column reads back as a `string` (`'09:00:00'`), so the
 * row type stays `string`. On write the runtime also accepts a JS `Date` and
 * narrows it to its UTC time of day (see `coerceWriteValue` in
 * query/writes.ts), matching Prisma, which types a `DateTime @db.Time(6)`
 * field as a `Date`.
 */
function writeColumnTsType(col: ColumnMetadata, enums: Record<string, string[]>, override?: string): string {
  const tsType = columnTsType(col, enums, override);
  if (override !== undefined) return tsType;
  const dt = col.dialectType ?? col.pgType;
  const isArray = col.isArray || dt.startsWith('_');
  const base = isArray && dt.startsWith('_') ? dt.slice(1) : dt;
  if (Object.hasOwn(enums, base)) return tsType;
  if (timeOfDayKind(base)) {
    // A `time[]` column accepts a Date per element (the bind rewrite runs
    // element-wise, see coerceTemporalValue in query/utils.ts).
    const widened = isArray ? '(string | Date)[]' : 'string | Date';
    return col.nullable ? `${widened} | null` : widened;
  }
  // Only rewrite a type the read map produced: hand-built or engine metadata
  // carrying its own tsType keeps it.
  const pgType = isArray && !dt.startsWith('_') ? `_${dt}` : dt;
  const read = pgTypeToTs(pgType, col.nullable);
  const input = pgTypeToTsInput(pgType, col.nullable);
  return input !== read && tsType === read ? input : tsType;
}

/**
 * Validate {@link GenerateOptions.columnTypes} against the schema and index it.
 * A key naming no table or column is a `ValidationError`, not a silent no-op,
 * since an override that applies to nothing leaves the column typed `unknown`.
 */
export function resolveColumnTypeOverrides(
  schema: SchemaMetadata,
  columnTypes: Readonly<Record<string, string>> | undefined,
): ColumnTypeOverrides | undefined {
  if (columnTypes === undefined) return undefined;
  const out = new Map<string, Map<string, string>>();
  for (const [key, tsType] of Object.entries(columnTypes)) {
    const dot = key.lastIndexOf('.');
    const tableName = dot > 0 ? key.slice(0, dot) : '';
    const columnName = dot > 0 ? key.slice(dot + 1) : '';
    if (!tableName || !columnName) {
      throw new ValidationError(
        `columnTypes key ${printableCatalogName(JSON.stringify(key))} must be "<table>.<column>", using database names, ` +
          'for example "users.settings".',
      );
    }
    const table = Object.hasOwn(schema.tables, tableName) ? schema.tables[tableName] : undefined;
    if (!table) {
      const hint = closestName(tableName, Object.keys(schema.tables));
      throw new ValidationError(
        `columnTypes key ${printableCatalogName(JSON.stringify(key))} names no table${hint ? `. Did you mean "${printableCatalogName(hint)}"?` : '.'}`,
      );
    }
    if (!table.columns.some((c) => c.name === columnName)) {
      const hint = closestName(
        columnName,
        table.columns.map((c) => c.name),
      );
      throw new ValidationError(
        `columnTypes key ${printableCatalogName(JSON.stringify(key))} names no column of "${printableCatalogName(tableName)}"` +
          `${hint ? `. Did you mean "${printableCatalogName(`${tableName}.${hint}`)}"?` : '.'}`,
      );
    }
    const problem = typeof tsType === 'string' ? tsTypeTextProblem(tsType) : 'it is not a string';
    if (problem !== null) {
      throw new ValidationError(
        `columnTypes[${printableCatalogName(JSON.stringify(key))}] must be one TypeScript type on one line, for example ` +
          `"import('../src/types.js').Settings", but ${problem}: ${printableCatalogName(JSON.stringify(tsType))}.`,
      );
    }
    let perTable = out.get(tableName);
    if (!perTable) {
      perTable = new Map();
      out.set(tableName, perTable);
    }
    perTable.set(columnName, tsType.trim());
  }
  return out;
}

/**
 * Characters that must never reach generated source verbatim: the two that end
 * a single-quoted literal (backslash, quote), the C0/C1 control range (a raw
 * newline alone leaves the literal unterminated and starts a new source line),
 * and the two Unicode line terminators.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: neutralizing control characters is this pattern's purpose
const UNSAFE_EMIT_CHARS_GLOBAL = /[\\'\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/**
 * Escape a value for embedding in a single-quoted TypeScript string literal.
 *
 * Every character that can END the literal has to be neutralized here, not just
 * the quote. A database identifier is attacker-controlled text (Postgres allows
 * any character in a double-quoted name, up to 63 bytes) and generated code is
 * `import`ed, i.e. EXECUTED, so a literal that closes early leaves the rest of
 * the name in expression position. A raw newline is enough on its own.
 */
function escSQ(value: string): string {
  return value.replace(UNSAFE_EMIT_CHARS_GLOBAL, (ch) => {
    switch (ch) {
      case '\\':
        return '\\\\';
      case "'":
        return "\\'";
      case '\n':
        return '\\n';
      case '\r':
        return '\\r';
      case '\t':
        return '\\t';
      case '\b':
        return '\\b';
      case '\f':
        return '\\f';
      case '\v':
        return '\\v';
      default:
        return `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
    }
  });
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: collapsing control characters is this pattern's purpose
const COMMENT_BREAKING_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

/**
 * Neutralize a catalog string for emission inside a generated JSDoc or line
 * COMMENT. Two sequences end a comment early and both are legal in a
 * double-quoted Postgres identifier: an asterisk followed by a slash closes a
 * block comment, putting everything after it in code position, and a newline
 * ends a line comment and splits one emitted line into two. Escaping the
 * asterisk breaks the terminator without changing how the name reads.
 */
function docSafe(value: string): string {
  return value.replace(/\*\//g, '*\\/').replace(COMMENT_BREAKING_CHARS, ' ');
}

// ---------------------------------------------------------------------------
// Generation options
// ---------------------------------------------------------------------------

export interface GenerateOptions {
  /** The introspected schema to generate from */
  schema: SchemaMetadata;
  /** Output directory (default: './generated/turbine') */
  outDir?: string;
  /** Redact connection string from generated comments */
  connectionString?: string;
  /**
   * Also emit `zod.ts` with per-table `XSchema` / `XCreateSchema` /
   * `XUpdateSchema` Zod validators (H1). The file imports the user-side `zod`
   * package, it is never imported by Turbine's runtime, so Zod stays out of the
   * library's dependency graph. Default: `false`.
   */
  zod?: boolean;
  /**
   * Omit the `Generated at: <ISO timestamp>` line from every generated file
   * header (reproducible codegen). With this set, byte-identical
   * schemas regenerate to byte-identical output, so regens produce empty
   * diffs. Default: `false` (timestamp included, unchanged behavior).
   */
  noTimestamp?: boolean;
  /**
   * Which extension the generated `index.ts` uses on its sibling import
   * specifiers (`./types`, `./metadata`). F3.
   *
   *   - `'js'`: always `./types.js` (required by NodeNext `tsc` and by
   *     tsc-compiled ESM run on Node; the pre-0.41 behavior).
   *   - `'ts'`: always `./types.ts`, so Node's native type stripping can run the
   *     generated files directly (`node app.ts`). A type checker needs
   *     `allowImportingTsExtensions` or `rewriteRelativeImportExtensions` to
   *     accept it. `'auto'` never picks this.
   *   - `'none'`: always `./types` (correct for bundlers / `moduleResolution
   *     bundler | node10`: webpack, Next.js/SWC, Vite/esbuild).
   *   - `'auto'` (default): walk up from `outDir` to the nearest `tsconfig.json`
   *     (extends chains are NOT followed) and emit `'.js'` when its `module` /
   *     `moduleResolution` is `node16`/`nodenext`, `''` when both are present and
   *     neither is, and fall back to `'.js'` when the tsconfig is missing,
   *     unparseable, or ambiguous (so NodeNext consumers can never regress).
   */
  importExtension?: 'js' | 'ts' | 'none' | 'auto';
  /**
   * Rewrite generated column FIELD names to the raw database column names
   * (snake_case) instead of camelCase (F4). Opt-in; when unset the output is
   * byte-identical to before. Implemented as the pure generate-time
   * {@link withDbFieldNames} transform (identity `columnMap`/`reverseColumnMap`,
   * zero runtime changes). Relation names, table accessors, and entity type
   * names are unaffected.
   */
  keepColumnNames?: boolean;
  /**
   * TypeScript types for specific columns, keyed `"<table>.<column>"` with
   * database names. The value is emitted as written into the row type and the
   * `*Create` / `*Update` input types (`| null` is added for a nullable
   * column), so a json/jsonb column can carry its real shape instead of
   * `unknown`:
   *
   *   columnTypes: { 'users.settings': "import('../src/settings.js').Settings" }
   *
   * A relative `import()` resolves from the output directory. The type is a
   * compile-time claim: nothing checks stored values against it. A key naming
   * no table or column is an error.
   */
  columnTypes?: Readonly<Record<string, string>>;
}

/** Per-file generator options (subset of {@link GenerateOptions} the emitters need). */
export interface GenerateFileOptions {
  /** Omit the `Generated at:` header line for reproducible output. */
  noTimestamp?: boolean;
  /**
   * Resolved sibling-import extension for `generateIndex` (`'.js'`, `'.ts'` or `''`).
   * Defaults to `'.js'` when unset so direct callers stay byte-stable.
   */
  importExt?: string;
  /** Human-readable resolved import mode, recorded as a comment in `index.ts`. */
  importMode?: string;
  /** {@link GenerateOptions.columnTypes}; validated against the schema by the emitter. */
  columnTypes?: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Main generate function
// ---------------------------------------------------------------------------

export function generate(options: GenerateOptions): { outDir: string; files: string[] } {
  const outDir = options.outDir ?? './generated/turbine';

  // Path traversal protection, ensure output stays within project root
  const resolved = resolve(outDir);
  const rel = relative(process.cwd(), resolved);
  if (rel.startsWith('..') || resolve(rel) !== resolved) {
    throw new Error(`Output directory must be within the project root. Got: ${outDir}`);
  }

  mkdirSync(outDir, { recursive: true });

  // F4: keep raw DB column names as field names (opt-in). Pure transform: when
  // the flag is off `withDbFieldNames` is never called and output is unchanged.
  const schema = options.keepColumnNames ? withDbFieldNames(options.schema) : options.schema;

  // F3: resolve which extension sibling imports get in index.ts.
  const { ext: importExt, mode: importMode } = resolveImportExtension(outDir, options.importExtension ?? 'auto');

  const files: string[] = [];
  const fileOptions: GenerateFileOptions = {
    noTimestamp: options.noTimestamp,
    importExt,
    importMode,
    ...(options.columnTypes !== undefined ? { columnTypes: options.columnTypes } : {}),
  };

  // Generate types.ts
  const typesContent = generateTypes(schema, fileOptions);
  writeFileSync(join(outDir, 'types.ts'), typesContent, 'utf-8');
  files.push('types.ts');

  // Generate metadata.ts
  const metadataContent = generateMetadata(schema, fileOptions);
  writeFileSync(join(outDir, 'metadata.ts'), metadataContent, 'utf-8');
  files.push('metadata.ts');

  // Generate index.ts (configured client)
  const indexContent = generateIndex(schema, fileOptions);
  writeFileSync(join(outDir, 'index.ts'), indexContent, 'utf-8');
  files.push('index.ts');

  // Generate zod.ts (optional, --zod flag)
  if (options.zod) {
    const zodContent = generateZod(schema, fileOptions);
    writeFileSync(join(outDir, 'zod.ts'), zodContent, 'utf-8');
    files.push('zod.ts');
  }

  return { outDir, files };
}

// ---------------------------------------------------------------------------
// Import-extension resolution (F3)
// ---------------------------------------------------------------------------

/**
 * Resolve the requested {@link GenerateOptions.importExtension} to the concrete
 * extension string used on `index.ts`'s sibling imports plus a human-readable
 * mode label for the generated comment.
 *
 *   - `'js'`   → `.js`
 *   - `'ts'`   → `.ts`
 *   - `'none'` → `''`
 *   - `'auto'` → tsconfig-driven ({@link detectTsconfigExtension}); falls back
 *     to `.js` (the pre-0.41 default) when detection is uncertain, so NodeNext
 *     consumers can never regress.
 */
export function resolveImportExtension(
  outDir: string,
  requested: 'js' | 'ts' | 'none' | 'auto',
): { ext: string; mode: string } {
  if (requested === 'js') return { ext: '.js', mode: 'js' };
  if (requested === 'ts') return { ext: '.ts', mode: 'ts' };
  if (requested === 'none') return { ext: '', mode: 'none' };
  const detected = detectTsconfigExtension(resolve(outDir));
  if (detected === 'js') return { ext: '.js', mode: 'auto (nodenext → .js)' };
  if (detected === 'none') return { ext: '', mode: 'auto (bundler → no extension)' };
  return { ext: '.js', mode: 'auto (fallback → .js)' };
}

/**
 * Walk up from `startDir` to the nearest `tsconfig.json` and classify its module
 * resolution. Does NOT follow `extends` chains (a monorepo whose base config
 * sets `moduleResolution` needs the explicit flag). Returns:
 *   - `'js'`: `module`/`moduleResolution` is `node16`/`nodenext`;
 *   - `'none'`: both fields present and neither is node16/nodenext (bundler,
 *     node, node10, classic, esnext, commonjs, preserve);
 *   - `null`: no tsconfig found, unparseable, or the fields are absent
 *     (possibly hidden behind `extends`) → caller falls back to `.js`.
 */
export function detectTsconfigExtension(startDir: string): 'js' | 'none' | null {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, 'tsconfig.json');
    if (existsSync(candidate)) {
      try {
        return classifyTsconfig(readFileSync(candidate, 'utf-8'));
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null; // reached the filesystem root
    dir = parent;
  }
}

/**
 * Classify a tsconfig's `compilerOptions.module` / `moduleResolution` (see
 * {@link detectTsconfigExtension}). Tolerant of `//` and block comments and
 * trailing commas (real-world tsconfigs use JSONC).
 */
export function classifyTsconfig(text: string): 'js' | 'none' | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(text));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const co = (parsed as { compilerOptions?: unknown }).compilerOptions;
  if (typeof co !== 'object' || co === null) return null;
  const opts = co as { module?: unknown; moduleResolution?: unknown };
  const mod = typeof opts.module === 'string' ? opts.module.toLowerCase() : undefined;
  const modRes = typeof opts.moduleResolution === 'string' ? opts.moduleResolution.toLowerCase() : undefined;
  const isNodeNext = (v: string | undefined) => v === 'node16' || v === 'nodenext';
  if (isNodeNext(mod) || isNodeNext(modRes)) return 'js';
  if (mod !== undefined && modRes !== undefined) return 'none';
  return null;
}

/**
 * Strip `//` line comments and block comments from JSONC text, leaving anything
 * inside a double-quoted string untouched. Trailing commas are then removed so
 * `JSON.parse` accepts the result.
 */
export function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (inLine) {
      if (ch === '\n') {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === '\\') {
        // Preserve the escaped character verbatim.
        if (next !== undefined) {
          out += next;
          i++;
        }
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLine = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlock = true;
      i++;
      continue;
    }
    out += ch;
  }
  // Drop trailing commas before } or ].
  return out.replace(/,(\s*[}\]])/g, '$1');
}

// ---------------------------------------------------------------------------
// types.ts generator
// ---------------------------------------------------------------------------

function generatedFileHeader(options?: GenerateFileOptions): string[] {
  // `noTimestamp` omits the volatile line entirely so regenerating an
  // unchanged schema produces byte-identical files.
  return [
    '/**',
    ' * Auto-generated by turbine-orm, DO NOT EDIT',
    ' *',
    ...(options?.noTimestamp ? [] : [` * Generated at: ${new Date().toISOString()}`]),
    ' * @see https://turbineorm.dev',
    ' */',
    '',
  ];
}

/**
 * The relations of a table that are safe to surface in the generated TYPE
 * layer. A relation whose name equals a scalar column field would shadow the
 * column: `interface XWithY extends X` becomes TS2430, the `XCreate & { y?: … }`
 * intersection collapses (TS2322), and neither the column nor the relation is
 * targetable. Introspection no longer produces such names (they are
 * disambiguated at the source), but hand-written or legacy metadata may -
 * skip those relations here with a warning instead of emitting broken types.
 * The runtime metadata (metadata.ts) still carries every relation.
 */
function typeSafeRelations(table: TableMetadata, warn = true): [string, RelationDef][] {
  const columnFields = new Set(table.columns.map((c) => c.field));
  const usable: [string, RelationDef][] = [];
  for (const [relName, rel] of Object.entries(table.relations)) {
    if (columnFields.has(relName)) {
      if (warn) {
        console.warn(
          `[turbine] ${printableCatalogName(
            `Relation "${relName}" on table "${table.name}" shadows a column field of the same name, ` +
              'omitting it from the generated types. Rename the relation (or the column) to expose it.',
          )}`,
        );
      }
      continue;
    }
    usable.push([relName, rel]);
  }
  return usable;
}

// ---------------------------------------------------------------------------
// Identifier boundary
// ---------------------------------------------------------------------------

/**
 * The JavaScript identifier grammar as a WHOLE-STRING match: `IdentifierStart`
 * (`ID_Start`, `$`, `_`) followed by `IdentifierPart` (`ID_Continue`, `$`, ZWNJ,
 * ZWJ). Deliberately Unicode-aware rather than `[A-Za-z_$][\w$]*`: a table named
 * `café` yields the perfectly valid identifier `Café` and there is no reason to
 * refuse it. What it does refuse is every character that could end the
 * identifier token, so a name that passes interpolates as exactly one token.
 */
const EMITTABLE_IDENTIFIER_RE = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200C\u200D]*$/u;

/**
 * Whether `name` can be interpolated into generated TypeScript in IDENTIFIER
 * position (a type name, an interface name, a class member declaration).
 *
 * Identifier position is the one emission site with no escaping option: a value
 * position becomes a quoted literal ({@link escSQ}), a key position becomes a
 * quoted key ({@link quoteIfNeeded}), a comment is neutralized
 * ({@link docSafe}), but `export interface X` needs a real identifier. So the
 * only sound answer for a name that is not one is to refuse.
 */
export function isEmittableIdentifier(name: string): boolean {
  return EMITTABLE_IDENTIFIER_RE.test(name);
}

function requireEmittable(derived: string, subject: string, role: string): void {
  if (isEmittableIdentifier(derived)) return;
  throw new ValidationError(
    `Cannot generate code for ${printableCatalogName(subject)}: it produces ${printableCatalogName(JSON.stringify(derived))} as ${role}, ` +
      `which is not a valid TypeScript identifier. Rename the database object, or exclude it from generation ` +
      `(introspect \`exclude\`).`,
  );
}

/** Table accessors the generated `TurbineClient` class cannot declare as members. */
const RESERVED_ACCESSORS: ReadonlySet<string> = new Set(['constructor', '__proto__']);

/** The type a defineSchema file declared for a column (bare, no `| null`), if any. */
function declaredTsTypeOf(col: ColumnMetadata): string | undefined {
  return col.declaredTsType;
}

/**
 * The metadata `types.ts` is written from. A column whose schema file declared a
 * TypeScript type takes it, with `| null` for a nullable column, in place of the
 * type mapped from its database type. The runtime keeps the mapped type
 * (`metadata.ts` is written from the input), because the engines branch on it.
 * Returns `schema` itself when no column declared one.
 */
function withDeclaredTypes(schema: SchemaMetadata): SchemaMetadata {
  let declaredAny = false;
  const tables: Record<string, TableMetadata> = Object.create(null);
  for (const [name, table] of Object.entries(schema.tables)) {
    if (!table.columns.some((c) => declaredTsTypeOf(c) !== undefined)) {
      tables[name] = table;
      continue;
    }
    declaredAny = true;
    tables[name] = {
      ...table,
      columns: table.columns.map((col) => {
        const declared = declaredTsTypeOf(col);
        return declared === undefined ? col : { ...col, tsType: col.nullable ? `${declared} | null` : declared };
      }),
    };
  }
  return declaredAny ? { ...schema, tables } : schema;
}

/**
 * Refuse a schema whose names cannot be emitted as TypeScript identifiers.
 *
 * Called by every emitter that puts a catalog-derived name in identifier
 * position ({@link generateTypes}, {@link generateIndex}, {@link generateZod}).
 * {@link generateMetadata} deliberately does NOT call it: metadata.ts emits no
 * identifiers derived from catalog names, every name there is a quoted key or a
 * quoted value, so it has no identifier rule to enforce and stays usable for a
 * schema whose type layer cannot be generated.
 *
 * The check runs on the DERIVED identifier, not the raw name, because that is
 * what actually lands in the output, but the message names the raw object so
 * the reader knows what to rename.
 */
export function assertEmittableSchema(schema: SchemaMetadata): void {
  for (const enumName of Object.keys(schema.enums)) {
    requireEmittable(snakeToPascal(enumName), `enum type "${enumName}"`, 'the generated enum type name');
  }
  for (const table of Object.values(schema.tables)) {
    requireEmittable(entityName(table.name), `table "${table.name}"`, 'the generated entity type name');
    requireEmittable(snakeToCamelStr(table.name), `table "${table.name}"`, 'the generated client accessor');
    if (RESERVED_ACCESSORS.has(snakeToCamelStr(table.name))) {
      throw new ValidationError(
        `Cannot generate code for table "${printableCatalogName(table.name)}": its client accessor ` +
          `"${snakeToCamelStr(table.name)}" is a reserved class member name, so the generated class could not declare it. ` +
          'Rename the table, or exclude it from generation (introspect `exclude`).',
      );
    }
    // Two columns on one field would emit a duplicate interface member (TS2300
    // in the consumer's build) and a `columnMap` missing a column. The rule is
    // introspect.ts's; re-asserting it here covers a hand-built or
    // engine-introspected schema that never went through that path.
    assertDistinctColumnFields(table.name, table.columns);
    // A column's type is emitted verbatim. Introspection only produces mapped
    // types, but hand-built or code-first metadata (`tsType` on defineSchema)
    // can carry anything, and a line break or a stray bracket would end the type
    // and start a statement in the generated file.
    for (const col of table.columns) {
      for (const text of [col.tsType, declaredTsTypeOf(col)]) {
        const problem = text === undefined ? null : tsTypeTextProblem(text);
        if (problem !== null) {
          throw new ValidationError(
            `Cannot generate code for column "${printableCatalogName(col.name)}" on table "${printableCatalogName(table.name)}": ` +
              `its TypeScript type ${printableCatalogName(JSON.stringify(text))} cannot be emitted, because ${problem}. Give one type on one line.`,
          );
        }
      }
    }
    // Only the relations that reach the TYPE layer: a relation shadowing a
    // column field is already dropped from types.ts, so refusing on its name
    // would refuse a schema that generates fine.
    for (const [relName, rel] of typeSafeRelations(table, false)) {
      requireEmittable(
        snakeToPascal(relName),
        `relation "${relName}" on table "${table.name}"`,
        'part of the generated `XWithY` interface name',
      );
      requireEmittable(
        entityName(rel.to),
        `relation "${relName}" on table "${table.name}" (target "${rel.to}")`,
        'the generated target entity type name',
      );
    }
  }
}

/**
 * Generate the contents of `types.ts` (entity interfaces, *Create / *Update,
 * *Relations brand-field interfaces, and the write input types). Exported so
 * tests can pin the generator output without writing files to disk.
 */
export function generateTypes(input: SchemaMetadata, options?: GenerateFileOptions): string {
  assertEmittableSchema(input);
  const schema = withDeclaredTypes(input);
  const overrides = resolveColumnTypeOverrides(schema, options?.columnTypes);
  const lines: string[] = [...generatedFileHeader(options)];

  // UpdateOperatorInput, SqlExpr and ColumnRef let the generated *Update
  // types express atomic operators, `expr.*` update expressions and `col()`.
  // RelationDescriptor is the brand that lets `WithResult` recurse through
  // nested `with` clauses at any depth.
  lines.push("import type { ColumnRef, RelationDescriptor, SqlExpr, UpdateOperatorInput } from 'turbine-orm';");
  lines.push('');

  // Relations that can be surfaced in the type layer, computed once per table
  // (relations that would shadow a scalar column field are excluded + warned).
  const safeRelationsByTable = new Map<string, [string, RelationDef][]>();
  for (const t of Object.values(schema.tables)) {
    safeRelationsByTable.set(t.name, typeSafeRelations(t));
  }
  const tablesWithRelations = new Set<string>();
  for (const t of Object.values(schema.tables)) {
    if ((safeRelationsByTable.get(t.name) ?? []).length > 0) tablesWithRelations.add(t.name);
  }
  const rowType = (table: TableMetadata, col: ColumnMetadata): string =>
    columnTsType(col, schema.enums, overrideFor(overrides, table.name, col.name));
  const writeType = (table: TableMetadata, col: ColumnMetadata): string =>
    writeColumnTsType(col, schema.enums, overrideFor(overrides, table.name, col.name));

  // Generate enum types
  for (const [enumName, labels] of Object.entries(schema.enums)) {
    const typeName = snakeToPascal(enumName);
    lines.push(`/** Database enum: ${docSafe(enumName)} */`);
    lines.push(`export type ${typeName} = ${labels.map((l) => `'${escSQ(l)}'`).join(' | ')};`);
    lines.push('');
  }

  // Generate entity types for each table
  for (const table of Object.values(schema.tables)) {
    const typeName = entityName(table.name);

    // --- Base entity interface ---
    lines.push(`/** Row type for the \`${docSafe(table.name)}\` table */`);
    lines.push(`export interface ${typeName} {`);
    for (const col of table.columns) {
      const pkNote = table.primaryKey.includes(col.name) ? ' (primary key)' : '';
      const nullNote = col.nullable ? ' (nullable)' : '';
      // PII columns are excluded from default projections, so the field is
      // absent unless the read passes `includePii: UNSAFE` (a `select` naming
      // it without the flag throws, and a write never returns it). The emitted
      // type marks it optional so it tells the truth about absence.
      const piiNote = col.pii ? ' (PII: absent unless the read passes includePii: UNSAFE)' : '';
      const optional = col.pii ? '?' : '';
      lines.push(`  /** Column: ${docSafe(col.name)}, ${docSafe(col.pgType)}${pkNote}${nullNote}${piiNote} */`);
      lines.push(`  ${quoteIfNeeded(col.field)}${optional}: ${rowType(table, col)};`);
    }
    lines.push('}');
    lines.push('');

    // --- Create input type ---
    // Optional: server-generated columns (serial / identity), columns with a
    // default, and nullable columns (default to NULL). Everything else is
    // required, PRIMARY KEY MEMBERSHIP INCLUDED: a text natural key, a
    // client-supplied uuid with no default, or a composite key of plain
    // integers must be supplied, or the database rejects the row (E010).
    lines.push(`/** Input type for creating a row in \`${docSafe(table.name)}\` */`);
    lines.push(`export type ${typeName}Create = {`);
    for (const col of table.columns) {
      // STORED generated columns are computed by the database, never writable.
      if (col.isGeneratedStored) continue;
      if (isOptionalOnCreate(col)) {
        const reason = col.isGenerated === true ? 'auto-generated' : col.hasDefault ? 'has default' : 'nullable';
        lines.push(`  /** Optional: ${reason} */`);
        lines.push(`  ${quoteIfNeeded(col.field)}?: ${writeType(table, col)} | undefined;`);
      } else {
        lines.push(`  ${quoteIfNeeded(col.field)}: ${writeType(table, col)};`);
      }
    }
    lines.push('};');
    lines.push('');

    // --- Update input type (all fields optional except PK) ---
    // Every field also takes `{ set: value }`, and numeric fields the atomic
    // operators (`{ viewCount: { increment: 1 } }`).
    const nonPkCols = table.columns.filter((c) => !table.primaryKey.includes(c.name) && !c.isGeneratedStored);
    lines.push(`/** Input type for updating a row in \`${docSafe(table.name)}\` */`);
    lines.push(`export type ${typeName}Update = {`);
    for (const col of nonPkCols) {
      lines.push(`  ${quoteIfNeeded(col.field)}?: ${updateFieldType(writeType(table, col))} | undefined;`);
    }
    lines.push('};');
    lines.push('');

    // --- Relations map (for type-safe `with` clauses) ---
    //
    // Each relation is a `RelationDescriptor<Target, Cardinality,
    // TargetRelations, Kind, Nullable>`. `WithResult` reads the third
    // parameter to recurse into nested `with` clauses and the fifth to type a
    // to-one relation whose foreign key is NOT NULL as never null; the write
    // input types read the kind.
    const safeRelations = safeRelationsByTable.get(table.name) ?? [];
    const hasRelations = safeRelations.length > 0;
    if (hasRelations) {
      lines.push(`/** Available relations for the \`${docSafe(table.name)}\` table */`);
      lines.push(`export interface ${typeName}Relations {`);
      for (const [relName, rel] of safeRelations) {
        const targetType = entityName(rel.to);
        // manyToMany is a collection too → 'many' cardinality (same as hasMany).
        const cardinality = isToMany(rel) ? "'many'" : "'one'";
        const targetRelations = tablesWithRelations.has(rel.to) ? `${targetType}Relations` : '{}';
        const notNull = isRequiredBelongsTo(table, rel) ? ', false' : '';
        lines.push(
          `  ${quoteIfNeeded(relName)}: RelationDescriptor<${targetType}, ${cardinality}, ${targetRelations}, '${escSQ(rel.type)}'${notNull}>;`,
        );
      }
      lines.push('}');
      lines.push('');

      // --- Legacy per-relation interfaces (kept for backward compatibility) ---
      for (const [relName, rel] of safeRelations) {
        const targetType = entityName(rel.to);
        const loaded = isToMany(rel)
          ? `${targetType}[]`
          : isRequiredBelongsTo(table, rel)
            ? targetType
            : `${targetType} | null`;
        lines.push(`/** ${typeName} with \`${docSafe(relName)}\` relation loaded (${rel.type}: ${docSafe(rel.to)}) */`);
        lines.push(`export interface ${typeName}With${snakeToPascal(relName)} extends ${typeName} {`);
        lines.push(`  ${quoteIfNeeded(relName)}: ${loaded};`);
        lines.push('}');
        lines.push('');
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Write input types: WhereUnique, CreateInput, UpdateInput, the nested
  // relation write inputs, and the per-table Inputs map the client accessor
  // takes.
  // ---------------------------------------------------------------------------

  for (const table of Object.values(schema.tables)) {
    emitWhereUnique(lines, table, (col) => rowType(table, { ...col, nullable: false, tsType: stripNull(col.tsType) }));
  }

  const variantsByTable = createVariantsByTable(schema, safeRelationsByTable);
  for (const table of Object.values(schema.tables)) {
    emitWriteInputs(lines, schema, table, safeRelationsByTable.get(table.name) ?? [], variantsByTable, (col) =>
      writeType(table, col),
    );
  }

  return lines.join('\n');
}

/** A to-many relation (an array on the row). */
function isToMany(rel: RelationDef): boolean {
  return rel.type === 'hasMany' || rel.type === 'manyToMany';
}

/** Whether a column may be omitted on create. */
function isOptionalOnCreate(col: ColumnMetadata): boolean {
  return col.isGenerated === true || col.hasDefault || col.nullable;
}

/** `T | null` -> `T`. */
function stripNull(tsType: string): string {
  return tsType.replace(/\s*\|\s*null$/, '');
}

/** The foreign-key columns of a relation, as columns of `table` (the side that holds them). */
function fkColumns(table: TableMetadata, rel: RelationDef): ColumnMetadata[] {
  const out: ColumnMetadata[] = [];
  for (const name of Array.isArray(rel.foreignKey) ? rel.foreignKey : [rel.foreignKey]) {
    const col = table.columns.find((c) => c.name === name);
    if (col) out.push(col);
  }
  return out;
}

/**
 * A belongsTo relation whose foreign key is NOT NULL, so a row always points
 * at a target row and reading the relation never yields null (absent a
 * per-relation `where` or a global filter on the target, see
 * `RelationDescriptor`).
 */
function isRequiredBelongsTo(table: TableMetadata, rel: RelationDef): boolean {
  if (rel.type !== 'belongsTo') return false;
  const fks = fkColumns(table, rel);
  return fks.length > 0 && fks.length === normalizeFk(rel).length && fks.every((c) => !c.nullable);
}

function normalizeFk(rel: RelationDef): string[] {
  return Array.isArray(rel.foreignKey) ? rel.foreignKey : [rel.foreignKey];
}

/**
 * The keys a nested create through `rel` (a hasMany / hasOne on `parent`) must
 * NOT require from the child: the child's foreign-key fields, which the
 * runtime fills from the parent row, and the child's matching belongsTo
 * relation, which would point the row at a second parent.
 */
function suppliedByParent(schema: SchemaMetadata, rel: RelationDef): string[] {
  if (rel.type !== 'hasMany' && rel.type !== 'hasOne') return [];
  const child = Object.hasOwn(schema.tables, rel.to) ? schema.tables[rel.to]! : undefined;
  if (!child) return [];
  const fks = normalizeFk(rel);
  const keys = fkColumns(child, rel).map((c) => c.field);
  const fkKey = [...fks].sort().join(',');
  for (const [name, back] of Object.entries(child.relations)) {
    if (back.type === 'belongsTo' && back.to === rel.from && [...normalizeFk(back)].sort().join(',') === fkKey) {
      keys.push(name);
    }
  }
  return keys;
}

/**
 * One shape of a table's create data. The full shape (`suffix` `''`) is
 * `XCreateInput`; a nested create through a parent's hasMany / hasOne leaves
 * out the keys that parent supplies ({@link suppliedByParent}) and is emitted
 * as its own concrete type, `XCreateWithout<Relation>Input` (Prisma's naming).
 * Concrete types rather than one generic `Omit<..., Omitted>` alias: the
 * generic form cost about 760 type instantiations per table just to compile
 * the generated file.
 */
interface CreateVariant {
  readonly omitted: ReadonlySet<string>;
  readonly suffix: string;
}

const FULL_CREATE_VARIANT: CreateVariant = { omitted: new Set(), suffix: '' };

function variantKey(omitted: readonly string[]): string {
  return JSON.stringify([...omitted].sort());
}

/** A PascalCase identifier fragment for a type name, or `''`. */
function identifierPart(name: string): string {
  return snakeToPascal(name).replace(/[^A-Za-z0-9_$]/g, '');
}

/**
 * Every create shape each table needs: the full one, plus one per distinct
 * set of parent-supplied keys among the hasMany / hasOne relations pointing at
 * it. Keyed by table name, then by {@link variantKey}.
 */
function createVariantsByTable(
  schema: SchemaMetadata,
  relationsByTable: ReadonlyMap<string, readonly [string, RelationDef][]>,
): Map<string, Map<string, CreateVariant>> {
  const out = new Map<string, Map<string, CreateVariant>>();
  for (const table of Object.values(schema.tables)) {
    out.set(table.name, new Map([[variantKey([]), FULL_CREATE_VARIANT]]));
  }
  for (const table of Object.values(schema.tables)) {
    for (const [, rel] of relationsByTable.get(table.name) ?? []) {
      const omitted = suppliedByParent(schema, rel);
      const variants = out.get(rel.to);
      if (omitted.length === 0 || !variants) continue;
      const key = variantKey(omitted);
      if (variants.has(key)) continue;
      const child = schema.tables[rel.to];
      // Name the variant after the child's relation back to the parent when
      // there is one (`PostCreateWithoutAuthorInput`), else after the keys.
      const back = omitted.find((k) => child !== undefined && Object.hasOwn(child.relations, k));
      const base = `Without${identifierPart(back ?? omitted.join('_')) || 'Parent'}`;
      const taken = new Set([...variants.values()].map((v) => v.suffix));
      let suffix = base;
      for (let n = 2; taken.has(suffix); n++) suffix = `${base}${n}`;
      variants.set(key, { omitted: new Set(omitted), suffix });
    }
  }
  return out;
}

/**
 * Required belongsTo relations beyond this many keep their foreign keys
 * optional on create instead of becoming an either-or union: TypeScript
 * multiplies an intersection of unions out, so N either-or pairs are 2^N
 * object types for every create on the table.
 */
const MAX_FK_CHOICES = 4;

/** `XWhereUnique`: one object per unique key, plus compound selector branches. */
function emitWhereUnique(lines: string[], table: TableMetadata, memberTs: (col: ColumnMetadata) => string): void {
  const typeName = entityName(table.name);
  // Union of unique constraint shapes, deduplicating PK
  const seen = new Set<string>();
  const uniqueSets: string[][] = [];
  const pkKey = table.primaryKey.join(',');
  seen.add(pkKey);
  uniqueSets.push(table.primaryKey);
  for (const uc of table.uniqueColumns) {
    const ucKey = uc.join(',');
    if (!seen.has(ucKey)) {
      seen.add(ucKey);
      uniqueSets.push(uc);
    }
  }

  const memberType = (colName: string): { field: string; tsType: string } => {
    const col = table.columns.find((c) => c.name === colName);
    return { field: col?.field ?? colName, tsType: col ? memberTs(col) : 'unknown' };
  };
  // Flat branches: one object per unique constraint carrying its columns.
  const flatBranches = uniqueSets.map((cols) => {
    const fields = cols.map((colName) => {
      const m = memberType(colName);
      return `${quoteIfNeeded(m.field)}: ${m.tsType}`;
    });
    return `{ ${fields.join('; ')} }`;
  });

  // Prisma-style compound-unique SELECTOR branches: a synthetic key
  // (`orgId_userId`) whose value holds the member columns, emitted for every
  // COMPOSITE unique (PK, composite UNIQUE constraint, or composite UNIQUE
  // index). Runtime expansion lives in query/compound-unique.ts.
  const compoundSeen = new Set<string>();
  const compoundSets: string[][] = [];
  const addCompound = (cols: string[]): void => {
    if (cols.length < 2) return;
    const key = cols.join(',');
    if (compoundSeen.has(key)) return;
    compoundSeen.add(key);
    compoundSets.push(cols);
  };
  addCompound(table.primaryKey);
  for (const uc of table.uniqueColumns) addCompound(uc);
  for (const idx of table.indexes) {
    // A partial unique index does not guarantee table-wide row uniqueness,
    // so it must not become a compound-unique selector (matches the runtime
    // exclusion in query/compound-unique.ts).
    if (idx.unique && !idx.docPath && !idx.partial) addCompound(idx.columns);
  }

  const selectorEntries = compoundSets.map((cols) => {
    const members = cols.map(memberType);
    return {
      // The selector NAME is the underscore-join of the member FIELD names.
      // A junction-style column that is not a valid identifier would join
      // into a broken object key, so a non-identifier name is emitted as ONE
      // quoted key; query/compound-unique.ts registers the same spelling.
      selectorName: quoteIfNeeded(members.map((m) => m.field).join('_')),
      memberType: `{ ${members.map((m) => `${quoteIfNeeded(m.field)}: ${m.tsType}`).join('; ')} }`,
    };
  });

  // Named helper type for annotating a compound selector by hand (Prisma parity).
  if (selectorEntries.length > 0) {
    const cuFields = selectorEntries.map((e) => `${e.selectorName}: ${e.memberType}`);
    lines.push(`export type ${typeName}CompoundUniques = { ${cuFields.join('; ')} };`);
  }

  const selectorBranches = selectorEntries.map((e) => `{ ${e.selectorName}: ${e.memberType} }`);
  const branches = [...flatBranches, ...selectorBranches];
  lines.push(`export type ${typeName}WhereUnique = ${branches.join(' | ')};`);
  lines.push('');
}

/**
 * The write inputs for one table:
 *
 *   - `XCreateInput`: the create data. A required belongsTo is an either-or:
 *     give the foreign key, or the relation (`connect` / `create` /
 *     `connectOrCreate`).
 *   - `XCreateWithout<Relation>Input`: the same data for a row created through
 *     a parent's hasMany / hasOne, without the keys that parent supplies (see
 *     {@link CreateVariant}).
 *   - `XUpdateInput`: update data, scalars plus nested relation writes.
 *   - `XNestedCreateInput` / `XNestedUpdateInput` / `XConnectOrCreate` (and
 *     their `Without<Relation>` forms): the ops a to-many (or hasOne) relation
 *     pointing at X takes.
 *   - `XNestedToOneCreateInput` / `XNestedToOneUpdateInput`: the ops a
 *     belongsTo relation pointing at X takes. Single objects; `disconnect` and
 *     `delete` take `true` for the connected row.
 *   - `XInputs`: the map the generated client hands to `QueryInterface`.
 */
function emitWriteInputs(
  lines: string[],
  schema: SchemaMetadata,
  table: TableMetadata,
  relations: readonly [string, RelationDef][],
  variantsByTable: ReadonlyMap<string, ReadonlyMap<string, CreateVariant>>,
  writeTs: (col: ColumnMetadata) => string,
): void {
  const typeName = entityName(table.name);
  const relationField = (rel: RelationDef, update: boolean): string => {
    const target = entityName(rel.to);
    if (rel.type === 'belongsTo') return `${target}NestedToOne${update ? 'Update' : 'Create'}Input`;
    const variant = variantsByTable.get(rel.to)?.get(variantKey(suppliedByParent(schema, rel))) ?? FULL_CREATE_VARIANT;
    return `${target}Nested${update ? 'Update' : 'Create'}${variant.suffix}Input`;
  };

  // Required belongsTo relations whose foreign keys are themselves required on
  // create become either-or choices.
  const choices: { relName: string; rel: RelationDef; fks: ColumnMetadata[] }[] = [];
  const relaxed: ColumnMetadata[] = [];
  for (const [relName, rel] of relations) {
    if (!isRequiredBelongsTo(table, rel)) continue;
    const fks = fkColumns(table, rel).filter((c) => !c.isGeneratedStored && !isOptionalOnCreate(c));
    if (fks.length === 0) continue;
    if (choices.length < MAX_FK_CHOICES) choices.push({ relName, rel, fks });
    else relaxed.push(...fks);
  }
  const choiceFields = new Set(choices.flatMap((c) => c.fks).map((c) => c.field));
  const relaxedFields = new Set(relaxed.map((c) => c.field));

  const where = `${typeName}WhereUnique`;
  const filter = `${typeName}WhereUnique | Partial<${typeName}>`;
  const variants = [...(variantsByTable.get(table.name)?.values() ?? [FULL_CREATE_VARIANT])];

  for (const { omitted, suffix } of variants) {
    // --- CreateInput (one concrete type per variant) ---
    const members: string[] = [];
    for (const col of table.columns) {
      if (col.isGeneratedStored || choiceFields.has(col.field) || omitted.has(col.field)) continue;
      const optional = isOptionalOnCreate(col) || relaxedFields.has(col.field);
      members.push(
        optional
          ? `${quoteIfNeeded(col.field)}?: ${writeTs(col)} | undefined`
          : `${quoteIfNeeded(col.field)}: ${writeTs(col)}`,
      );
    }
    for (const [relName, rel] of relations) {
      if (omitted.has(relName)) continue;
      members.push(`${quoteIfNeeded(relName)}?: ${relationField(rel, false)} | undefined`);
    }
    const parts = [members.length > 0 ? `{ ${members.join('; ')} }` : 'Record<string, never>'];
    for (const { relName, rel, fks } of choices) {
      if (omitted.has(relName) || fks.every((c) => omitted.has(c.field))) continue;
      const viaKey = fks.map((c) => `${quoteIfNeeded(c.field)}: ${writeTs(c)}`).join('; ');
      const viaRelation = [
        ...fks.map((c) => `${quoteIfNeeded(c.field)}?: ${writeTs(c)} | undefined`),
        `${quoteIfNeeded(relName)}: ${relationField(rel, false)}`,
      ].join('; ');
      parts.push(`({ ${viaKey} } | { ${viaRelation} })`);
    }
    const supplied = [...omitted].map((k) => `\`${docSafe(k)}\``).join(', ');
    lines.push(
      suffix === ''
        ? `/** Data for creating a \`${docSafe(table.name)}\` row */`
        : `/** Data for creating a \`${docSafe(table.name)}\` row through a parent relation, which supplies ${supplied} */`,
    );
    lines.push(`export type ${typeName}Create${suffix}Input = ${parts.join(' & ')};`);
    lines.push('');

    // --- Ops a to-many (or hasOne) relation pointing AT this table takes ---
    const create = `${typeName}Create${suffix}Input`;
    const connectOrCreate = `${typeName}ConnectOrCreate${suffix}`;
    lines.push(`export interface ${typeName}NestedCreate${suffix}Input {`);
    lines.push(`  create?: ${create} | ${create}[] | undefined;`);
    lines.push(`  connect?: ${where} | ${where}[] | undefined;`);
    lines.push(`  connectOrCreate?: ${connectOrCreate} | ${connectOrCreate}[] | undefined;`);
    lines.push('}');
    lines.push('');

    lines.push(
      `export interface ${typeName}NestedUpdate${suffix}Input extends ${typeName}NestedCreate${suffix}Input {`,
    );
    lines.push(`  disconnect?: ${filter} | (${filter})[] | undefined;`);
    lines.push(`  set?: ${where}[] | undefined;`);
    lines.push(`  delete?: ${filter} | (${filter})[] | undefined;`);
    const updateItem = `{ where: ${filter}; data: ${typeName}UpdateInput }`;
    lines.push(`  update?: ${updateItem} | ${updateItem}[] | undefined;`);
    const upsertItem = `{ where: ${filter}; create: ${create}; update: ${typeName}UpdateInput }`;
    lines.push(`  upsert?: ${upsertItem} | ${upsertItem}[] | undefined;`);
    lines.push('}');
    lines.push('');

    lines.push(`export interface ${connectOrCreate} {`);
    lines.push(`  where: ${where};`);
    lines.push(`  create: ${create};`);
    lines.push('}');
    lines.push('');
  }

  // --- UpdateInput ---
  if (relations.length > 0) {
    lines.push(`export type ${typeName}UpdateInput = ${typeName}Update & {`);
    for (const [relName, rel] of relations) {
      lines.push(`  ${quoteIfNeeded(relName)}?: ${relationField(rel, true)} | undefined;`);
    }
    lines.push('};');
  } else {
    lines.push(`export type ${typeName}UpdateInput = ${typeName}Update;`);
  }
  lines.push('');

  // A belongsTo points at ONE row: single objects, no `set`, and `true` (or
  // `{}`) for "the connected row" on disconnect / delete.
  const connected = `boolean | Record<string, never> | ${where}`;
  lines.push(`export interface ${typeName}NestedToOneCreateInput {`);
  lines.push(`  create?: ${typeName}CreateInput | undefined;`);
  lines.push(`  connect?: ${where} | undefined;`);
  lines.push(`  connectOrCreate?: ${typeName}ConnectOrCreate | undefined;`);
  lines.push('}');
  lines.push('');
  lines.push(`export interface ${typeName}NestedToOneUpdateInput extends ${typeName}NestedToOneCreateInput {`);
  lines.push(`  disconnect?: ${connected} | undefined;`);
  lines.push(`  delete?: ${connected} | undefined;`);
  lines.push(`  update?: { data: ${typeName}UpdateInput } | undefined;`);
  lines.push(
    `  upsert?: { where: ${filter}; create: ${typeName}CreateInput; update: ${typeName}UpdateInput } | undefined;`,
  );
  lines.push('}');
  lines.push('');

  // --- The accessor's input map ---
  lines.push(`/** Write and lookup input types for the \`${docSafe(table.name)}\` client accessor */`);
  lines.push(`export interface ${typeName}Inputs {`);
  lines.push(`  create: ${typeName}CreateInput;`);
  lines.push(`  createMany: ${typeName}Create;`);
  lines.push(`  update: ${typeName}UpdateInput;`);
  lines.push(`  updateMany: ${typeName}Update;`);
  lines.push(`  whereUnique: ${where};`);
  lines.push('}');
  lines.push('');
}

// ---------------------------------------------------------------------------
// zod.ts generator (H1, `turbine generate --zod`)
// ---------------------------------------------------------------------------

/**
 * Map a TypeScript primitive (as produced by {@link pgTypeToTs}) to its Zod
 * expression. `Date` uses `z.coerce.date()`, the generated schemas double as
 * request-body validators where dates arrive as ISO strings, and coercion keeps
 * both a `Date` and a valid date-string acceptable (documented decision).
 */
function zodScalar(ts: string): string {
  switch (ts) {
    case 'number':
      return 'z.number()';
    case 'string':
      return 'z.string()';
    case 'boolean':
      return 'z.boolean()';
    case 'Date':
      return 'z.coerce.date()';
    case 'bigint':
      return 'z.bigint()';
    case 'Buffer':
      return 'z.instanceof(Uint8Array)';
    case 'number[]':
      // pgvector, `pgTypeToTs('vector')` yields `number[]`.
      return 'z.array(z.number())';
    case 'number | string | bigint':
      // int8 write input.
      return 'z.union([z.number(), z.string(), z.bigint()])';
    case 'string | number':
      // numeric write input.
      return 'z.union([z.string(), z.number()])';
    case '{ x: number; y: number }':
      return 'z.object({ x: z.number(), y: z.number() })';
    case '{ x: number; y: number; radius: number }':
      return 'z.object({ x: z.number(), y: z.number(), radius: z.number() })';
    case '{ years?: number; months?: number; days?: number; hours?: number; minutes?: number; seconds?: number; milliseconds?: number }':
      // interval: the driver's parsed object, zero fields absent.
      return `z.object({ ${['years', 'months', 'days', 'hours', 'minutes', 'seconds', 'milliseconds'].map((f) => `${f}: z.number().optional()`).join(', ')} })`;
    default:
      // json/jsonb and any unmapped user-defined type.
      return 'z.unknown()';
  }
}

/**
 * Base Zod expression for a column, resolving enums → `z.enum([...])`, arrays →
 * `.array()`, and vectors → `z.array(z.number())`. Does NOT append
 * `.nullable()` / `.optional()`, callers layer those on per-schema.
 *
 * `forWrite` mirrors {@link writeColumnTsType}: the Create/Update schemas
 * validate WRITE input, where a `time` / `timetz` column also accepts a JS
 * `Date` (narrowed to its UTC time of day at bind time), so a bare
 * `z.string()` there would reject a value the runtime happily writes. The
 * full-row schema keeps `z.string()`, because that is what a read returns.
 */
function zodBaseType(col: ColumnMetadata, enums: Record<string, string[]>, forWrite = false): string {
  const dt = col.dialectType ?? col.pgType;
  const isArray = col.isArray || dt.startsWith('_');
  const base = isArray && dt.startsWith('_') ? dt.slice(1) : dt;

  let expr: string;
  if (Object.hasOwn(enums, base)) {
    expr = `z.enum([${enums[base]!.map((l) => `'${escSQ(l)}'`).join(', ')}])`;
  } else if (forWrite && timeOfDayKind(base)) {
    expr = 'z.union([z.string(), z.date()])';
  } else {
    // The read (or write) map decides the element type, which for an array
    // is not always the scalar's (`bigint[]` reads as strings).
    const full = (forWrite ? pgTypeToTsInput : pgTypeToTs)(isArray ? `_${base}` : base, false);
    const element = isArray && full.endsWith('[]') ? full.slice(0, -2).replace(/^\((.*)\)$/, '$1') : full;
    expr = zodScalar(element);
    if (isArray) expr += '.array()';
    return expr;
  }
  if (isArray) expr += '.array()';
  return expr;
}

/**
 * Generate the contents of `zod.ts`. Emits, per table, `XSchema` (the full
 * row), `XCreateSchema` (PK/defaulted/nullable columns optional, STORED
 * generated columns omitted), and `XUpdateSchema` (PK + STORED generated
 * columns omitted, every remaining column optional). Exported so tests can pin
 * the output without writing files.
 */
export function generateZod(schema: SchemaMetadata, options?: GenerateFileOptions): string {
  assertEmittableSchema(schema);
  const lines: string[] = [...generatedFileHeader(options)];
  // `zod` is a USER dependency, this generated file imports it, but the Turbine
  // library runtime never does, so Zod stays out of the package's dep graph.
  lines.push("import { z } from 'zod';");
  lines.push('');

  for (const table of Object.values(schema.tables)) {
    const typeName = entityName(table.name);

    // Full-row schema.
    lines.push(`/** Zod schema for a \`${docSafe(table.name)}\` row */`);
    lines.push(`export const ${typeName}Schema = z.object({`);
    for (const col of table.columns) {
      let expr = zodBaseType(col, schema.enums);
      if (col.nullable) expr += '.nullable()';
      lines.push(`  ${objectKey(col.field)}: ${expr},`);
    }
    lines.push('});');
    lines.push('');

    // Create schema, STORED generated columns can never be written;
    // server-generated, defaulted, and nullable columns are optional, the same
    // rule as the `*Create` type (a PK with none of those is required).
    lines.push(`/** Zod schema for creating a \`${docSafe(table.name)}\` row */`);
    lines.push(`export const ${typeName}CreateSchema = z.object({`);
    for (const col of table.columns) {
      if (col.isGeneratedStored) continue;
      let expr = zodBaseType(col, schema.enums, true);
      if (col.nullable) expr += '.nullable()';
      if (col.isGenerated === true || col.hasDefault || col.nullable) expr += '.optional()';
      lines.push(`  ${objectKey(col.field)}: ${expr},`);
    }
    lines.push('});');
    lines.push('');

    // Update schema, PK and STORED generated columns omitted; all else optional.
    lines.push(`/** Zod schema for updating a \`${docSafe(table.name)}\` row */`);
    lines.push(`export const ${typeName}UpdateSchema = z.object({`);
    for (const col of table.columns) {
      if (col.isGeneratedStored) continue;
      if (table.primaryKey.includes(col.name)) continue;
      let expr = zodBaseType(col, schema.enums, true);
      if (col.nullable) expr += '.nullable()';
      expr += '.optional()';
      lines.push(`  ${objectKey(col.field)}: ${expr},`);
    }
    lines.push('});');
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// metadata.ts generator
// ---------------------------------------------------------------------------

export function generateMetadata(schema: SchemaMetadata, options?: GenerateFileOptions): string {
  // metadata.ts is where a field collision does its runtime damage: the
  // emitted `columnMap` keeps whichever column was written last, so refuse it
  // here as well as in the type emitters (see assertEmittableSchema).
  for (const table of Object.values(schema.tables)) assertDistinctColumnFields(table.name, table.columns);
  const lines: string[] = [
    ...generatedFileHeader(options),
    "import type { SchemaMetadata } from 'turbine-orm';",
    '',
    'export const SCHEMA: SchemaMetadata = {',
    '  tables: {',
  ];

  for (const table of Object.values(schema.tables)) {
    lines.push(`    ${objectKey(table.name)}: {`);
    lines.push(`      name: '${escSQ(table.name)}',`);

    // columns
    lines.push('      columns: [');
    for (const col of table.columns) {
      lines.push(`        ${serializeColumn(col)},`);
    }
    lines.push('      ],');

    // columnMap
    lines.push('      columnMap: {');
    for (const [field, col] of Object.entries(table.columnMap)) {
      lines.push(`        ${objectKey(field)}: '${escSQ(col)}',`);
    }
    lines.push('      },');

    // reverseColumnMap
    lines.push('      reverseColumnMap: {');
    for (const [col, field] of Object.entries(table.reverseColumnMap)) {
      lines.push(`        ${objectKey(col)}: '${escSQ(field)}',`);
    }
    lines.push('      },');

    // dateColumns
    const dateCols = [...table.dateColumns];
    lines.push(`      dateColumns: new Set([${dateCols.map((c) => `'${escSQ(c)}'`).join(', ')}]),`);

    // dialectTypes + pgTypes (pgTypes is kept for backwards compatibility)
    const dialectTypes = table.dialectTypes ?? table.pgTypes;
    lines.push('      dialectTypes: {');
    for (const [col, dialectType] of Object.entries(dialectTypes)) {
      lines.push(`        ${objectKey(col)}: '${escSQ(dialectType)}',`);
    }
    lines.push('      },');
    lines.push('      pgTypes: {');
    for (const [col, pgType] of Object.entries(table.pgTypes)) {
      lines.push(`        ${objectKey(col)}: '${escSQ(pgType)}',`);
    }
    lines.push('      },');

    // allColumns
    lines.push(`      allColumns: [${table.allColumns.map((c) => `'${escSQ(c)}'`).join(', ')}],`);

    // primaryKey
    lines.push(`      primaryKey: [${table.primaryKey.map((c) => `'${escSQ(c)}'`).join(', ')}],`);

    // uniqueColumns
    lines.push(
      `      uniqueColumns: [${table.uniqueColumns.map((uc) => `[${uc.map((c) => `'${escSQ(c)}'`).join(', ')}]`).join(', ')}],`,
    );

    // relations
    lines.push('      relations: {');
    for (const [relName, rel] of Object.entries(table.relations)) {
      // Emit foreignKey/referenceKey as string for single-column, array for composite
      const fkLiteral = Array.isArray(rel.foreignKey)
        ? `[${rel.foreignKey.map((c) => `'${escSQ(c)}'`).join(', ')}]`
        : `'${escSQ(rel.foreignKey)}'`;
      const refLiteral = Array.isArray(rel.referenceKey)
        ? `[${rel.referenceKey.map((c) => `'${escSQ(c)}'`).join(', ')}]`
        : `'${escSQ(rel.referenceKey)}'`;
      // manyToMany relations carry a `through` junction descriptor, emit it so
      // the runtime query builder can JOIN through the junction table.
      let throughLiteral = '';
      if (rel.through) {
        const keyLiteral = (k: string | string[]) =>
          Array.isArray(k) ? `[${k.map((c) => `'${escSQ(c)}'`).join(', ')}]` : `'${escSQ(k)}'`;
        throughLiteral =
          `, through: { table: '${escSQ(rel.through.table)}', ` +
          `sourceKey: ${keyLiteral(rel.through.sourceKey)}, ` +
          `targetKey: ${keyLiteral(rel.through.targetKey)} }`;
      }
      lines.push(
        `        ${objectKey(relName)}: { type: '${escSQ(rel.type)}', name: '${escSQ(rel.name)}', from: '${escSQ(rel.from)}', to: '${escSQ(rel.to)}', foreignKey: ${fkLiteral}, referenceKey: ${refLiteral}${throughLiteral} },`,
      );
    }
    lines.push('      },');

    // indexes
    lines.push('      indexes: [');
    for (const idx of table.indexes) {
      // `partial` must round-trip: the runtime compound-unique derivation reads
      // the GENERATED metadata, so dropping the flag here would re-arm a
      // partial-unique selector that types.ts correctly excludes.
      const partialSeg = idx.partial ? ', partial: true' : '';
      lines.push(
        `        { name: '${escSQ(idx.name)}', columns: [${idx.columns.map((c) => `'${escSQ(c)}'`).join(', ')}], unique: ${idx.unique}${partialSeg}, definition: ${JSON.stringify(idx.definition)} },`,
      );
    }
    lines.push('      ],');

    // checks: introspected named CHECK constraints. Emitted only when present
    // (byte-stable for check-less tables) and sorted by name so `--no-timestamp`
    // output is deterministic regardless of catalog row order.
    if (table.checks && table.checks.length > 0) {
      const sortedChecks = [...table.checks].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      lines.push('      checks: [');
      for (const chk of sortedChecks) {
        lines.push(`        { name: '${escSQ(chk.name)}', expression: ${JSON.stringify(chk.expression)} },`);
      }
      lines.push('      ],');
    }

    // isView, read-only marker; the runtime write guard reads it.
    if (table.isView) lines.push('      isView: true,');

    lines.push('    },');
  }

  lines.push('  },');

  // enums
  lines.push('  enums: {');
  for (const [enumName, labels] of Object.entries(schema.enums)) {
    lines.push(`    ${objectKey(enumName)}: [${labels.map((l) => `'${escSQ(l)}'`).join(', ')}],`);
  }
  lines.push('  },');

  lines.push('};');
  lines.push('');

  // Back-compat lowercase alias. `SCHEMA` is the canonical export, but docs and
  // users frequently import `schema`; emit both so either name resolves.
  lines.push('export const schema = SCHEMA;');
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// index.ts generator (configured client with typed table accessors)
// ---------------------------------------------------------------------------

export function generateIndex(schema: SchemaMetadata, options?: GenerateFileOptions): string {
  assertEmittableSchema(schema);
  const tableEntries = Object.values(schema.tables);
  // Must mirror generateTypes: `XRelations` only exists in types.ts when the
  // table has at least one type-safe (non-column-shadowing) relation.
  const hasSafeRelations = new Map<string, boolean>();
  for (const t of tableEntries) hasSafeRelations.set(t.name, typeSafeRelations(t, false).length > 0);
  // F3: sibling-import extension. Defaults to '.js' for direct callers so their
  // output stays byte-stable; `generate()` resolves it (auto / js / none).
  const ext = options?.importExt ?? '.js';
  const lines: string[] = [
    ...generatedFileHeader(options),
    // Record the resolved import mode for debuggability (only when generate()
    // drove it, so direct generateIndex() callers stay byte-identical).
    ...(options?.importMode ? [`// Sibling imports resolved with importExtension: ${options.importMode}.`, ''] : []),
    "import { TurbineClient as BaseTurbineClient, TransactionClient as BaseTransactionClient, QueryInterface } from 'turbine-orm';",
    "import type { TurbineConfig, TransactionOptions, DeferredQuery, PipelineResults, WhereClause } from 'turbine-orm';",
    `import { SCHEMA } from './metadata${ext}';`,
  ];

  // Import all entity types and relations maps
  const typeImports: string[] = [];
  for (const t of tableEntries) {
    typeImports.push(entityName(t.name));
    if (hasSafeRelations.get(t.name)) {
      typeImports.push(`${entityName(t.name)}Relations`);
    }
    typeImports.push(`${entityName(t.name)}Inputs`);
  }
  lines.push(`import type { ${typeImports.join(', ')} } from './types${ext}';`);
  lines.push('');

  // Global filters keyed by table, each checked against its own row type, so a
  // misspelled table or column is a compile error. A table is keyed by its
  // client accessor, and also by its database name when the two differ, the
  // two spellings the runtime accepts.
  lines.push('/** `globalFilters` for this schema: a where clause (or a function returning one) per table. */');
  lines.push('export interface TurbineGlobalFilters {');
  for (const table of tableEntries) {
    const typeName = entityName(table.name);
    const where = `WhereClause<${typeName}${hasSafeRelations.get(table.name) ? `, ${typeName}Relations` : ''}>`;
    // `null` (or a function returning it) applies no filter on purpose.
    const filter = `${where} | null | (() => ${where} | null)`;
    const accessor = snakeToCamelStr(table.name);
    lines.push(`  ${quoteIfNeeded(accessor)}?: ${filter} | undefined;`);
    if (accessor !== table.name) lines.push(`  ${quoteIfNeeded(table.name)}?: ${filter} | undefined;`);
  }
  lines.push('}');
  lines.push('');
  // Each field also admits an explicit `undefined` (read as unset), so
  // `turbine({ connectionString: process.env.DATABASE_URL })` compiles under
  // exactOptionalPropertyTypes.
  lines.push('/** Client configuration with `globalFilters` typed against this schema. */');
  lines.push('export type TypedTurbineConfig = {');
  lines.push("  [K in Exclude<keyof TurbineConfig, 'globalFilters'>]?: TurbineConfig[K] | undefined;");
  lines.push('} & { globalFilters?: TurbineGlobalFilters | undefined };');
  lines.push('');

  // -------------------------------------------------------------------------
  // TypedTransactionClient, same typed table accessors as TurbineClient,
  // but scoped to a single transaction connection. The runtime instance is
  // an ordinary `TransactionClient` from turbine-orm; this declaration just
  // teaches TypeScript about the auto-attached accessors so users get
  // autocomplete inside `db.$transaction(async (tx) => tx.users.create(...))`.
  // -------------------------------------------------------------------------
  lines.push('/**');
  lines.push(' * Transaction-scoped client with the same typed table accessors as TurbineClient.');
  lines.push(' * Created automatically by `db.$transaction(async (tx) => ...)`, never instantiate');
  lines.push(' * directly. All queries run on a dedicated connection within a BEGIN/COMMIT block.');
  lines.push(' */');
  lines.push('export class TypedTransactionClient extends BaseTransactionClient {');
  for (const table of tableEntries) {
    const typeName = entityName(table.name);
    const accessor = snakeToCamelStr(table.name);
    const hasRelations = hasSafeRelations.get(table.name) === true;
    const genericArgs = `${typeName}, ${hasRelations ? `${typeName}Relations` : '{}'}, ${typeName}Inputs`;
    lines.push(`  /** Query interface for the \`${docSafe(table.name)}\` table (transaction-scoped) */`);
    lines.push(`  declare readonly ${accessor}: ${accessorType(table, genericArgs)};`);
  }
  // The nested `$transaction` (SAVEPOINT) hands its callback a typed client.
  // Declared as a real overriding method rather than through a same-named
  // interface (declaration merging), which strict lint configs reject
  // (no-unsafe-declaration-merging). It only narrows the callback's type:
  // the body is the base method.
  lines.push('');
  lines.push('  /**');
  lines.push('   * Nested transaction via SAVEPOINT. The callback receives a typed');
  lines.push('   * `TypedTransactionClient` so all table accessors auto-complete.');
  lines.push('   */');
  lines.push('  override $transaction<R>(fn: (tx: TypedTransactionClient) => Promise<R>): Promise<R> {');
  lines.push('    return super.$transaction(fn as (tx: BaseTransactionClient) => Promise<R>);');
  lines.push('  }');
  lines.push('}');
  lines.push('');

  // Generate the client class with JSDoc
  lines.push('/**');
  lines.push(' * Generated Turbine client with typed table accessors.');
  lines.push(' *');
  lines.push(' * Tables:');
  for (const table of tableEntries) {
    lines.push(` *   - \`${docSafe(snakeToCamelStr(table.name))}\` (${docSafe(table.name)})`);
  }
  lines.push(' *');
  lines.push(' * @example');
  lines.push(' * ```ts');
  lines.push(' * const db = turbine({ connectionString: process.env.DATABASE_URL });');
  if (tableEntries.length > 0) {
    const firstTable = tableEntries[0]!;
    const accessor = snakeToCamelStr(firstTable.name);
    lines.push(` * const rows = await db.${docSafe(accessor)}.findMany();`);
  }
  lines.push(' * ```');
  lines.push(' */');
  lines.push('export class TurbineClient extends BaseTurbineClient {');
  for (const table of tableEntries) {
    const typeName = entityName(table.name);
    const accessor = snakeToCamelStr(table.name);
    const hasRelations = hasSafeRelations.get(table.name) === true;
    const genericArgs = `${typeName}, ${hasRelations ? `${typeName}Relations` : '{}'}, ${typeName}Inputs`;
    lines.push(`  /** Query interface for the \`${docSafe(table.name)}\` table */`);
    lines.push(`  declare readonly ${accessor}: ${accessorType(table, genericArgs)};`);
  }
  lines.push('');
  lines.push('  constructor(config?: TypedTurbineConfig) {');
  lines.push('    super(config as TurbineConfig | undefined, SCHEMA);');
  lines.push('  }');
  // Typed `$transaction` / `$withSession`: the callback parameter is narrowed
  // to `TypedTransactionClient`, so `tx.users` etc. autocomplete. Real
  // overriding methods whose bodies are the base methods, NOT a same-named
  // interface merged onto the class: strict lint configs reject that merge
  // (no-unsafe-declaration-merging), and generated code must pass them.
  //
  // Each overload must stay compatible with the base class's (TS2416): the
  // base `$transaction` has a callback form AND a batch-array form, so both
  // are redeclared, and `$withSession` mirrors the base parameter list.
  // src/test/generate-typecheck.test.ts compiles the result.
  lines.push('');
  lines.push('  /**');
  lines.push('   * Run a callback inside a transaction. The callback receives a typed');
  lines.push('   * `TypedTransactionClient` with autocompletion for every table accessor.');
  lines.push('   */');
  lines.push('  override $transaction<R>(');
  lines.push('    fn: (tx: TypedTransactionClient) => Promise<R>,');
  lines.push('    options?: TransactionOptions,');
  lines.push('  ): Promise<R>;');
  lines.push('  /**');
  lines.push('   * Batch form: run several deferred queries in one transaction and get');
  lines.push('   * their results as a tuple (same as the base client).');
  lines.push('   */');
  lines.push('  override $transaction<T extends readonly DeferredQuery<unknown>[]>(');
  lines.push('    queries: readonly [...T],');
  lines.push('    options?: TransactionOptions,');
  lines.push('  ): Promise<PipelineResults<T>>;');
  lines.push('  override $transaction(');
  lines.push(
    '    fnOrQueries: ((tx: TypedTransactionClient) => Promise<unknown>) | readonly DeferredQuery<unknown>[],',
  );
  lines.push('    options?: TransactionOptions,');
  lines.push('  ): Promise<unknown> {');
  lines.push(
    "    return super.$transaction(fnOrQueries as Parameters<BaseTurbineClient['$transaction']>[0], options);",
  );
  lines.push('  }');
  lines.push('');
  lines.push('  /**');
  lines.push('   * Run a callback inside a transaction with the given session GUCs applied');
  lines.push('   * via `set_config(..., true)` (the RLS / multi-tenant shorthand). The');
  lines.push('   * callback receives a typed `TypedTransactionClient`, same as `$transaction`.');
  lines.push('   */');
  lines.push('  override $withSession<R>(');
  lines.push('    context: Record<string, string | number | boolean>,');
  lines.push('    fn: (tx: TypedTransactionClient) => Promise<R>,');
  lines.push('  ): Promise<R> {');
  lines.push('    return super.$withSession(context, fn as (tx: BaseTransactionClient) => Promise<R>);');
  lines.push('  }');
  lines.push('}');
  lines.push('');

  // Factory function with JSDoc
  lines.push('/**');
  lines.push(' * Create a new Turbine client instance.');
  lines.push(' *');
  lines.push(' * @param config - Connection configuration. Omit it (or pass no connection');
  lines.push(' *   fields) to fall back to the `DATABASE_URL` environment variable.');
  lines.push(' * @returns A fully-typed TurbineClient with table accessors.');
  lines.push(' */');
  lines.push('export function turbine(config?: TypedTurbineConfig): TurbineClient {');
  lines.push('  return new TurbineClient(config);');
  lines.push('}');
  lines.push('');

  // Re-export everything
  lines.push(`export * from './types${ext}';`);
  lines.push(`export { SCHEMA } from './metadata${ext}';`);
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// prisma-map.ts generator
// ---------------------------------------------------------------------------

/**
 * Serialize a resolved {@link PrismaCompatMap} into a `prisma-map.ts` module
 * that exports `export const PRISMA_MAP: PrismaCompatMap = {...}`. Written next
 * to the generated client by `turbine migrate-from-prisma`; consumed later by
 * the phase-2 `turbine-orm/prisma-compat` runtime adapter.
 *
 * Deterministic: uses the same reproducible header as the other emitters, so a
 * stable input regenerates byte-identical output under `noTimestamp`.
 */
export function generatePrismaMap(map: PrismaCompatMap, options?: GenerateFileOptions): string {
  const lines: string[] = [
    ...generatedFileHeader(options),
    "import type { PrismaCompatMap } from 'turbine-orm';",
    '',
    '/**',
    ' * Name map from your Prisma schema onto this Turbine client. Every entry was',
    ' * resolved against the live database; unresolved items are omitted (see the',
    ' * migration report). Pass this to the phase-2 prisma-compat adapter, or read',
    ' * it directly for hand-written compatibility wrappers.',
    ' */',
    'export const PRISMA_MAP: PrismaCompatMap = {',
    '  models: {',
  ];

  for (const [modelName, model] of Object.entries(map.models)) {
    lines.push(`    ${objectKey(modelName)}: {`);
    lines.push(`      table: '${escSQ(model.table)}',`);
    lines.push(`      accessor: '${escSQ(model.accessor)}',`);
    lines.push(`      fields: ${serializeStringRecord(model.fields)},`);
    lines.push('      relations: {');
    for (const [rel, r] of Object.entries(model.relations)) {
      lines.push(`        ${objectKey(rel)}: { name: '${escSQ(r.name)}', cardinality: '${r.cardinality}' },`);
    }
    lines.push('      },');
    lines.push(`      compoundUniques: ${serializeStringArrayRecord(model.compoundUniques)},`);
    if (model.clientDefaults && Object.keys(model.clientDefaults).length > 0) {
      lines.push(`      clientDefaults: ${serializeStringRecord(model.clientDefaults)},`);
    }
    lines.push('    },');
  }
  lines.push('  },');
  lines.push(`  enums: ${serializeStringRecord(map.enums)},`);
  if (map.source) {
    // Provenance, so the runtime adapter can tell you this file is stale rather
    // than behaving as if the schema never changed.
    lines.push(`  source: { path: '${escSQ(map.source.path)}', hash: '${escSQ(map.source.hash)}' },`);
  }
  lines.push('};');
  lines.push('');

  return lines.join('\n');
}

/** Serialize a `Record<string, string>` as an inline object literal. */
function serializeStringRecord(rec: Record<string, string>): string {
  const entries = Object.entries(rec);
  if (entries.length === 0) return '{}';
  return `{ ${entries.map(([k, v]) => `${objectKey(k)}: '${escSQ(v)}'`).join(', ')} }`;
}

/** Serialize a `Record<string, string[]>` as an inline object literal. */
function serializeStringArrayRecord(rec: Record<string, string[]>): string {
  const entries = Object.entries(rec);
  if (entries.length === 0) return '{}';
  return `{ ${entries.map(([k, v]) => `${objectKey(k)}: [${v.map((s) => `'${escSQ(s)}'`).join(', ')}]`).join(', ')} }`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The generated table-accessor type. A view (`isView`) without a primary key
 * cannot be looked up by unique key, so its `findUnique`-family methods are
 * excluded via `Omit`. Everything else is a plain `QueryInterface<…>`.
 */
function accessorType(table: TableMetadata, genericArgs: string): string {
  const base = `QueryInterface<${genericArgs}>`;
  if (table.isView && table.primaryKey.length === 0) {
    return `Omit<${base}, 'findUnique' | 'findUniqueOrThrow'>`;
  }
  return base;
}

function serializeColumn(col: ColumnMetadata): string {
  const parts = [
    `name: '${escSQ(col.name)}'`,
    `field: '${escSQ(col.field)}'`,
    `dialectType: '${escSQ(col.dialectType ?? col.pgType)}'`,
    `pgType: '${escSQ(col.pgType)}'`,
    `tsType: '${escSQ(col.tsType)}'`,
    `nullable: ${col.nullable}`,
    `hasDefault: ${col.hasDefault}`,
    `isArray: ${col.isArray}`,
    `arrayType: '${escSQ(col.arrayType ?? col.pgArrayType)}'`,
    `pgArrayType: '${escSQ(col.pgArrayType)}'`,
  ];
  // Cross-schema type marker, introspection records it only for types living
  // outside the introspected schema; it must survive codegen or the runtime
  // enum-cast guard in query/builder.ts loses the signal.
  if (col.pgTypeSchema !== undefined) parts.push(`pgTypeSchema: '${escSQ(col.pgTypeSchema)}'`);
  // Emit isGenerated only when set (server-generated serial/identity), so the
  // output stays byte-identical for the common client-default columns.
  if (col.isGenerated) parts.push(`isGenerated: true`);
  // STORED generated columns, the runtime write guard reads isGeneratedStored.
  if (col.isGeneratedStored) parts.push(`isGeneratedStored: true`);
  if (col.generationExpression !== undefined) {
    parts.push(`generationExpression: '${escSQ(col.generationExpression)}'`);
  }
  // PII marker: emitted only when set, so untagged schemas stay byte-identical.
  // Introspection never sets this (code-first declaration), but a metadata
  // object built from `defineSchema` (pii: true) carries it through codegen.
  if (col.pii) parts.push(`pii: true`);
  if (col.updatedAt) parts.push(`updatedAt: true`);
  if (col.maxLength !== undefined) parts.push(`maxLength: ${col.maxLength}`);
  // The default expression, so an engine without column defaults (PowDB) can
  // apply it on create. Arbitrary SQL text, so written as a JSON string
  // literal, which escapes every quote, backslash and line break.
  if (col.defaultValue != null) parts.push(`defaultValue: ${JSON.stringify(col.defaultValue)}`);
  return `{ ${parts.join(', ')} }`;
}

/**
 * The subset of names emitted BARE in generated object-key position. Anchored
 * on purpose: the previous rule only tested whether a name contained a
 * character outside the set, so a name made entirely of allowed characters but
 * starting with a digit (`2fa`) was emitted bare and did not parse.
 */
const BARE_KEY_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Emit `s` in generated object-KEY position.
 *
 * A key is the one place in the output where catalog text would otherwise land
 * in EXPRESSION position: `{ [expr]: v }` is a COMPUTED key, evaluated when the
 * object is constructed, so an unquoted name carrying brackets runs on
 * `import`. The bare form is therefore gated on a WHOLE-STRING match of the
 * identifier grammar, which no bracket, parenthesis, quote, newline, or space
 * can pass; every other name becomes a fully escaped string literal, which is
 * inert in key position.
 *
 * The literal has to be ESCAPED, not merely wrapped: this function used to
 * return `'${s}'` verbatim, so a name containing a quote closed the key and
 * reopened in expression position.
 *
 * A name of `__proto__` is safe in an interface but not in an object literal;
 * see {@link objectKey}.
 */
function quoteIfNeeded(s: string): string {
  return BARE_KEY_RE.test(s) ? s : `'${escSQ(s)}'`;
}

/**
 * {@link quoteIfNeeded} for a key in an OBJECT LITERAL that is evaluated at
 * runtime (metadata.ts, the Prisma map). `{ '__proto__': v }` sets the literal's
 * prototype instead of defining a property, quoted or not, so that one name is
 * emitted as a computed key, whose string literal is just as inert and which does
 * define the property. Interface members (types.ts) have no such rule and keep
 * using {@link quoteIfNeeded}.
 */
function objectKey(s: string): string {
  return s === '__proto__' ? "['__proto__']" : quoteIfNeeded(s);
}

function snakeToCamelStr(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Build the update-input field type for a column: the plain value, the
 * {@link UpdateOperatorInput} object (`{ set }` on every column, plus
 * `increment` / `decrement` / `multiply` / `divide` when the type includes
 * `number`), an `expr.*` update expression or a `col()` reference, matching
 * what `update()` accepts at runtime and the core `UpdateData` type.
 */
function updateFieldType(tsType: string): string {
  return `${tsType} | UpdateOperatorInput<${tsType}> | SqlExpr<${tsType}> | ColumnRef`;
}
