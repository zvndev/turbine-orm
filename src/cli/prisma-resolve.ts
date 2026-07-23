/**
 * Resolve a parsed Prisma schema against live introspected Turbine metadata.
 *
 * Consumes a {@link PrismaSchemaAst} (from `cli/prisma-schema.ts`) plus a
 * {@link SchemaMetadata} (from `introspect()`), and produces a
 * {@link ResolutionResult}: a per-model/field/relation/compound-unique
 * resolution report AND the typed {@link PrismaCompatMap} that only ever
 * contains VERIFIED mappings. Anything that cannot be matched against the live
 * database is reported UNRESOLVED with a reason and left out of the map - the
 * database is the authority, and an ambiguous guess is worse than an honest gap.
 *
 * Pure leaf: no filesystem, database, or process access. Passing `schema: null`
 * yields a parse-only report (every item `parsed`, no map) for `--no-db`.
 */

import { camelToSnake, type PrismaCompatMap, type SchemaMetadata, snakeToCamel } from '../schema.js';
import type { PrismaModel, PrismaSchemaAst } from './prisma-schema.js';

/**
 * Bookkeeping tables Turbine never surfaces. Migration-tool tables from Turbine
 * (`_turbine_migrations`, `_turbine_metrics`) and Prisma (`_prisma_migrations`)
 * are excluded so they never masquerade as models.
 *
 * MERGE NOTE: a sibling branch introduces `DEFAULT_EXCLUDED_TABLES` in the
 * introspection layer (finding 12). This local copy is a stub for THIS branch -
 * at merge, delete it and import the introspection-layer export instead so the
 * exclusion is defined once.
 */
export const DEFAULT_EXCLUDED_TABLES: readonly string[] = [
  '_turbine_migrations',
  '_turbine_metrics',
  '_prisma_migrations',
];

// ---------------------------------------------------------------------------
// Report shapes
// ---------------------------------------------------------------------------

export type ResolveStatus = 'resolved' | 'unresolved' | 'parsed';

export interface ResolvedField {
  prismaName: string;
  /** Resolved Turbine field (camelCase), or null. */
  turbineField: string | null;
  /** Resolved snake_case database column, or null. */
  column: string | null;
  status: ResolveStatus;
  reason?: string;
}

export interface ResolvedRelation {
  prismaName: string;
  /** Turbine relation name, or null. */
  turbineName: string | null;
  cardinality: 'one' | 'many' | null;
  /** Target Prisma model this relation points at. */
  targetModel: string;
  /** Junction table for an m2m relation, if resolved. */
  junction?: string;
  status: ResolveStatus;
  reason?: string;
}

export interface ResolvedCompoundUnique {
  /** Prisma selector name (explicit `name:`, else the field-name underscore-join). */
  selector: string;
  /** Prisma field names participating. */
  prismaFields: string[];
  /** Resolved Turbine field names (in order), or null. */
  turbineFields: string[] | null;
  kind: 'id' | 'unique';
  status: ResolveStatus;
  reason?: string;
}

export interface ResolvedModel {
  prismaName: string;
  kind: 'model' | 'view' | 'type';
  /** Resolved snake_case table name, or null. */
  table: string | null;
  /** camelCase client accessor, or null. */
  accessor: string | null;
  /** True when the table name came from an explicit `@@map`. */
  viaMap: boolean;
  status: ResolveStatus;
  reason?: string;
  fields: ResolvedField[];
  relations: ResolvedRelation[];
  compoundUniques: ResolvedCompoundUnique[];
}

export interface ResolvedEnum {
  prismaName: string;
  turbineName: string | null;
  status: ResolveStatus;
  reason?: string;
}

export interface ResolutionResult {
  models: ResolvedModel[];
  enums: ResolvedEnum[];
  /** The verified name map. Empty `models`/`enums` in `--no-db` mode. */
  map: PrismaCompatMap;
  /** True if any model/field/relation/compound-unique/enum is UNRESOLVED. */
  hasUnresolved: boolean;
  /** Non-fatal parser notes (skipped blocks/attributes). */
  parseWarnings: string[];
  /** True when resolution was skipped (`--no-db`): the report is parse-only. */
  noDb: boolean;
}

// ---------------------------------------------------------------------------
// Name-candidate helpers
// ---------------------------------------------------------------------------

/** PascalCase model → snake_case: lower the first letter, then camelToSnake. */
function pascalToSnake(name: string): string {
  if (name === '') return name;
  return camelToSnake(name[0]!.toLowerCase() + name.slice(1));
}

/** Naive pluralize for the snake candidate: mirrors `singularize` in schema.ts. */
function pluralize(s: string): string {
  if (/[^aeiou]y$/.test(s)) return `${s.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/.test(s)) return `${s}es`;
  return `${s}s`;
}

function singularize(s: string): string {
  if (s.endsWith('ies')) return `${s.slice(0, -3)}y`;
  if (s.endsWith('ses') || s.endsWith('xes') || s.endsWith('zes')) return s.slice(0, -2);
  if (s.endsWith('s') && !s.endsWith('ss')) return s.slice(0, -1);
  return s;
}

/** Ordered, de-duplicated table-name candidates for a model without `@@map`. */
function tableCandidates(modelName: string): string[] {
  const snake = pascalToSnake(modelName);
  const raw = modelName;
  const set = new Set<string>([
    raw,
    raw.toLowerCase(),
    snake,
    pluralize(snake),
    singularize(snake),
    pluralize(raw.toLowerCase()),
  ]);
  return [...set].filter((s) => s !== '');
}

// ---------------------------------------------------------------------------
// Field/column resolution
// ---------------------------------------------------------------------------

/** The database column a Prisma field maps to (`@map` wins, else the field name). */
function fieldColumn(model: PrismaModel, fieldName: string): string {
  const f = model.fields.find((x) => x.name === fieldName);
  if (!f) return fieldName;
  const mapAttr = f.attrs.find((a) => a.name === 'map');
  const arg = mapAttr?.args.find((a) => a.key === undefined);
  return arg?.kind === 'string' && arg.value ? arg.value : f.name;
}

/** True when a field's type names a parsed model (so it is a relation/object field). */
function isRelationField(typeName: string, modelNames: Set<string>): boolean {
  return modelNames.has(typeName);
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * Resolve `ast` against introspected `schema` (or `null` for parse-only).
 */
export function resolvePrismaSchema(ast: PrismaSchemaAst, schema: SchemaMetadata | null): ResolutionResult {
  const noDb = schema === null;
  const modelNames = new Set(ast.models.map((m) => m.name));
  const tableNames = schema ? new Set(Object.keys(schema.tables)) : new Set<string>();

  // Pass 1 - resolve each model to a table so relation targets are known.
  const modelTable = new Map<string, { table: string | null; viaMap: boolean; reason?: string }>();
  for (const model of ast.models) {
    modelTable.set(model.name, resolveTable(model, tableNames, noDb));
  }

  const result: ResolutionResult = {
    models: [],
    enums: [],
    map: { models: {}, enums: {} },
    hasUnresolved: false,
    parseWarnings: ast.warnings,
    noDb,
  };

  // Pass 2 - resolve fields, relations, and compound uniques.
  for (const model of ast.models) {
    const rt = modelTable.get(model.name)!;
    const table = rt.table;
    const tableMeta = table && schema ? schema.tables[table] : undefined;
    const accessor = table ? snakeToCamel(table) : null;

    const status: ResolveStatus = noDb ? 'parsed' : table ? 'resolved' : 'unresolved';
    const resolved: ResolvedModel = {
      prismaName: model.name,
      kind: model.kind,
      table,
      accessor,
      viaMap: rt.viaMap,
      status,
      reason: rt.reason,
      fields: [],
      relations: [],
      compoundUniques: [],
    };

    for (const field of model.fields) {
      if (isRelationField(field.type, modelNames)) {
        resolved.relations.push(
          resolveRelation(model, field.name, field.type, field.isList, modelTable, schema, tableMeta, noDb),
        );
      } else {
        resolved.fields.push(resolveScalarField(model, field.name, tableMeta, noDb));
      }
    }

    for (const key of model.compoundKeys) {
      // Prisma only synthesizes a compound selector object for multi-field keys
      // or an explicitly named one; single-field keys are addressed flat.
      if (key.fields.length < 2 && !key.name) continue;
      resolved.compoundUniques.push(resolveCompoundUnique(model, key, tableMeta, noDb));
    }

    result.models.push(resolved);

    // Build the verified map entry (skip in --no-db and for unresolved tables).
    if (!noDb && table && accessor) {
      const fields: Record<string, string> = {};
      for (const f of resolved.fields) {
        if (f.status === 'resolved' && f.turbineField) fields[f.prismaName] = f.turbineField;
      }
      const relations: Record<string, { name: string; cardinality: 'one' | 'many' }> = {};
      for (const r of resolved.relations) {
        if (r.status === 'resolved' && r.turbineName && r.cardinality) {
          relations[r.prismaName] = { name: r.turbineName, cardinality: r.cardinality };
        }
      }
      const compoundUniques: Record<string, string[]> = {};
      for (const c of resolved.compoundUniques) {
        if (c.status === 'resolved' && c.turbineFields) compoundUniques[c.selector] = c.turbineFields;
      }
      result.map.models[model.name] = { table, accessor, fields, relations, compoundUniques };
    }
  }

  // Enums.
  for (const en of ast.enums) {
    const r = resolveEnum(en.name, en.map, schema, noDb);
    result.enums.push(r);
    if (!noDb && r.status === 'resolved' && r.turbineName) result.map.enums[en.name] = r.turbineName;
  }

  result.hasUnresolved = computeHasUnresolved(result);
  return result;
}

// ---------------------------------------------------------------------------
// Per-construct resolvers
// ---------------------------------------------------------------------------

function resolveTable(
  model: PrismaModel,
  tableNames: Set<string>,
  noDb: boolean,
): { table: string | null; viaMap: boolean; reason?: string } {
  if (model.kind === 'type') {
    return { table: null, viaMap: false, reason: 'composite/embedded type - not a table' };
  }
  if (noDb) return { table: null, viaMap: !!model.map };

  if (model.map) {
    if (tableNames.has(model.map)) return { table: model.map, viaMap: true };
    return { table: null, viaMap: true, reason: `@@map("${model.map}") target table not found in the database` };
  }

  const candidates = tableCandidates(model.name);
  const matches = candidates.filter((c) => tableNames.has(c));
  const distinct = [...new Set(matches)];
  if (distinct.length === 1) return { table: distinct[0]!, viaMap: false };
  if (distinct.length > 1) {
    return {
      table: null,
      viaMap: false,
      reason: `ambiguous - multiple tables match (${distinct.join(', ')}); add @@map("<table>") to disambiguate`,
    };
  }
  return {
    table: null,
    viaMap: false,
    reason: `no table matched (tried ${candidates.join(', ')}); add @@map("<table>")`,
  };
}

function resolveScalarField(
  model: PrismaModel,
  fieldName: string,
  tableMeta: SchemaMetadata['tables'][string] | undefined,
  noDb: boolean,
): ResolvedField {
  const column = fieldColumn(model, fieldName);
  if (noDb || !tableMeta) {
    return { prismaName: fieldName, turbineField: null, column: null, status: noDb ? 'parsed' : 'unresolved' };
  }
  const turbineField = tableMeta.reverseColumnMap[column];
  if (turbineField) {
    return { prismaName: fieldName, turbineField, column, status: 'resolved' };
  }
  return {
    prismaName: fieldName,
    turbineField: null,
    column: null,
    status: 'unresolved',
    reason: `column "${column}" not found on table "${tableMeta.name}"`,
  };
}

function resolveRelation(
  model: PrismaModel,
  fieldName: string,
  targetModelName: string,
  isList: boolean,
  modelTable: Map<string, { table: string | null }>,
  schema: SchemaMetadata | null,
  tableMeta: SchemaMetadata['tables'][string] | undefined,
  noDb: boolean,
): ResolvedRelation {
  const cardinality: 'one' | 'many' = isList ? 'many' : 'one';
  const base: ResolvedRelation = {
    prismaName: fieldName,
    turbineName: null,
    cardinality: noDb ? null : cardinality,
    targetModel: targetModelName,
    status: noDb ? 'parsed' : 'unresolved',
  };
  if (noDb) return base;
  if (!schema || !tableMeta) {
    return { ...base, reason: 'model table unresolved' };
  }

  const targetTable = modelTable.get(targetModelName)?.table ?? null;

  // Explicit @relation(fields: [...]) names the FK columns on THIS side.
  const field = model.fields.find((f) => f.name === fieldName);
  const relAttr = field?.attrs.find((a) => a.name === 'relation');
  const fieldsArg = relAttr?.args.find((a) => a.key === 'fields' && a.kind === 'array');
  const fkColumns = fieldsArg?.items?.map((pf) => fieldColumn(model, pf)) ?? null;

  const candidates = Object.values(tableMeta.relations).filter((def) => {
    if (targetTable && def.to !== targetTable) return false;
    if (cardinality === 'many') return def.type === 'hasMany' || def.type === 'manyToMany';
    return def.type === 'belongsTo' || def.type === 'hasOne';
  });

  let picked = candidates;
  if (fkColumns && fkColumns.length > 0) {
    const want = [...fkColumns].sort().join(',');
    const byFk = candidates.filter((def) => {
      const fk = Array.isArray(def.foreignKey) ? def.foreignKey : [def.foreignKey];
      return [...fk].sort().join(',') === want;
    });
    if (byFk.length > 0) picked = byFk;
  }

  if (picked.length === 1) {
    const def = picked[0]!;
    return {
      ...base,
      turbineName: def.name,
      cardinality,
      junction: def.type === 'manyToMany' ? def.through?.table : undefined,
      status: 'resolved',
    };
  }
  if (picked.length > 1) {
    return {
      ...base,
      reason: `ambiguous - ${picked.length} candidate relations match (${picked.map((d) => d.name).join(', ')})`,
    };
  }
  const targetNote = targetTable ? `table "${targetTable}"` : `model "${targetModelName}" (table unresolved)`;
  return { ...base, reason: `no ${cardinality} relation to ${targetNote} on table "${tableMeta.name}"` };
}

function resolveCompoundUnique(
  model: PrismaModel,
  key: { fields: string[]; name?: string; kind: 'id' | 'unique' },
  tableMeta: SchemaMetadata['tables'][string] | undefined,
  noDb: boolean,
): ResolvedCompoundUnique {
  const selector = key.name ?? key.fields.join('_');
  const base: ResolvedCompoundUnique = {
    selector,
    prismaFields: key.fields,
    turbineFields: null,
    kind: key.kind,
    status: noDb ? 'parsed' : 'unresolved',
  };
  if (noDb || !tableMeta) return base;

  const columns = key.fields.map((f) => fieldColumn(model, f));
  const missing = columns.filter((c) => !tableMeta.reverseColumnMap[c]);
  if (missing.length > 0) {
    return { ...base, reason: `column(s) not found: ${missing.join(', ')}` };
  }
  const turbineFields = columns.map((c) => tableMeta.reverseColumnMap[c]!);

  const want = [...columns].sort().join(',');
  const matches = (setList: string[][]) => setList.some((s) => [...s].sort().join(',') === want);

  if (key.kind === 'id') {
    if (matches([tableMeta.primaryKey])) return { ...base, turbineFields, status: 'resolved' };
    return { ...base, reason: `no compound primary key on "${tableMeta.name}" matches (${columns.join(', ')})` };
  }
  // Introspected metadata carries composite unique constraints in uniqueColumns.
  if (matches(tableMeta.uniqueColumns)) return { ...base, turbineFields, status: 'resolved' };
  return { ...base, reason: `no unique constraint on "${tableMeta.name}" matches (${columns.join(', ')})` };
}

function resolveEnum(
  name: string,
  map: string | undefined,
  schema: SchemaMetadata | null,
  noDb: boolean,
): ResolvedEnum {
  if (noDb || !schema) return { prismaName: name, turbineName: null, status: noDb ? 'parsed' : 'unresolved' };
  // An explicit @@map names the database enum type outright.
  const candidates = map ? [map] : [name, name.toLowerCase(), pascalToSnake(name)];
  const matches = [...new Set(candidates.filter((c) => Object.hasOwn(schema.enums, c)))];
  if (matches.length === 1) return { prismaName: name, turbineName: matches[0]!, status: 'resolved' };
  if (matches.length > 1) {
    return {
      prismaName: name,
      turbineName: null,
      status: 'unresolved',
      reason: `ambiguous enum match (${matches.join(', ')})`,
    };
  }
  return { prismaName: name, turbineName: null, status: 'unresolved', reason: 'no matching database enum type' };
}

function computeHasUnresolved(result: ResolutionResult): boolean {
  if (result.noDb) return false;
  for (const m of result.models) {
    if (m.status === 'unresolved') return true;
    if (m.fields.some((f) => f.status === 'unresolved')) return true;
    if (m.relations.some((r) => r.status === 'unresolved')) return true;
    if (m.compoundUniques.some((c) => c.status === 'unresolved')) return true;
  }
  if (result.enums.some((e) => e.status === 'unresolved')) return true;
  return false;
}
