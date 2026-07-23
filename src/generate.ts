/**
 * turbine-orm — Code generator
 *
 * Takes an IntrospectedSchema and emits TypeScript files:
 *   - types.ts     — Entity interfaces, Create/Update input types
 *   - metadata.ts  — Runtime schema metadata (column maps, relations, etc.)
 *   - index.ts     — Configured TurbineClient with typed table accessors
 *
 * Output goes to the specified directory (default: ./generated/turbine/).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  type ColumnMetadata,
  pgTypeToTs,
  type RelationDef,
  type SchemaMetadata,
  singularize,
  snakeToPascal,
  type TableMetadata,
} from './schema.js';

/** Get the TypeScript type name for a table (singularized PascalCase) */
function entityName(tableName: string): string {
  return snakeToPascal(singularize(tableName));
}

/**
 * Resolve the TypeScript type for a column, mapping enum-typed columns to their
 * generated string-literal union (PascalCase enum name) instead of the
 * `unknown` that {@link pgTypeToTs} yields for user-defined types. Falls back to
 * the introspected `col.tsType` for every non-enum column.
 */
function columnTsType(col: ColumnMetadata, enums: Record<string, string[]>): string {
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

/** Escape a value for embedding in a single-quoted TypeScript string literal */
function escSQ(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
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
   * package — it is never imported by Turbine's runtime, so Zod stays out of the
   * library's dependency graph. Default: `false`.
   */
  zod?: boolean;
  /**
   * Omit the `Generated at: <ISO timestamp>` line from every generated file
   * header (T-8b — reproducible codegen). With this set, byte-identical
   * schemas regenerate to byte-identical output, so regens produce empty
   * diffs. Default: `false` (timestamp included, unchanged behavior).
   */
  noTimestamp?: boolean;
}

/** Per-file generator options (subset of {@link GenerateOptions} the emitters need). */
export interface GenerateFileOptions {
  /** Omit the `Generated at:` header line for reproducible output. */
  noTimestamp?: boolean;
}

// ---------------------------------------------------------------------------
// Main generate function
// ---------------------------------------------------------------------------

export function generate(options: GenerateOptions): { outDir: string; files: string[] } {
  const outDir = options.outDir ?? './generated/turbine';

  // Path traversal protection — ensure output stays within project root
  const resolved = resolve(outDir);
  const rel = relative(process.cwd(), resolved);
  if (rel.startsWith('..') || resolve(rel) !== resolved) {
    throw new Error(`Output directory must be within the project root. Got: ${outDir}`);
  }

  mkdirSync(outDir, { recursive: true });

  const files: string[] = [];
  const fileOptions: GenerateFileOptions = { noTimestamp: options.noTimestamp };

  // Generate types.ts
  const typesContent = generateTypes(options.schema, fileOptions);
  writeFileSync(join(outDir, 'types.ts'), typesContent, 'utf-8');
  files.push('types.ts');

  // Generate metadata.ts
  const metadataContent = generateMetadata(options.schema, fileOptions);
  writeFileSync(join(outDir, 'metadata.ts'), metadataContent, 'utf-8');
  files.push('metadata.ts');

  // Generate index.ts (configured client)
  const indexContent = generateIndex(options.schema, fileOptions);
  writeFileSync(join(outDir, 'index.ts'), indexContent, 'utf-8');
  files.push('index.ts');

  // Generate zod.ts (optional — --zod flag)
  if (options.zod) {
    const zodContent = generateZod(options.schema, fileOptions);
    writeFileSync(join(outDir, 'zod.ts'), zodContent, 'utf-8');
    files.push('zod.ts');
  }

  return { outDir, files };
}

// ---------------------------------------------------------------------------
// types.ts generator
// ---------------------------------------------------------------------------

function generatedFileHeader(options?: GenerateFileOptions): string[] {
  // `noTimestamp` omits the volatile line entirely (T-8b) so regenerating an
  // unchanged schema produces byte-identical files.
  return [
    '/**',
    ' * Auto-generated by turbine-orm — DO NOT EDIT',
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
 * disambiguated at the source), but hand-written or legacy metadata may —
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
          `[turbine] Relation "${relName}" on table "${table.name}" shadows a column field of the same name — ` +
            `omitting it from the generated types. Rename the relation (or the column) to expose it.`,
        );
      }
      continue;
    }
    usable.push([relName, rel]);
  }
  return usable;
}

/**
 * Generate the contents of `types.ts` (entity interfaces, *Create / *Update,
 * and *Relations brand-field interfaces). Exported so tests can pin the
 * generator output without writing files to disk.
 */
export function generateTypes(schema: SchemaMetadata, options?: GenerateFileOptions): string {
  const lines: string[] = [...generatedFileHeader(options)];

  // We import UpdateOperatorInput so generated *Update types can express
  // atomic increment / decrement / multiply / divide / set operators on
  // numeric columns (TASK-3.4).
  //
  // RelationDescriptor is the brand-field interface that lets `WithResult`
  // recurse through nested `with` clauses at any depth. The generator emits
  // each `*Relations` member as a `RelationDescriptor<Target, Cardinality,
  // TargetRelations>` so users get full deep `with`-clause type inference
  // out of the box (TASK-2.1).
  lines.push("import type { RelationDescriptor, UpdateOperatorInput } from 'turbine-orm';");
  lines.push('');

  // Pre-compute which tables have relations so we know whether to thread
  // `${TargetType}Relations` (for deep inference) or `{}` (the no-relations
  // default) into each `RelationDescriptor`. Built once up-front because
  // relations can point at tables we haven't iterated to yet.
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

  // Generate enum types
  for (const [enumName, labels] of Object.entries(schema.enums)) {
    const typeName = snakeToPascal(enumName);
    lines.push(`/** Database enum: ${enumName} */`);
    lines.push(`export type ${typeName} = ${labels.map((l) => `'${escSQ(l)}'`).join(' | ')};`);
    lines.push('');
  }

  // Generate entity types for each table
  for (const table of Object.values(schema.tables)) {
    const typeName = entityName(table.name);

    // --- Base entity interface ---
    lines.push(`/** Row type for the \`${table.name}\` table */`);
    lines.push(`export interface ${typeName} {`);
    for (const col of table.columns) {
      const pkNote = table.primaryKey.includes(col.name) ? ' (primary key)' : '';
      const nullNote = col.nullable ? ' (nullable)' : '';
      // PII columns are excluded from default projections, so the field is
      // absent unless the query names it in `select` or passes `includePii`.
      // The emitted type marks it optional so it tells the truth about absence.
      const piiNote = col.pii ? ' (PII: absent unless selected or includePii)' : '';
      const optional = col.pii ? '?' : '';
      lines.push(`  /** Column: ${col.name}, ${col.pgType}${pkNote}${nullNote}${piiNote} */`);
      lines.push(`  ${col.field}${optional}: ${columnTsType(col, schema.enums)};`);
    }
    lines.push('}');
    lines.push('');

    // --- Create input type ---
    // Required: non-nullable columns without defaults (except PK)
    // Optional: nullable columns (default to NULL) or columns with explicit defaults
    lines.push(`/** Input type for creating a row in \`${table.name}\` */`);
    lines.push(`export type ${typeName}Create = {`);
    for (const col of table.columns) {
      // STORED generated columns are computed by the database — never writable.
      if (col.isGeneratedStored) continue;
      const isPk = table.primaryKey.includes(col.name);
      const isOptional = col.hasDefault || col.nullable || isPk;
      if (isOptional) {
        const reason = isPk ? 'auto-generated' : col.hasDefault ? 'has default' : 'nullable';
        lines.push(`  /** Optional: ${reason} */`);
        lines.push(`  ${col.field}?: ${columnTsType(col, schema.enums)};`);
      } else {
        lines.push(`  ${col.field}: ${columnTsType(col, schema.enums)};`);
      }
    }
    lines.push('};');
    lines.push('');

    // --- Update input type (all fields optional except PK) ---
    // Numeric columns additionally accept `UpdateOperatorInput<number>` so
    // users can write `{ viewCount: { increment: 1 } }` without an `as any`.
    const nonPkCols = table.columns.filter((c) => !table.primaryKey.includes(c.name) && !c.isGeneratedStored);
    lines.push(`/** Input type for updating a row in \`${table.name}\` */`);
    lines.push(`export type ${typeName}Update = {`);
    for (const col of nonPkCols) {
      lines.push(`  ${col.field}?: ${updateFieldType(columnTsType(col, schema.enums))};`);
    }
    lines.push('};');
    lines.push('');

    // --- Relations map (for type-safe `with` clauses) ---
    //
    // Each relation is emitted as a `RelationDescriptor<Target, Cardinality,
    // TargetRelations>` brand-field interface. This is what enables the
    // recursive `WithResult` type to walk through nested `with` clauses at
    // any depth — `RelationRelations<R[K]>` reads the third type parameter
    // and threads it into the next recursion step. If the target table has
    // no relations of its own, the descriptor uses `{}` (the default).
    const safeRelations = safeRelationsByTable.get(table.name) ?? [];
    const hasRelations = safeRelations.length > 0;
    if (hasRelations) {
      lines.push(`/** Available relations for the \`${table.name}\` table */`);
      lines.push(`export interface ${typeName}Relations {`);
      for (const [relName, rel] of safeRelations) {
        const targetType = entityName(rel.to);
        // manyToMany is a collection too → 'many' cardinality (same as hasMany).
        const cardinality = rel.type === 'hasMany' || rel.type === 'manyToMany' ? "'many'" : "'one'";
        const targetRelations = tablesWithRelations.has(rel.to) ? `${targetType}Relations` : '{}';
        lines.push(`  ${relName}: RelationDescriptor<${targetType}, ${cardinality}, ${targetRelations}>;`);
      }
      lines.push('}');
      lines.push('');

      // --- Legacy per-relation interfaces (kept for backward compatibility) ---
      for (const [relName, rel] of safeRelations) {
        const targetType = entityName(rel.to);
        if (rel.type === 'hasMany' || rel.type === 'manyToMany') {
          lines.push(`/** ${typeName} with \`${relName}\` relation loaded (${rel.type}: ${rel.to}) */`);
          lines.push(`export interface ${typeName}With${snakeToPascal(relName)} extends ${typeName} {`);
          lines.push(`  ${relName}: ${targetType}[];`);
          lines.push('}');
        } else {
          lines.push(`/** ${typeName} with \`${relName}\` relation loaded (${rel.type}: ${rel.to}) */`);
          lines.push(`export interface ${typeName}With${snakeToPascal(relName)} extends ${typeName} {`);
          lines.push(`  ${relName}: ${targetType} | null;`);
          lines.push('}');
        }
        lines.push('');
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Nested write types (WhereUnique, NestedCreateInput, NestedUpdateInput,
  // ConnectOrCreate, CreateInput, UpdateInput)
  // ---------------------------------------------------------------------------

  for (const table of Object.values(schema.tables)) {
    const typeName = entityName(table.name);
    const safeRelations = safeRelationsByTable.get(table.name) ?? [];
    const hasRels = safeRelations.length > 0;

    // WhereUnique — union of unique constraint shapes, deduplicating PK
    const seen = new Set<string>();
    const uniqueSets: string[][] = [];

    // Always include the primary key first
    const pkKey = table.primaryKey.join(',');
    seen.add(pkKey);
    uniqueSets.push(table.primaryKey);

    // Add unique indexes that aren't duplicates of the PK
    for (const uc of table.uniqueColumns) {
      const ucKey = uc.join(',');
      if (!seen.has(ucKey)) {
        seen.add(ucKey);
        uniqueSets.push(uc);
      }
    }

    if (uniqueSets.length > 0) {
      const memberType = (colName: string): { field: string; tsType: string } => {
        const col = table.columns.find((c) => c.name === colName);
        return { field: col?.field ?? colName, tsType: col?.tsType ?? 'unknown' };
      };
      // Flat branches: one object per unique constraint carrying its columns.
      const flatBranches = uniqueSets.map((cols) => {
        const fields = cols.map((colName) => {
          const m = memberType(colName);
          return `${m.field}: ${m.tsType}`;
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
        if (idx.unique && !idx.docPath) addCompound(idx.columns);
      }

      const selectorEntries = compoundSets.map((cols) => {
        const members = cols.map(memberType);
        return {
          selectorName: members.map((m) => m.field).join('_'),
          memberType: `{ ${members.map((m) => `${m.field}: ${m.tsType}`).join('; ')} }`,
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

    // CreateInput / UpdateInput — extends base type with optional relation fields
    if (hasRels) {
      lines.push(`export type ${typeName}CreateInput = ${typeName}Create & {`);
      for (const [relName, rel] of safeRelations) {
        const targetType = entityName(rel.to);
        lines.push(`  ${relName}?: ${targetType}NestedCreateInput;`);
      }
      lines.push('};');
      lines.push('');

      lines.push(`export type ${typeName}UpdateInput = ${typeName}Update & {`);
      for (const [relName, rel] of safeRelations) {
        const targetType = entityName(rel.to);
        if (rel.type === 'hasMany') {
          lines.push(`  ${relName}?: ${targetType}NestedUpdateInput;`);
        } else {
          lines.push(`  ${relName}?: ${targetType}NestedCreateInput;`);
        }
      }
      lines.push('};');
      lines.push('');
    }
  }

  // Emit NestedCreateInput, NestedUpdateInput, ConnectOrCreate for every table
  for (const table of Object.values(schema.tables)) {
    const typeName = entityName(table.name);
    const hasRels = (safeRelationsByTable.get(table.name) ?? []).length > 0;

    // NestedCreateInput uses *CreateInput (which includes relation fields) when
    // the table has relations, otherwise falls back to the plain *Create type.
    const createRefType = hasRels ? `${typeName}CreateInput` : `${typeName}Create`;

    lines.push(`export interface ${typeName}NestedCreateInput {`);
    lines.push(`  create?: ${createRefType} | ${createRefType}[];`);
    lines.push(`  connect?: ${typeName}WhereUnique | ${typeName}WhereUnique[];`);
    lines.push(`  connectOrCreate?: ${typeName}ConnectOrCreate | ${typeName}ConnectOrCreate[];`);
    lines.push('}');
    lines.push('');

    lines.push(`export interface ${typeName}NestedUpdateInput {`);
    lines.push(`  create?: ${createRefType} | ${createRefType}[];`);
    lines.push(`  connect?: ${typeName}WhereUnique | ${typeName}WhereUnique[];`);
    lines.push(`  connectOrCreate?: ${typeName}ConnectOrCreate | ${typeName}ConnectOrCreate[];`);
    lines.push(`  disconnect?: ${typeName}WhereUnique | ${typeName}WhereUnique[];`);
    lines.push(`  set?: ${typeName}WhereUnique[];`);
    lines.push(`  delete?: ${typeName}WhereUnique | ${typeName}WhereUnique[];`);
    lines.push('}');
    lines.push('');

    lines.push(`export interface ${typeName}ConnectOrCreate {`);
    lines.push(`  where: ${typeName}WhereUnique;`);
    lines.push(`  create: ${createRefType};`);
    lines.push('}');
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// zod.ts generator (H1 — `turbine generate --zod`)
// ---------------------------------------------------------------------------

/**
 * Map a TypeScript primitive (as produced by {@link pgTypeToTs}) to its Zod
 * expression. `Date` uses `z.coerce.date()` — the generated schemas double as
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
      // pgvector — `pgTypeToTs('vector')` yields `number[]`.
      return 'z.array(z.number())';
    default:
      // json/jsonb and any unmapped user-defined type.
      return 'z.unknown()';
  }
}

/**
 * Base Zod expression for a column, resolving enums → `z.enum([...])`, arrays →
 * `.array()`, and vectors → `z.array(z.number())`. Does NOT append
 * `.nullable()` / `.optional()` — callers layer those on per-schema.
 */
function zodBaseType(col: ColumnMetadata, enums: Record<string, string[]>): string {
  const dt = col.dialectType ?? col.pgType;
  const isArray = col.isArray || dt.startsWith('_');
  const base = isArray && dt.startsWith('_') ? dt.slice(1) : dt;

  let expr: string;
  if (Object.hasOwn(enums, base)) {
    expr = `z.enum([${enums[base]!.map((l) => `'${escSQ(l)}'`).join(', ')}])`;
  } else {
    expr = zodScalar(pgTypeToTs(base, false));
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
  const lines: string[] = [...generatedFileHeader(options)];
  // `zod` is a USER dependency — this generated file imports it, but the Turbine
  // library runtime never does, so Zod stays out of the package's dep graph.
  lines.push("import { z } from 'zod';");
  lines.push('');

  for (const table of Object.values(schema.tables)) {
    const typeName = entityName(table.name);

    // Full-row schema.
    lines.push(`/** Zod schema for a \`${table.name}\` row */`);
    lines.push(`export const ${typeName}Schema = z.object({`);
    for (const col of table.columns) {
      let expr = zodBaseType(col, schema.enums);
      if (col.nullable) expr += '.nullable()';
      lines.push(`  ${col.field}: ${expr},`);
    }
    lines.push('});');
    lines.push('');

    // Create schema — STORED generated columns can never be written; PK,
    // defaulted, and nullable columns are optional.
    lines.push(`/** Zod schema for creating a \`${table.name}\` row */`);
    lines.push(`export const ${typeName}CreateSchema = z.object({`);
    for (const col of table.columns) {
      if (col.isGeneratedStored) continue;
      const isPk = table.primaryKey.includes(col.name);
      let expr = zodBaseType(col, schema.enums);
      if (col.nullable) expr += '.nullable()';
      if (col.hasDefault || col.nullable || isPk) expr += '.optional()';
      lines.push(`  ${col.field}: ${expr},`);
    }
    lines.push('});');
    lines.push('');

    // Update schema — PK and STORED generated columns omitted; all else optional.
    lines.push(`/** Zod schema for updating a \`${table.name}\` row */`);
    lines.push(`export const ${typeName}UpdateSchema = z.object({`);
    for (const col of table.columns) {
      if (col.isGeneratedStored) continue;
      if (table.primaryKey.includes(col.name)) continue;
      let expr = zodBaseType(col, schema.enums);
      if (col.nullable) expr += '.nullable()';
      expr += '.optional()';
      lines.push(`  ${col.field}: ${expr},`);
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
  const lines: string[] = [
    ...generatedFileHeader(options),
    "import type { SchemaMetadata } from 'turbine-orm';",
    '',
    'export const SCHEMA: SchemaMetadata = {',
    '  tables: {',
  ];

  for (const table of Object.values(schema.tables)) {
    lines.push(`    ${table.name}: {`);
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
      lines.push(`        ${field}: '${escSQ(col)}',`);
    }
    lines.push('      },');

    // reverseColumnMap
    lines.push('      reverseColumnMap: {');
    for (const [col, field] of Object.entries(table.reverseColumnMap)) {
      lines.push(`        ${quoteIfNeeded(col)}: '${escSQ(field)}',`);
    }
    lines.push('      },');

    // dateColumns
    const dateCols = [...table.dateColumns];
    lines.push(`      dateColumns: new Set([${dateCols.map((c) => `'${escSQ(c)}'`).join(', ')}]),`);

    // dialectTypes + pgTypes (pgTypes is kept for backwards compatibility)
    const dialectTypes = table.dialectTypes ?? table.pgTypes;
    lines.push('      dialectTypes: {');
    for (const [col, dialectType] of Object.entries(dialectTypes)) {
      lines.push(`        ${quoteIfNeeded(col)}: '${escSQ(dialectType)}',`);
    }
    lines.push('      },');
    lines.push('      pgTypes: {');
    for (const [col, pgType] of Object.entries(table.pgTypes)) {
      lines.push(`        ${quoteIfNeeded(col)}: '${escSQ(pgType)}',`);
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
      // manyToMany relations carry a `through` junction descriptor — emit it so
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
        `        ${relName}: { type: '${escSQ(rel.type)}', name: '${escSQ(rel.name)}', from: '${escSQ(rel.from)}', to: '${escSQ(rel.to)}', foreignKey: ${fkLiteral}, referenceKey: ${refLiteral}${throughLiteral} },`,
      );
    }
    lines.push('      },');

    // indexes
    lines.push('      indexes: [');
    for (const idx of table.indexes) {
      lines.push(
        `        { name: '${escSQ(idx.name)}', columns: [${idx.columns.map((c) => `'${escSQ(c)}'`).join(', ')}], unique: ${idx.unique}, definition: ${JSON.stringify(idx.definition)} },`,
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

    // isView — read-only marker; the runtime write guard reads it.
    if (table.isView) lines.push('      isView: true,');

    lines.push('    },');
  }

  lines.push('  },');

  // enums
  lines.push('  enums: {');
  for (const [enumName, labels] of Object.entries(schema.enums)) {
    lines.push(`    ${enumName}: [${labels.map((l) => `'${escSQ(l)}'`).join(', ')}],`);
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
  const tableEntries = Object.values(schema.tables);
  // Must mirror generateTypes: `XRelations` only exists in types.ts when the
  // table has at least one type-safe (non-column-shadowing) relation.
  const hasSafeRelations = new Map<string, boolean>();
  for (const t of tableEntries) hasSafeRelations.set(t.name, typeSafeRelations(t, false).length > 0);
  const lines: string[] = [
    ...generatedFileHeader(options),
    "import { TurbineClient as BaseTurbineClient, TransactionClient as BaseTransactionClient, QueryInterface } from 'turbine-orm';",
    "import type { TurbineConfig, TransactionOptions, DeferredQuery, PipelineResults } from 'turbine-orm';",
    "import { SCHEMA } from './metadata.js';",
  ];

  // Import all entity types and relations maps
  const typeImports: string[] = [];
  for (const t of tableEntries) {
    typeImports.push(entityName(t.name));
    if (hasSafeRelations.get(t.name)) {
      typeImports.push(`${entityName(t.name)}Relations`);
    }
  }
  lines.push(`import type { ${typeImports.join(', ')} } from './types.js';`);
  lines.push('');

  // -------------------------------------------------------------------------
  // TypedTransactionClient — same typed table accessors as TurbineClient,
  // but scoped to a single transaction connection. The runtime instance is
  // an ordinary `TransactionClient` from turbine-orm; this declaration just
  // teaches TypeScript about the auto-attached accessors so users get
  // autocomplete inside `db.$transaction(async (tx) => tx.users.create(...))`.
  // -------------------------------------------------------------------------
  lines.push('/**');
  lines.push(' * Transaction-scoped client with the same typed table accessors as TurbineClient.');
  lines.push(' * Created automatically by `db.$transaction(async (tx) => ...)` — never instantiate');
  lines.push(' * directly. All queries run on a dedicated connection within a BEGIN/COMMIT block.');
  lines.push(' */');
  lines.push('export class TypedTransactionClient extends BaseTransactionClient {');
  for (const table of tableEntries) {
    const typeName = entityName(table.name);
    const accessor = snakeToCamelStr(table.name);
    const hasRelations = hasSafeRelations.get(table.name) === true;
    const genericArgs = hasRelations ? `${typeName}, ${typeName}Relations` : typeName;
    lines.push(`  /** Query interface for the \`${table.name}\` table (transaction-scoped) */`);
    lines.push(`  declare readonly ${accessor}: ${accessorType(table, genericArgs)};`);
  }
  lines.push('}');
  lines.push('');
  // Augment the class with a typed `$transaction` overload via interface
  // merging. This adds an additional callable signature whose callback
  // parameter is narrowed to `TypedTransactionClient`, while the base
  // signature (callback parameter `BaseTransactionClient`) remains valid.
  lines.push('export interface TypedTransactionClient {');
  lines.push('  /**');
  lines.push('   * Nested transaction via SAVEPOINT. The callback receives a typed');
  lines.push('   * `TypedTransactionClient` so all table accessors auto-complete.');
  lines.push('   */');
  lines.push('  $transaction<R>(fn: (tx: TypedTransactionClient) => Promise<R>): Promise<R>;');
  lines.push('}');
  lines.push('');

  // Generate the client class with JSDoc
  lines.push('/**');
  lines.push(' * Generated Turbine client with typed table accessors.');
  lines.push(' *');
  lines.push(' * Tables:');
  for (const table of tableEntries) {
    lines.push(` *   - \`${snakeToCamelStr(table.name)}\` (${table.name})`);
  }
  lines.push(' *');
  lines.push(' * @example');
  lines.push(' * ```ts');
  lines.push(' * const db = turbine({ connectionString: process.env.DATABASE_URL });');
  if (tableEntries.length > 0) {
    const firstTable = tableEntries[0]!;
    const accessor = snakeToCamelStr(firstTable.name);
    lines.push(` * const rows = await db.${accessor}.findMany();`);
  }
  lines.push(' * ```');
  lines.push(' */');
  lines.push('export class TurbineClient extends BaseTurbineClient {');
  for (const table of tableEntries) {
    const typeName = entityName(table.name);
    const accessor = snakeToCamelStr(table.name);
    const hasRelations = hasSafeRelations.get(table.name) === true;
    const genericArgs = hasRelations ? `${typeName}, ${typeName}Relations` : typeName;
    lines.push(`  /** Query interface for the \`${table.name}\` table */`);
    lines.push(`  declare readonly ${accessor}: ${accessorType(table, genericArgs)};`);
  }
  lines.push('');
  lines.push('  constructor(config?: TurbineConfig) {');
  lines.push('    super(config, SCHEMA);');
  lines.push('  }');
  lines.push('}');
  lines.push('');
  // Augment TurbineClient via interface merging with a typed $transaction
  // overload. The callback parameter is narrowed to `TypedTransactionClient`
  // so users get autocomplete on `tx.users`, `tx.posts`, etc.
  //
  // IMPORTANT: the merged member must be compatible with the base class's
  // $transaction ON ITS OWN (TS2415) — since v0.26 the base method also has a
  // batch-array overload (`$transaction([...queries])`), so the merged
  // interface must redeclare BOTH signatures. Emitting only the callback form
  // makes every generated client fail `tsc` with "incorrectly extends".
  lines.push('export interface TurbineClient {');
  lines.push('  /**');
  lines.push('   * Run a callback inside a transaction. The callback receives a typed');
  lines.push('   * `TypedTransactionClient` with autocompletion for every table accessor.');
  lines.push('   */');
  lines.push('  $transaction<R>(');
  lines.push('    fn: (tx: TypedTransactionClient) => Promise<R>,');
  lines.push('    options?: TransactionOptions,');
  lines.push('  ): Promise<R>;');
  lines.push('  /**');
  lines.push('   * Batch form: run several deferred queries in one transaction and get');
  lines.push('   * their results as a tuple (same as the base client).');
  lines.push('   */');
  lines.push('  $transaction<T extends readonly DeferredQuery<unknown>[]>(');
  lines.push('    queries: readonly [...T],');
  lines.push('  ): Promise<PipelineResults<T>>;');
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
  lines.push('export function turbine(config?: TurbineConfig): TurbineClient {');
  lines.push('  return new TurbineClient(config);');
  lines.push('}');
  lines.push('');

  // Re-export everything
  lines.push("export * from './types.js';");
  lines.push("export { SCHEMA } from './metadata.js';");
  lines.push('');

  return lines.join('\n');
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
  // Cross-schema type marker — introspection records it only for types living
  // outside the introspected schema; it must survive codegen or the runtime
  // enum-cast guard in query/builder.ts loses the signal (N-5).
  if (col.pgTypeSchema !== undefined) parts.push(`pgTypeSchema: '${escSQ(col.pgTypeSchema)}'`);
  // Emit isGenerated only when set (server-generated serial/identity), so the
  // output stays byte-identical for the common client-default columns.
  if (col.isGenerated) parts.push(`isGenerated: true`);
  // STORED generated columns — the runtime write guard reads isGeneratedStored.
  if (col.isGeneratedStored) parts.push(`isGeneratedStored: true`);
  if (col.generationExpression !== undefined) {
    parts.push(`generationExpression: '${escSQ(col.generationExpression)}'`);
  }
  // PII marker: emitted only when set, so untagged schemas stay byte-identical.
  // Introspection never sets this (code-first declaration), but a metadata
  // object built from `defineSchema` (pii: true) carries it through codegen.
  if (col.pii) parts.push(`pii: true`);
  if (col.maxLength !== undefined) parts.push(`maxLength: ${col.maxLength}`);
  return `{ ${parts.join(', ')} }`;
}

function quoteIfNeeded(s: string): string {
  return /[^a-zA-Z0-9_$]/.test(s) ? `'${s}'` : s;
}

function snakeToCamelStr(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Build the update-input field type for a column. Numeric columns become
 * `T | UpdateOperatorInput<number> | null?` so users can write atomic
 * operators (`{ increment: 1 }`, `{ multiply: 2 }`, etc.) without casts.
 *
 * The check is purely structural — if the column's TS type contains
 * `'number'` (e.g. `number`, `number | null`), it's eligible. Other
 * scalar types (`string`, `boolean`, `Date`, `unknown`, `Buffer`,
 * `Date | null`, etc.) pass through unchanged.
 */
function updateFieldType(tsType: string): string {
  // Strip parens for the regex check; preserve the original string in the output.
  if (containsNumberType(tsType)) {
    return `${tsType} | UpdateOperatorInput<number>`;
  }
  return tsType;
}

/**
 * Detect whether a TypeScript type expression contains the `number` primitive
 * as a top-level union member. Conservative on purpose — only matches
 * `number`, `number | null`, `null | number`, etc., not `number[]` or
 * `Record<string, number>`.
 */
function containsNumberType(tsType: string): boolean {
  // Tokenize on `|` and check each member.
  const parts = tsType.split('|').map((p) => p.trim());
  return parts.some((p) => p === 'number');
}
