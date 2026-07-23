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

import { camelToSnake, type PrismaCompatMap, type SchemaMetadata, snakeToCamel, withDbFieldNames } from '../schema.js';
import type { PrismaModel, PrismaSchemaAst } from './prisma-schema.js';

export { DEFAULT_EXCLUDED_TABLES } from '../introspect.js';

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

/** Options controlling how names are resolved. */
export interface ResolveOptions {
  /**
   * Resolve field names against the raw database column names instead of the
   * camelCase default, matching a client generated with `--keep-column-names`.
   * Applied by running the introspected metadata through {@link withDbFieldNames}
   * up front, so every resolved `turbineField` (and compound-unique
   * `turbineFields`) is the DB column spelling and the emitted PRISMA_MAP agrees
   * with the generated client. Table names, accessors, and relations are
   * unaffected (those never carry camelCased column names).
   */
  keepColumnNames?: boolean;
}

/**
 * Resolve `ast` against introspected `schema` (or `null` for parse-only).
 */
export function resolvePrismaSchema(
  ast: PrismaSchemaAst,
  schema: SchemaMetadata | null,
  options: ResolveOptions = {},
): ResolutionResult {
  // Under keep-column-names the generated client keys fields by raw DB column
  // names; resolve against the same transformed metadata so the name map's
  // field values match the client (D).
  const resolvedSchema = schema && options.keepColumnNames ? withDbFieldNames(schema) : schema;
  const noDb = resolvedSchema === null;
  const modelNames = new Set(ast.models.map((m) => m.name));
  const modelsByName = new Map(ast.models.map((m) => [m.name, m]));
  const tableNames = resolvedSchema ? new Set(Object.keys(resolvedSchema.tables)) : new Set<string>();

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
    const tableMeta = table && resolvedSchema ? resolvedSchema.tables[table] : undefined;
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
          resolveRelation(
            model,
            field.name,
            field.type,
            field.isList,
            modelTable,
            modelsByName,
            resolvedSchema,
            tableMeta,
            noDb,
          ),
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
      const clientDefaults = collectClientDefaults(model, fields, resolvedSchema?.tables[table]);
      result.map.models[model.name] = {
        table,
        accessor,
        fields,
        relations,
        compoundUniques,
        ...(clientDefaults ? { clientDefaults } : {}),
      };
    }
  }

  // Enums.
  for (const en of ast.enums) {
    const r = resolveEnum(en.name, en.map, resolvedSchema, noDb);
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

/**
 * The `@relation("Name")` name on a field, from the `name:` argument or the
 * first positional string argument. Absent when the field has no `@relation`
 * attribute or the attribute carries no name.
 */
function relationNameOf(field: PrismaModel['fields'][number] | undefined): string | undefined {
  const relAttr = field?.attrs.find((a) => a.name === 'relation');
  if (!relAttr) return undefined;
  const named = relAttr.args.find((a) => a.key === 'name' && a.kind === 'string');
  if (named?.value) return named.value;
  const positional = relAttr.args.find((a) => a.key === undefined && a.kind === 'string');
  return positional?.value;
}

/** The FK column list a field pins via `@relation(fields: [...])`, resolved to columns. */
function relationFkColumns(model: PrismaModel, field: PrismaModel['fields'][number] | undefined): string[] | null {
  const relAttr = field?.attrs.find((a) => a.name === 'relation');
  const fieldsArg = relAttr?.args.find((a) => a.key === 'fields' && a.kind === 'array');
  return fieldsArg?.items?.map((pf) => fieldColumn(model, pf)) ?? null;
}

/**
 * Prisma CLIENT-side defaults for a resolved model: `@default(uuid())` /
 * `@default(cuid())` / `@updatedAt` are filled by the Prisma client (the
 * database column typically has NO default), so migrated call sites omit those
 * fields and a plain insert violates NOT NULL. `@default(now())` is normally a
 * database default, so it is carried only when the introspected column has no
 * default. `@updatedAt` is always carried (Prisma touches it on every update
 * regardless of any database default). Returns undefined when the model has
 * none, keeping the emitted map byte-identical for unaffected schemas.
 */
function collectClientDefaults(
  model: PrismaModel,
  resolvedFields: Record<string, string>,
  tableMeta: SchemaMetadata['tables'][string] | undefined,
): Record<string, 'uuid' | 'cuid' | 'now' | 'updatedAt'> | undefined {
  if (!tableMeta) return undefined;
  const out: Record<string, 'uuid' | 'cuid' | 'now' | 'updatedAt'> = {};
  for (const field of model.fields) {
    const turbineField = resolvedFields[field.name];
    if (!turbineField) continue;
    const col = tableMeta.columns.find((c) => c.field === turbineField || c.name === turbineField);
    if (field.attrs.some((a) => a.name === 'updatedAt')) {
      out[field.name] = 'updatedAt';
      continue;
    }
    if (col?.hasDefault) continue; // the database fills it; nothing to emulate
    const def = field.attrs.find((a) => a.name === 'default');
    const raw = def?.args.find((a) => a.key === undefined && a.kind === 'raw')?.value ?? '';
    if (/^uuid\s*\(/.test(raw)) out[field.name] = 'uuid';
    else if (/^cuid\s*\(/.test(raw)) out[field.name] = 'cuid';
    else if (/^now\s*\(\s*\)$/.test(raw)) out[field.name] = 'now';
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * FK columns for an INVERSE relation field (one carrying no `fields: [...]`),
 * derived by @relation("Name") pairing: the opposing model's same-named field
 * that owns the FK pins the columns. Returns undefined when there is no
 * relation name or no named counterpart. This is how Prisma disambiguates two
 * or more relations to the same target model.
 */
function pairedInverseFkColumns(
  model: PrismaModel,
  field: PrismaModel['fields'][number] | undefined,
  targetModelName: string,
  modelsByName: Map<string, PrismaModel>,
): string[] | null {
  const relName = relationNameOf(field);
  const targetModel = modelsByName.get(targetModelName);
  if (!relName || !targetModel) return null;
  const opposing = targetModel.fields.find(
    (f) =>
      f.type === model.name && relationNameOf(f) === relName && (relationFkColumns(targetModel, f)?.length ?? 0) > 0,
  );
  return opposing ? relationFkColumns(targetModel, opposing) : null;
}

function resolveRelation(
  model: PrismaModel,
  fieldName: string,
  targetModelName: string,
  isList: boolean,
  modelTable: Map<string, { table: string | null }>,
  modelsByName: Map<string, PrismaModel>,
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
  let fkColumns = relationFkColumns(model, field);

  // Inverse side (no fields on this side) with a @relation("Name"): pair by that
  // name FIRST. Find the opposing model's field carrying the same relation name
  // AND the FK (fields: [...]), and resolve through ITS foreign key. This is how
  // Prisma disambiguates two or more relations to the same target model. Only
  // fall back to the ambiguity handling below when there is no relation name or
  // the named pair cannot be found.
  if (!fkColumns || fkColumns.length === 0) {
    fkColumns = pairedInverseFkColumns(model, field, targetModelName, modelsByName);
  }

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
    // Elimination pass: an UNNAMED pair can still resolve when every sibling
    // relation field to the same target pins a different candidate (via its own
    // `fields: [...]` or @relation("Name") pairing). Subtract those consumed
    // candidates; exactly one survivor means the unnamed pair is unambiguous by
    // elimination, which is how Prisma itself resolves it.
    const consumed = new Set<string>();
    for (const sibling of model.fields) {
      if (sibling.name === fieldName || sibling.type !== targetModelName) continue;
      const sibFks =
        relationFkColumns(model, sibling) ?? pairedInverseFkColumns(model, sibling, targetModelName, modelsByName);
      if (!sibFks || sibFks.length === 0) continue;
      const sibWant = [...sibFks].sort().join(',');
      for (const def of candidates) {
        const fk = Array.isArray(def.foreignKey) ? def.foreignKey : [def.foreignKey];
        if ([...fk].sort().join(',') === sibWant) consumed.add(def.name);
      }
    }
    const surviving = picked.filter((def) => !consumed.has(def.name));
    if (surviving.length === 1) {
      const def = surviving[0]!;
      return {
        ...base,
        turbineName: def.name,
        cardinality,
        junction: def.type === 'manyToMany' ? def.through?.table : undefined,
        status: 'resolved',
      };
    }
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
  // A composite unique can surface EITHER as a unique constraint (uniqueColumns)
  // OR as a plain UNIQUE INDEX (Prisma creates unique indexes, not table
  // constraints), so accept a matching unique index too. A partial unique index
  // does not enforce uniqueness across the whole table, so it never satisfies a
  // @@unique; skip it defensively (the marker may be added to IndexMetadata).
  const uniqueIndexMatches = tableMeta.indexes.some((idx) => {
    if (!idx.unique) return false;
    if ((idx as { partial?: boolean }).partial) return false;
    return [...idx.columns].sort().join(',') === want;
  });
  if (matches(tableMeta.uniqueColumns) || uniqueIndexMatches) {
    return { ...base, turbineFields, status: 'resolved' };
  }
  return {
    ...base,
    reason: `no unique constraint or unique index on "${tableMeta.name}" matches (${columns.join(', ')})`,
  };
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
