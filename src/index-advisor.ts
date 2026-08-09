/**
 * Index advisor, finds relation probes that lack index support.
 *
 * Turbine loads `with` relations as correlated subqueries: for every parent row,
 * the child table is probed by its FK column(s) (`child.fk = parent.pk`). Relation
 * filters (`some`/`none`/`every`, `is`/`isNot`) probe the same columns. This
 * strategy outperforms batched loading (`WHERE fk IN (ids)`) when the probed
 * column is indexed, but with NO index, each probe is a full table scan and the
 * cost multiplies by the parent rowcount, while batched loading would pay the
 * scan only once. A missing FK index that is invisible under a batched-loader
 * ORM becomes pathological under a correlated one.
 *
 * This module derives every column set Turbine will probe from SchemaMetadata's
 * relations and checks each against the table's known indexes (and primary key).
 * Consumed by `turbine doctor` (CLI report + fix migration) and by the dev-mode
 * runtime warning in query/builder.ts.
 */

import { quoteIdent } from './query/utils.js';
import { normalizeKeyColumns, type SchemaMetadata, type TableMetadata } from './schema.js';

export interface RelationProbe {
  /** Table on which the relation is declared */
  from: string;
  /** Relation field name */
  relation: string;
  /** Relation type */
  type: 'hasMany' | 'hasOne' | 'belongsTo' | 'manyToMany';
}

export interface MissingRelationIndex {
  /** Table that gets probed per parent row */
  table: string;
  /** Probed column(s), equality lookups, so a covering index must LEAD with one of them */
  columns: string[];
  /** Every relation that generates this probe */
  probes: RelationProbe[];
  /** Suggested index name (matches the --fix migration) */
  indexName: string;
  /** CREATE INDEX statement for the fix migration */
  createSql: string;
  /** DROP INDEX statement for the fix migration's DOWN section */
  dropSql: string;
}

/** Options for {@link buildCreateIndexSql}. All default to the plain, in-transaction form. */
export interface CreateIndexSqlOptions {
  /**
   * Emit `CREATE INDEX CONCURRENTLY`. A concurrent build never holds a write
   * lock, but it CANNOT run inside a transaction block, so a migration carrying
   * it must also carry the `-- turbine:no-transaction` directive.
   */
  concurrently?: boolean;
  /**
   * Emit `IF NOT EXISTS`. Defaults to true for the plain (in-transaction) form
   * and FALSE when `concurrently` is set.
   *
   * `IF NOT EXISTS` matches on the index NAME, never on its validity, so over
   * the INVALID index a failed concurrent build leaves behind it silently
   * no-ops: the migration records as applied, the index doctor reported is
   * still missing, and the documented remedy (DROP INDEX CONCURRENTLY, then
   * rerun) is unreachable through `migrate up` because the rerun no-ops too.
   * The concurrent form gets its idempotency from a preceding
   * `DROP INDEX CONCURRENTLY IF EXISTS` instead; see
   * {@link buildCreateIndexStatements}, which is what the CLI emits.
   */
  ifNotExists?: boolean;
  /**
   * Emit a partial index `... WHERE <col> IS NOT NULL`. Only applied for a
   * single-column index (a relation probe correlates `child.fk = parent.pk`, and
   * NULL never equals anything, so a mostly-NULL FK is fully served by a partial
   * index at a fraction of the size). Ignored for composite indexes.
   */
  partialNotNull?: boolean;
}

/**
 * Build a `CREATE INDEX` statement for a relation-probe fix. Pure string
 * assembly (no stats, no DB read): the caller decides whether to pass
 * `concurrently`/`partialNotNull` based on collected statistics, keeping this
 * module topology-only.
 */
export function buildCreateIndexSql(
  table: string,
  columns: string[],
  indexName: string,
  options: CreateIndexSqlOptions = {},
): string {
  const concurrently = options.concurrently ? 'CONCURRENTLY ' : '';
  // Default differs by form: the plain statement runs inside a transaction and
  // can never leave an INVALID corpse, so IF NOT EXISTS is a pure win there.
  // The CONCURRENTLY form can, and IF NOT EXISTS would then match that corpse
  // by name and skip the rebuild forever (see CreateIndexSqlOptions).
  const wantIfNotExists = options.ifNotExists ?? !options.concurrently;
  const ifNotExists = wantIfNotExists ? 'IF NOT EXISTS ' : '';
  const cols = columns.map(quoteIdent).join(', ');
  let sql = `CREATE INDEX ${concurrently}${ifNotExists}${quoteIdent(indexName)} ON ${quoteIdent(table)} (${cols})`;
  if (options.partialNotNull && columns.length === 1 && columns[0] !== undefined) {
    sql += ` WHERE ${quoteIdent(columns[0])} IS NOT NULL`;
  }
  return `${sql};`;
}

/**
 * The statement SEQUENCE that builds one fix index and converges on a VALID
 * index however many times it is rerun.
 *
 * A no-transaction migration is recorded only after ALL its statements succeed,
 * so a mid-file failure leaves earlier indexes built and the migration
 * unrecorded: a rerun must be safe. The old answer was `CREATE INDEX
 * CONCURRENTLY IF NOT EXISTS`, which is safe but not CONVERGENT: a concurrent
 * build that fails partway leaves an INVALID index with the right name, and
 * every subsequent run skips it. Measured: the index was INVALID before the fix
 * migration, `migrate up` reported 1 applied and 0 errors, and the index was
 * still INVALID after.
 *
 * So the concurrent form drops first instead. `DROP INDEX CONCURRENTLY IF
 * EXISTS` is a no-op on the first run (the index is missing, which is why
 * doctor proposed it), and on a rerun it clears the corpse so the CREATE
 * actually rebuilds. Neither statement takes a blocking lock, and both are
 * legal only outside a transaction, which this file already is.
 */
export function buildCreateIndexStatements(
  table: string,
  columns: string[],
  indexName: string,
  options: CreateIndexSqlOptions = {},
): string[] {
  const create = buildCreateIndexSql(table, columns, indexName, options);
  if (!options.concurrently) return [create];
  return [buildDropIndexSql(indexName, { concurrently: true, ifExists: true }), create];
}

/** Build the matching `DROP INDEX` statement. `concurrently` requires no-transaction execution. */
export function buildDropIndexSql(
  indexName: string,
  options: { concurrently?: boolean; ifExists?: boolean } = {},
): string {
  const concurrently = options.concurrently ? 'CONCURRENTLY ' : '';
  const ifExists = options.ifExists === false ? '' : 'IF EXISTS ';
  return `DROP INDEX ${concurrently}${ifExists}${quoteIdent(indexName)};`;
}

/**
 * Whether an equality probe on `columns` is served by the table's indexes.
 *
 * All probe columns are equality predicates, so any index whose FIRST column is
 * one of the probed columns gives the planner an index path (a btree can't use
 * a column that isn't in its leading prefix). This is deliberately the loose
 * direction: it never flags a table that has *any* usable index for the probe,
 * at the cost of not demanding the ideal multi-column index. The primary key
 * counts as an index.
 */
export function isProbeIndexed(meta: TableMetadata, columns: string[]): boolean {
  const probe = new Set(columns);
  if (meta.primaryKey.length > 0 && meta.primaryKey[0] !== undefined && probe.has(meta.primaryKey[0])) {
    return true;
  }
  for (const idx of meta.indexes) {
    // A doc-field expression index (PowDB JSON path) targets `col->seg`, never
    // the raw column, so it can never serve an equality probe on that column.
    // Skip it so it can never falsely satisfy an FK-coverage check.
    if (idx.docPath) continue;
    const lead = idx.columns[0];
    if (lead !== undefined && probe.has(lead)) return true;
  }
  // Unique constraints are backed by indexes even when the index list omits them.
  for (const unique of meta.uniqueColumns) {
    const lead = unique[0];
    if (lead !== undefined && probe.has(lead)) return true;
  }
  return false;
}

/**
 * The deterministic index name `doctor --fix` uses for a relation-probe index:
 * `idx_<table>_<cols>` truncated to Postgres's 63-byte identifier limit. `doctor
 * --audit` recomputes this to recognize its own previously-suggested indexes.
 */
export function doctorIndexName(table: string, columns: string[]): string {
  return `idx_${table}_${columns.join('_')}`.slice(0, 63);
}

/** A (table, columns) pair whose probe maps to a given deterministic name. */
export interface DoctorProbeColumns {
  table: string;
  columns: string[];
}

/**
 * Map every deterministic doctor index name the schema's relation probes would
 * generate to the distinct column sets that produce it. A name that maps to more
 * than one distinct column set is a post-truncation collision (very long column
 * names slicing to the same 63 bytes): `doctor --audit` reports those as
 * ambiguous rather than issuing a confident drop verdict.
 */
export function collectDoctorProbeIndexNames(schema: SchemaMetadata): Map<string, DoctorProbeColumns[]> {
  const byName = new Map<string, DoctorProbeColumns[]>();
  for (const tableMeta of Object.values(schema.tables)) {
    for (const relDef of Object.values(tableMeta.relations)) {
      for (const probe of probesForRelation(relDef)) {
        if (!schema.tables[probe.table]) continue;
        const name = doctorIndexName(probe.table, probe.columns);
        let sets = byName.get(name);
        if (!sets) {
          sets = [];
          byName.set(name, sets);
        }
        const key = `${probe.table}\u0000${probe.columns.join(',')}`;
        if (!sets.some((s) => `${s.table}\u0000${s.columns.join(',')}` === key)) {
          sets.push({ table: probe.table, columns: probe.columns });
        }
      }
    }
  }
  return byName;
}

/**
 * Every (table, column set) a relation probe touches, deduplicated. Consumed by
 * the subtraction side of `doctor` so an index that still serves a live relation
 * is never handed a DROP: the same run's top half demands that index, and
 * recommending both in one report is how a tool loses a DBA's trust.
 */
export function collectRelationProbeColumns(schema: SchemaMetadata): DoctorProbeColumns[] {
  const seen = new Set<string>();
  const out: DoctorProbeColumns[] = [];
  for (const tableMeta of Object.values(schema.tables)) {
    for (const relDef of Object.values(tableMeta.relations)) {
      for (const probe of probesForRelation(relDef)) {
        if (!schema.tables[probe.table]) continue;
        const key = `${probe.table} ${probe.columns.join(',')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ table: probe.table, columns: probe.columns });
      }
    }
  }
  return out;
}

/** The (table, columns) pairs a relation causes Turbine to probe. */
function probesForRelation(relDef: {
  type: RelationProbe['type'];
  to: string;
  foreignKey: string | string[];
  referenceKey: string | string[];
  through?: { table: string; sourceKey: string | string[] };
}): Array<{ table: string; columns: string[] }> {
  switch (relDef.type) {
    case 'hasMany':
    case 'hasOne':
      // Correlation: child.foreignKey = parent.referenceKey, probes the child.
      return [{ table: relDef.to, columns: normalizeKeyColumns(relDef.foreignKey) }];
    case 'belongsTo':
      // Correlation: target.referenceKey = child.foreignKey, probes the target,
      // almost always by its PK (then isProbeIndexed passes via the PK check).
      return [{ table: relDef.to, columns: normalizeKeyColumns(relDef.referenceKey) }];
    case 'manyToMany': {
      if (!relDef.through) return [];
      // The junction is correlated to the parent by sourceKey; the target is
      // joined by its PK (covered by definition).
      return [{ table: relDef.through.table, columns: normalizeKeyColumns(relDef.through.sourceKey) }];
    }
  }
}

/**
 * Scan every relation in the schema and return the probes with no index support,
 * deduplicated by (table, column set) with all contributing relations attached.
 *
 * Only meaningful when the metadata carries index information (i.e. it came from
 * introspection or a generated client). Callers that may hold index-less metadata
 * should gate on {@link schemaHasIndexInfo} to avoid blanket false positives.
 */
export function findMissingRelationIndexes(schema: SchemaMetadata): MissingRelationIndex[] {
  const missing = new Map<string, MissingRelationIndex>();

  for (const [tableName, tableMeta] of Object.entries(schema.tables)) {
    for (const relDef of Object.values(tableMeta.relations)) {
      for (const probe of probesForRelation(relDef)) {
        const targetMeta = schema.tables[probe.table];
        if (!targetMeta) continue;
        if (isProbeIndexed(targetMeta, probe.columns)) continue;

        const key = `${probe.table}\u0000${[...probe.columns].sort().join(',')}`;
        let entry = missing.get(key);
        if (!entry) {
          const indexName = doctorIndexName(probe.table, probe.columns);
          entry = {
            table: probe.table,
            columns: probe.columns,
            probes: [],
            indexName,
            createSql: buildCreateIndexSql(probe.table, probe.columns, indexName),
            dropSql: buildDropIndexSql(indexName),
          };
          missing.set(key, entry);
        }
        entry.probes.push({ from: tableName, relation: relDef.name, type: relDef.type });
      }
    }
  }

  return [...missing.values()].sort((a, b) => a.table.localeCompare(b.table));
}

const indexInfoCache = new WeakMap<SchemaMetadata, boolean>();

/**
 * True when at least one table in the schema carries real, DB-backed index
 * metadata (i.e. from introspection).
 *
 * Excluded (so they never flip the flag, keeping the schema "index-info
 * unknown"):
 *   - doc-field expression indexes (`docPath`): they carry no FK-coverage info;
 *   - code-first DECLARED indexes (`declared`): the SQL DDL generators do NOT
 *     emit `TableDef.indexes` yet, so a declared index does not reflect a real
 *     index on the SQL engines. Counting one would arm blanket FK false
 *     positives (the FK auto-index the push path DID create is then reported
 *     "missing") and, inversely, suppress warnings for indexes never created.
 *     A pure code-first schema therefore stays silent exactly as it did before
 *     `TableDef.indexes` existed.
 */
export function schemaHasIndexInfo(schema: SchemaMetadata): boolean {
  let known = indexInfoCache.get(schema);
  if (known === undefined) {
    known = Object.values(schema.tables).some((t) => t.indexes.some((idx) => !idx.docPath && !idx.declared));
    indexInfoCache.set(schema, known);
  }
  return known;
}

/**
 * Single-relation check for the dev-mode runtime warning: the (table, columns)
 * this relation probes and whether that probe is unindexed. Returns null when
 * indexed, unknown, or when the schema carries no index info at all (metadata
 * built without introspection, warning would be a blanket false positive).
 */
export function missingIndexForRelation(
  schema: SchemaMetadata,
  relDef: {
    name: string;
    type: RelationProbe['type'];
    to: string;
    foreignKey: string | string[];
    referenceKey: string | string[];
    through?: { table: string; sourceKey: string | string[] };
  },
): { table: string; columns: string[]; createSql: string } | null {
  if (!schemaHasIndexInfo(schema)) return null;
  for (const probe of probesForRelation(relDef)) {
    const meta = schema.tables[probe.table];
    if (!meta) continue;
    if (!isProbeIndexed(meta, probe.columns)) {
      const indexName = doctorIndexName(probe.table, probe.columns);
      return {
        table: probe.table,
        columns: probe.columns,
        createSql: `CREATE INDEX ${quoteIdent(indexName)} ON ${quoteIdent(probe.table)} (${probe.columns.map(quoteIdent).join(', ')})`,
      };
    }
  }
  return null;
}
