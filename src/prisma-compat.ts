/**
 * turbine-orm/prisma-compat, a typed PrismaClient-surface adapter over a
 * {@link TurbineClient}.
 *
 * This subpath lets a codebase that speaks Prisma's `db.model.findMany(...)`
 * surface run on Turbine with minimal churn. It is a **pure TypeScript shim**:
 * zero new runtime dependencies, never imported by Turbine core, and driven
 * entirely by the {@link PrismaCompatMap} that `turbine migrate-from-prisma`
 * emits (`prisma-map.ts`). Every Prisma model / field / relation / compound
 * unique name in the map was resolved against live introspected metadata, so
 * the adapter only ever translates names it can prove exist.
 *
 * ## What it does
 *
 * - **Model delegates** under both the Prisma model name (`compat.User`) and
 *   Prisma's client-property spelling with the first letter lowercased
 *   (`compat.user`, what generated Prisma call sites actually use),
 *   translating args recursively: `include`→`with`, `select` split into scalar
 *   selection + relations, field/relation renames both ways through the map,
 *   `take`/`skip`→`limit`/`offset`, cursor pagination, and compound-unique
 *   selectors (including custom `@@unique(name:)` names the core `findUnique`
 *   derivation cannot know).
 * - **`$transaction`** in both forms: a callback (`$transaction(async (tx) => …)`)
 *   and Prisma's lazy array batching (`$transaction([a.create(...), b.update(...)])`)
 *  , the un-awaited delegate calls defer to Turbine's `build*()` methods and
 *   run atomically through the core batch `$transaction([...])` path.
 * - **Raw SQL**: `$queryRaw` / `$executeRaw` tagged templates (with
 *   `Prisma.sql`-style nested-fragment flattening) and the `*Unsafe` variants.
 * - **Result reshaping**: `_count` objects keyed back to Prisma relation names,
 *   and to-one relations surfaced as `object | null`.
 *
 * ## What it deliberately does NOT do (documented divergences)
 *
 * These cannot be faithfully translated and are not attempted; each throws or is
 * documented rather than silently returning wrong data:
 *
 * - `$extends` / client extensions, `$use` with Prisma's middleware param shape.
 * - `instanceof PrismaClientKnownRequestError`, `.meta`/message byte parity
 *   (opt into `prismaErrorCodes` for a `.code` like `P2002`, without pretending
 *   `instanceof` identity).
 * - `Prisma.join` / `Prisma.raw` composition beyond plain fragment flattening.
 * - Fluent relation chaining (`prisma.user.findUnique().posts()`).
 * - Accelerate / Pulse / driver-adapter preview features, the Mongo API, and the
 *   `prisma migrate`/`db` CLI family (Turbine ships its own migrations).
 * - **Inclusive bare cursors whose field is not the sort key**, see
 *   {@link translateCursor}. A bare Prisma cursor is inclusive; translating it
 *   correctly needs the anchor row's sort-key value. When the cursor field is
 *   the single `orderBy` field (or the cursor is the single-column PK with no
 *   `orderBy`) it compiles to a `gte`/`lte` keyset predicate; **otherwise it
 *   throws** an {@link UnsupportedFeatureError} rather than emit an off-by-one
 *   page. Pair the cursor with `skip: 1` (Prisma's idiom) for the exact
 *   exclusive-cursor + `offset` translation.
 * - **Negative `take`** (take-from-end) and **`skip` on a nested relation
 *   include** throw, Turbine's `with` clause has no offset and no reverse-take.
 *
 * ## Type dependencies (0.41.0)
 *
 * - Field-name identity fast path pairs with the generator's
 *   `--keep-column-names` output (byte-shaped like a snake_case Prisma client).
 * - Compound-unique default selectors are handled by the core
 *   `findUnique`-family derivation; this adapter only translates custom
 *   `@@unique(name:)` names on top.
 * - To-one relations return `object | null` natively once the unique-FK hasOne
 *   introspection default is in effect (0.41.0). Until a schema is regenerated,
 *   the map's `cardinality: 'one'` still drives the first-element-or-null guard,
 *   so the surface is correct either way.
 *
 * @example
 * ```ts
 * import { TurbineClient } from 'turbine-orm';
 * import { createPrismaCompatClient } from 'turbine-orm/prisma-compat';
 * import { SCHEMA } from './generated/turbine/metadata.js';
 * import { PRISMA_MAP } from './generated/turbine/prisma-map.js';
 *
 * const db = new TurbineClient({ connectionString: process.env.DATABASE_URL }, SCHEMA);
 * const prisma = createPrismaCompatClient(db, PRISMA_MAP);
 *
 * const users = await prisma.User.findMany({
 *   where: { email: { contains: '@acme.com' } },
 *   include: { posts: { orderBy: { createdAt: 'desc' }, take: 5 } },
 * });
 * ```
 */

// Type-only import: erased at runtime, so it introduces NO runtime cycle (core
// never imports this subpath). It lets the public factory accept the real
// `TurbineClient` for first-class consumer DX.
import type { TurbineClient } from './client.js';
import { TurbineError, TurbineErrorCode, UnsupportedFeatureError, ValidationError, wrapPgError } from './errors.js';
import type { DeferredQuery } from './query/index.js';
import type { PrismaCompatMap, PrismaModelMap, RelationDef, SchemaMetadata } from './schema.js';

// ---------------------------------------------------------------------------
// Minimal TurbineClient view, the exact surface the adapter needs. Declared
// structurally so the runtime never imports the concrete client (no cycle) and
// tests can pass a stub. The real `TurbineClient` satisfies it.
// ---------------------------------------------------------------------------

/** A build-only query object with the `build*` methods the adapter drives. */
export interface CompatQueryInterface {
  findMany(args?: Record<string, unknown>): Promise<unknown>;
  findFirst(args?: Record<string, unknown>): Promise<unknown>;
  findUnique(args: Record<string, unknown>): Promise<unknown>;
  findFirstOrThrow(args?: Record<string, unknown>): Promise<unknown>;
  findUniqueOrThrow(args: Record<string, unknown>): Promise<unknown>;
  create(args: Record<string, unknown>): Promise<unknown>;
  createMany(args: Record<string, unknown>): Promise<unknown[]>;
  update(args: Record<string, unknown>): Promise<unknown>;
  updateMany(args: Record<string, unknown>): Promise<{ count: number }>;
  delete(args: Record<string, unknown>): Promise<unknown>;
  deleteMany(args: Record<string, unknown>): Promise<{ count: number }>;
  upsert(args: Record<string, unknown>): Promise<unknown>;
  count(args?: Record<string, unknown>): Promise<number>;
  aggregate(args: Record<string, unknown>): Promise<unknown>;
  groupBy(args: Record<string, unknown>): Promise<unknown[]>;
  buildFindMany(args?: Record<string, unknown>): DeferredQuery<unknown>;
  buildFindFirst(args?: Record<string, unknown>): DeferredQuery<unknown>;
  buildFindUnique(args: Record<string, unknown>): DeferredQuery<unknown>;
  buildFindFirstOrThrow(args?: Record<string, unknown>): DeferredQuery<unknown>;
  buildFindUniqueOrThrow(args: Record<string, unknown>): DeferredQuery<unknown>;
  buildCreate(args: Record<string, unknown>): DeferredQuery<unknown>;
  buildCreateMany(args: Record<string, unknown>): DeferredQuery<unknown[]>;
  buildUpdate(args: Record<string, unknown>): DeferredQuery<unknown>;
  buildUpdateMany(args: Record<string, unknown>): DeferredQuery<{ count: number }>;
  buildDelete(args: Record<string, unknown>): DeferredQuery<unknown>;
  buildDeleteMany(args: Record<string, unknown>): DeferredQuery<{ count: number }>;
  buildUpsert(args: Record<string, unknown>): DeferredQuery<unknown>;
  buildCount(args?: Record<string, unknown>): DeferredQuery<number>;
  buildAggregate(args: Record<string, unknown>): DeferredQuery<unknown>;
  buildGroupBy(args: Record<string, unknown>): DeferredQuery<unknown[]>;
}

/** A transaction-scoped client handed to a `$transaction(callback)`. */
export interface CompatTransactionClient {
  table(name: string): CompatQueryInterface;
}

/** The minimal `TurbineClient` surface the adapter consumes. */
export interface CompatTurbineClient extends CompatTransactionClient {
  readonly schema: SchemaMetadata;
  $transaction<R>(fn: (tx: CompatTransactionClient) => Promise<R>, options?: unknown): Promise<R>;
  $transaction(queries: readonly DeferredQuery<unknown>[]): Promise<unknown[]>;
}

// ---------------------------------------------------------------------------
// Prisma.sql-style raw fragments (local, minimal, never imports @prisma/client)
// ---------------------------------------------------------------------------

const SQL_FRAGMENT = Symbol.for('turbine.prismaCompat.sqlFragment');

/** A composable SQL fragment, the local stand-in for `Prisma.Sql`. */
export interface Sql {
  /** Literal string segments; `strings.length === values.length + 1`. */
  readonly strings: readonly string[];
  /** Interpolated values, one between each pair of `strings`. */
  readonly values: readonly unknown[];
  readonly [SQL_FRAGMENT]: true;
}

function isSqlFragment(x: unknown): x is Sql {
  return typeof x === 'object' && x !== null && (x as { [SQL_FRAGMENT]?: unknown })[SQL_FRAGMENT] === true;
}

function makeSql(strings: readonly string[], values: readonly unknown[]): Sql {
  return { strings, values, [SQL_FRAGMENT]: true };
}

/**
 * `Prisma`-compatible raw-SQL helpers, a minimal local implementation so
 * migrated `Prisma.sql\`…\`` / `Prisma.join(...)` / `Prisma.raw(...)` calls keep
 * composing. Fragments are flattened at execution time into a single
 * parameterized statement (values become `$N`), so composition is injection-safe
 * by construction.
 */
export const Prisma = {
  /** Tagged-template fragment: `Prisma.sql\`id = ${id}\``. */
  sql(strings: TemplateStringsArray, ...values: unknown[]): Sql {
    return makeSql(strings as unknown as string[], values);
  },
  /**
   * Join fragments/values with a separator: `Prisma.join([1, 2, 3])` →
   * `$1, $2, $3`. Each element that is not already a fragment becomes a bound
   * value.
   */
  join(items: readonly unknown[], separator = ',', prefix = '', suffix = ''): Sql {
    if (items.length === 0) return makeSql([`${prefix}${suffix}`], []);
    const strings: string[] = [prefix];
    const values: unknown[] = [];
    items.forEach((item, i) => {
      values.push(item);
      strings.push(i === items.length - 1 ? suffix : separator);
    });
    return makeSql(strings, values);
  },
  /**
   * A raw, unparameterized SQL fragment. The string is spliced verbatim, never
   * pass user input here (matches Prisma's `Prisma.raw` contract).
   */
  raw(sql: string): Sql {
    return makeSql([sql], []);
  },
  /** An empty fragment. */
  empty: makeSql([''], []) as Sql,
};

// ---------------------------------------------------------------------------
// Options + error decoration
// ---------------------------------------------------------------------------

/** Options for {@link createPrismaCompatClient}. */
export interface PrismaCompatOptions {
  /**
   * When `true`, every to-many `with` relation lacking an explicit `orderBy` is
   * loaded ordered by the target table's primary key ascending (Prisma's
   * relation rows come back in a stable order). This passes through to Turbine's
   * core `stableRelationOrder` flag, it never re-walks the `with` tree. An
   * explicit per-relation `orderBy` always wins. Default `false`.
   */
  stablePkOrder?: boolean;
  /**
   * When `true`, thrown {@link TurbineError}s are decorated with a `.code` equal
   * to the nearest Prisma error code (e.g. `P2002` for a unique violation),
   * WITHOUT pretending `instanceof PrismaClientKnownRequestError`. Default
   * `false` (Turbine's own `TURBINE_E0NN` codes are preserved untouched).
   */
  prismaErrorCodes?: boolean;
}

/** Turbine error code → nearest Prisma `PXXXX` code. */
const PRISMA_ERROR_CODE: Record<string, string> = {
  [TurbineErrorCode.UNIQUE_VIOLATION]: 'P2002',
  [TurbineErrorCode.NOT_FOUND]: 'P2025',
  [TurbineErrorCode.FOREIGN_KEY_VIOLATION]: 'P2003',
  [TurbineErrorCode.NOT_NULL_VIOLATION]: 'P2011',
  [TurbineErrorCode.TIMEOUT]: 'P2024',
};

/** Attach a Prisma-style `.code` to a TurbineError when the option is on. */
function decorate(err: unknown, prismaErrorCodes: boolean): unknown {
  if (prismaErrorCodes && err instanceof TurbineError) {
    const p = PRISMA_ERROR_CODE[err.code];
    if (p) (err as { code: string }).code = p;
  }
  return err;
}

// ---------------------------------------------------------------------------
// Compat context, the map + schema + resolved lookups, built once per client.
// ---------------------------------------------------------------------------

interface ModelLookups {
  /** turbine field name → prisma field name (result reshaping). */
  reverseFields: Record<string, string>;
  /** field names are identity (prisma === turbine), skip rekeying entirely. */
  identityFields: boolean;
  /** turbine relation name → { prismaName, cardinality }. */
  reverseRelations: Record<string, { prismaName: string; cardinality: 'one' | 'many' }>;
  /**
   * turbine field names whose column is a Postgres `time` type. Prisma
   * surfaces those as a `Date` on 1970-01-01 UTC (epoch-day convention);
   * turbine core returns the driver's raw `HH:MM:SS` string. The adapter
   * converts on read so `.getHours()`-style call sites survive migration.
   */
  timeFields: Set<string>;
}

interface Ctx {
  map: PrismaCompatMap;
  schema: SchemaMetadata;
  /** turbine table name → prisma model name. */
  tableToModel: Map<string, string>;
  lookups: Map<string, ModelLookups>;
  options: Required<PrismaCompatOptions>;
}

const TIME_PG_TYPES = new Set(['time', 'time without time zone', 'timetz', 'time with time zone']);

/** `HH:MM:SS(.fff)?` (a pg `time` wire value) → Prisma's epoch-day `Date`. */
function timeStringToDate(v: string): Date | null {
  const m = v.match(/^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/);
  if (!m) return null;
  const ms = m[4] ? Math.round(Number(`0.${m[4]}`) * 1000) : 0;
  return new Date(Date.UTC(1970, 0, 1, Number(m[1]), Number(m[2]), Number(m[3]), ms));
}

function buildLookups(ctx: Ctx, mm: PrismaModelMap): ModelLookups {
  const reverseFields: Record<string, string> = {};
  let identityFields = true;
  for (const [prismaField, turbineField] of Object.entries(mm.fields)) {
    reverseFields[turbineField] = prismaField;
    if (prismaField !== turbineField) identityFields = false;
  }
  const reverseRelations: Record<string, { prismaName: string; cardinality: 'one' | 'many' }> = {};
  for (const [prismaRel, rel] of Object.entries(mm.relations)) {
    reverseRelations[rel.name] = { prismaName: prismaRel, cardinality: rel.cardinality };
  }
  const timeFields = new Set<string>();
  for (const col of ctx.schema.tables[mm.table]?.columns ?? []) {
    if (TIME_PG_TYPES.has(col.pgType)) timeFields.add(col.field);
  }
  return { reverseFields, identityFields, reverseRelations, timeFields };
}

function lookupsFor(ctx: Ctx, mm: PrismaModelMap): ModelLookups {
  let l = ctx.lookups.get(mm.table);
  if (!l) {
    l = buildLookups(ctx, mm);
    ctx.lookups.set(mm.table, l);
  }
  return l;
}

/** Resolve a turbine relation's target Prisma model map (for nested translation). */
function relTargetModel(ctx: Ctx, mm: PrismaModelMap, turbineRel: string): PrismaModelMap | undefined {
  const rd: RelationDef | undefined = ctx.schema.tables[mm.table]?.relations?.[turbineRel];
  if (!rd) return undefined;
  const modelName = ctx.tableToModel.get(rd.to);
  return modelName ? ctx.map.models[modelName] : undefined;
}

// ---------------------------------------------------------------------------
// Argument translation
// ---------------------------------------------------------------------------

const COMBINATORS = new Set(['AND', 'OR', 'NOT']);
const RELATION_QUANTIFIERS = new Set(['some', 'every', 'none']);

/** Whether a value is a plain object usable as a compound-unique selector. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    !(v instanceof Date) &&
    !(typeof Buffer !== 'undefined' && Buffer.isBuffer(v))
  );
}

function renameField(mm: PrismaModelMap, prismaField: string): string {
  return mm.fields[prismaField] ?? prismaField;
}

/**
 * Translate a Prisma `where` (or nested relation where) into a Turbine `where`.
 * Renames scalar field keys and relation keys through the map, recurses into
 * `AND`/`OR`/`NOT`, translates relation quantifier filters (`some`/`every`/
 * `none`) against the target model, and rewrites compound-unique selectors -
 * including custom `@@unique(name:)` names, into the core-derived selector form
 * so Turbine's `findUnique`-family expansion handles them uniformly.
 */
function translateWhere(ctx: Ctx, mm: PrismaModelMap, where: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(where)) return where as undefined;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(where)) {
    if (COMBINATORS.has(key)) {
      out[key] = Array.isArray(val) ? val.map((v) => translateWhere(ctx, mm, v)) : translateWhere(ctx, mm, val);
      continue;
    }
    // Compound-unique selector (custom or default Prisma name).
    const compound = mm.compoundUniques[key];
    if (compound && isPlainObject(val) && !mm.fields[key] && !mm.relations[key]) {
      const inner: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(val)) inner[renameField(mm, pk)] = pv;
      // Turbine's core derives the selector name from the underscore-join of the
      // member FIELD names, so re-key custom names onto that canonical form.
      out[compound.join('_')] = inner;
      continue;
    }
    // Relation filter.
    const rel = mm.relations[key];
    if (rel) {
      const target = relTargetModel(ctx, mm, rel.name);
      out[rel.name] = translateRelationFilter(ctx, target, val);
      continue;
    }
    // Scalar field, key renamed, value (literal or operator object) passes
    // through unchanged (Prisma operator names match Turbine's).
    out[renameField(mm, key)] = val;
  }
  return out;
}

function translateRelationFilter(ctx: Ctx, target: PrismaModelMap | undefined, val: unknown): unknown {
  if (!isPlainObject(val)) return val;
  const keys = Object.keys(val);
  const hasQuantifier = keys.some((k) => RELATION_QUANTIFIERS.has(k) || k === 'is' || k === 'isNot');
  if (hasQuantifier) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val)) {
      out[k] =
        target && (RELATION_QUANTIFIERS.has(k) || k === 'is' || k === 'isNot') ? translateWhere(ctx, target, v) : v;
    }
    return out;
  }
  // A bare object filter on a to-one relation: translate its body.
  return target ? translateWhere(ctx, target, val) : val;
}

/** Translate a Prisma `orderBy` (object / array) into a Turbine `orderBy`. */
function translateOrderBy(ctx: Ctx, mm: PrismaModelMap, ob: unknown): unknown {
  if (Array.isArray(ob)) return ob.map((o) => translateOrderBy(ctx, mm, o));
  if (!isPlainObject(ob)) return ob;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(ob)) {
    if (key === '_count') {
      out._count = val;
      continue;
    }
    const rel = mm.relations[key];
    if (rel) {
      const target = relTargetModel(ctx, mm, rel.name);
      out[rel.name] = isPlainObject(val) && !('_count' in val) && target ? translateOrderBy(ctx, target, val) : val;
      continue;
    }
    out[renameField(mm, key)] = val;
  }
  return out;
}

/** Map a Prisma `take` to a Turbine `limit`. Negative take is unsupported. */
function mapTake(take: number): number {
  if (take < 0) {
    throw new UnsupportedFeatureError(
      'negative take (take-from-end pagination)',
      'prisma-compat',
      'Turbine has no reverse-take; reverse your orderBy and use a positive take instead.',
    );
  }
  return take;
}

interface Projection {
  select?: Record<string, boolean>;
  with?: Record<string, unknown>;
}

/**
 * Translate Prisma `include` / `select` into Turbine `{ select, with }`.
 * `include` keeps all scalars and adds relations; `select` narrows scalars and
 * may also pull relations + `_count`. The two are mutually exclusive.
 */
function translateProjection(ctx: Ctx, mm: PrismaModelMap, args: Record<string, unknown>): Projection {
  const include = args.include as Record<string, unknown> | undefined;
  const select = args.select as Record<string, unknown> | undefined;
  if (include && select) {
    throw new ValidationError('[turbine] prisma-compat: `include` and `select` are mutually exclusive.');
  }
  const withClause: Record<string, unknown> = {};
  let hasWith = false;

  if (include) {
    for (const [key, val] of Object.entries(include)) {
      if (val === false || val == null) continue;
      if (key === '_count') {
        withClause._count = translateCountSelect(mm, val);
        hasWith = true;
        continue;
      }
      const rel = mm.relations[key];
      if (!rel) {
        throw new ValidationError(
          `[turbine] prisma-compat: unknown relation "${key}" in include on model "${modelName(ctx, mm)}".`,
        );
      }
      withClause[rel.name] = translateWithOption(ctx, mm, rel.name, val);
      hasWith = true;
    }
    return { with: hasWith ? withClause : undefined };
  }

  if (select) {
    const scalar: Record<string, boolean> = {};
    let hasScalar = false;
    for (const [key, val] of Object.entries(select)) {
      if (val === false || val == null) continue;
      if (key === '_count') {
        withClause._count = translateCountSelect(mm, val);
        hasWith = true;
        continue;
      }
      const rel = mm.relations[key];
      if (rel) {
        withClause[rel.name] = translateWithOption(ctx, mm, rel.name, val);
        hasWith = true;
        continue;
      }
      scalar[renameField(mm, key)] = true;
      hasScalar = true;
    }
    return { select: hasScalar ? scalar : undefined, with: hasWith ? withClause : undefined };
  }

  return {};
}

/** Translate a Prisma relation include payload into a Turbine `WithOptions`. */
function translateWithOption(ctx: Ctx, mm: PrismaModelMap, turbineRel: string, val: unknown): unknown {
  if (val === true) return true;
  if (!isPlainObject(val)) return true;
  const target = relTargetModel(ctx, mm, turbineRel);
  const opt: Record<string, unknown> = {};
  if (val.where !== undefined) opt.where = target ? translateWhere(ctx, target, val.where) : val.where;
  if (val.orderBy !== undefined) opt.orderBy = target ? translateOrderBy(ctx, target, val.orderBy) : val.orderBy;
  if (val.take !== undefined) opt.limit = mapTake(val.take as number);
  if (val.skip !== undefined) {
    throw new UnsupportedFeatureError(
      'skip (offset) on a nested relation include',
      'prisma-compat',
      "Turbine's `with` clause has no offset, page the relation with a separate query.",
    );
  }
  if (target && (val.select !== undefined || val.include !== undefined)) {
    const proj = translateProjection(ctx, target, val);
    if (proj.select) opt.select = proj.select;
    if (proj.with) opt.with = proj.with;
  }
  return opt;
}

/** Translate a Prisma `_count: { select: { rel: true } }` / `true` into Turbine `with._count`. */
function translateCountSelect(mm: PrismaModelMap, val: unknown): unknown {
  if (val === true) return true;
  if (isPlainObject(val) && isPlainObject(val.select)) {
    const out: Record<string, boolean> = {};
    for (const [key, v] of Object.entries(val.select)) {
      if (!v) continue;
      const rel = mm.relations[key];
      if (rel) out[rel.name] = true;
    }
    return out;
  }
  return true;
}

function modelName(ctx: Ctx, mm: PrismaModelMap): string {
  return ctx.tableToModel.get(mm.table) ?? mm.table;
}

/**
 * Assemble Turbine findMany-family args from Prisma read args. Order matters:
 * `where` / `orderBy` are translated first so the cursor step (which may inject
 * a keyset predicate) operates in the translated turbine-field space.
 */
function translateReadArgs(ctx: Ctx, mm: PrismaModelMap, prismaArgs: Record<string, unknown>): Record<string, unknown> {
  const t: Record<string, unknown> = {};
  if (prismaArgs.where !== undefined) t.where = translateWhere(ctx, mm, prismaArgs.where);
  if (prismaArgs.orderBy !== undefined) t.orderBy = translateOrderBy(ctx, mm, prismaArgs.orderBy);
  const proj = translateProjection(ctx, mm, prismaArgs);
  if (proj.select) t.select = proj.select;
  if (proj.with) t.with = proj.with;
  if (Array.isArray(prismaArgs.distinct)) {
    t.distinct = (prismaArgs.distinct as string[]).map((f) => renameField(mm, f));
  }
  if (prismaArgs.relationLoadStrategy !== undefined) t.relationLoadStrategy = prismaArgs.relationLoadStrategy;
  if (typeof prismaArgs.timeout === 'number') t.timeout = prismaArgs.timeout;
  if (ctx.options.stablePkOrder) t.stableRelationOrder = true;
  translateCursor(ctx, mm, prismaArgs, t);
  return t;
}

/** turbine field names of the model's single-column primary key, if any. */
function singleColumnPkField(ctx: Ctx, mm: PrismaModelMap): string | undefined {
  const pk = ctx.schema.tables[mm.table]?.primaryKey;
  if (pk && pk.length === 1) {
    const col = pk[0]!;
    return ctx.schema.tables[mm.table]?.reverseColumnMap?.[col] ?? col;
  }
  return undefined;
}

/**
 * Translate Prisma cursor + take/skip onto Turbine args (operating on already
 * translated `t.where` / `t.orderBy` in turbine-field space).
 *
 * - **No cursor:** `skip`→`offset`, `take`→`limit`.
 * - **Cursor + `skip: n` (n≥1):** the idiomatic exclusive-pagination case →
 *   Turbine's exclusive `cursor` + `offset: n-1` (skip:1 → offset 0, an exact
 *   match).
 * - **Bare inclusive cursor** (skip absent/0): a Prisma cursor is INCLUSIVE, so
 *   it needs the anchor's sort-key value. Compiled to a `gte`/`lte` keyset
 *   predicate merged into `where` ONLY when the cursor is single-field AND that
 *   field is the single `orderBy` field (or, with no `orderBy`, is the
 *   single-column PK). Any other shape THROWS rather than emit a wrong page -
 *   pair the cursor with `skip: 1` for the exact exclusive translation.
 */
function translateCursor(
  ctx: Ctx,
  mm: PrismaModelMap,
  prismaArgs: Record<string, unknown>,
  t: Record<string, unknown>,
): void {
  const cursor = prismaArgs.cursor as Record<string, unknown> | undefined;
  const skip = prismaArgs.skip as number | undefined;
  const take = prismaArgs.take as number | undefined;
  if (take !== undefined) t.limit = mapTake(take);

  if (cursor === undefined) {
    if (skip !== undefined) t.offset = skip;
    return;
  }

  // Translate cursor field names (and expand a compound-unique selector cursor).
  const tcursor: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(cursor)) {
    if (val === undefined) continue;
    const compound = mm.compoundUniques[key];
    if (compound && isPlainObject(val)) {
      for (const [pk, pv] of Object.entries(val)) tcursor[renameField(mm, pk)] = pv;
    } else {
      tcursor[renameField(mm, key)] = val;
    }
  }
  const cursorFields = Object.keys(tcursor);

  if (skip !== undefined && skip >= 1) {
    t.cursor = tcursor;
    t.offset = skip - 1;
    return;
  }

  // Bare inclusive cursor (skip absent or 0).
  if (cursorFields.length !== 1) {
    throw new UnsupportedFeatureError(
      'inclusive multi-field cursor without skip',
      'prisma-compat',
      'Pair the cursor with `skip: 1` (the Prisma idiom) so it maps to an exact exclusive cursor.',
    );
  }
  const field = cursorFields[0]!;
  const value = tcursor[field];
  const obEntries = orderByPairs(t.orderBy);
  let desc = false;
  if (obEntries.length === 0) {
    const pkField = singleColumnPkField(ctx, mm);
    if (!pkField || field !== pkField) {
      throw new UnsupportedFeatureError(
        'inclusive cursor without orderBy on a non-PK field',
        'prisma-compat',
        `A bare Prisma cursor is inclusive; translating it needs the cursor field "${field}" to be the single-column primary key, or to be the single orderBy field. Pair the cursor with \`skip: 1\`.`,
      );
    }
    t.orderBy = { [field]: 'asc' };
  } else {
    if (obEntries.length !== 1 || obEntries[0]![0] !== field) {
      throw new UnsupportedFeatureError(
        'inclusive cursor whose field is not the sort key',
        'prisma-compat',
        `A bare Prisma cursor is inclusive; translating it needs the cursor field "${field}" to be the single orderBy field. Order by "${field}", or pair the cursor with \`skip: 1\`.`,
      );
    }
    desc = obEntries[0]![1];
  }
  const op = desc ? 'lte' : 'gte';
  t.where = mergeKeyset((t.where as Record<string, unknown>) ?? {}, field, op, value);
}

/** Flatten a Turbine orderBy (object or single-object array) into [field, isDesc] pairs. */
function orderByPairs(ob: unknown): [string, boolean][] {
  const one = Array.isArray(ob) ? (ob.length === 1 ? ob[0] : undefined) : ob;
  if (!isPlainObject(one)) return [];
  const out: [string, boolean][] = [];
  for (const [k, v] of Object.entries(one)) {
    const dir = isPlainObject(v) ? (v.sort as string) : (v as string);
    out.push([k, dir === 'desc']);
  }
  return out;
}

/** Merge a `{ field: { gte|lte: value } }` keyset predicate into a where object. */
function mergeKeyset(
  where: Record<string, unknown>,
  field: string,
  op: string,
  value: unknown,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...where };
  const existing = merged[field];
  if (isPlainObject(existing)) {
    merged[field] = { ...existing, [op]: value };
  } else if (existing !== undefined) {
    const prevAnd = merged.AND;
    const andList = Array.isArray(prevAnd) ? prevAnd : prevAnd !== undefined ? [prevAnd] : [];
    merged.AND = [...andList, { [field]: { [op]: value } }];
  } else {
    merged[field] = { [op]: value };
  }
  return merged;
}

// --- write-data translation (nested writes) -------------------------------

const NESTED_WRITE_OPS = new Set([
  'create',
  'createMany',
  'connect',
  'connectOrCreate',
  'disconnect',
  'set',
  'delete',
  'deleteMany',
  'update',
  'updateMany',
  'upsert',
]);

/**
 * Translate Prisma create/update `data` (including nested relation write ops)
 * into Turbine's shape. Scalar keys are renamed via the map; relation keys are
 * renamed to their Turbine relation name and their nested-write payloads are
 * translated against the target model (op names match Prisma's).
 */
function translateWriteData(ctx: Ctx, mm: PrismaModelMap, data: unknown): unknown {
  if (!isPlainObject(data)) return data;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(data)) {
    const rel = mm.relations[key];
    if (rel && isPlainObject(val) && Object.keys(val).some((k) => NESTED_WRITE_OPS.has(k))) {
      const target = relTargetModel(ctx, mm, rel.name);
      out[rel.name] = translateNestedWrite(ctx, target, val);
      continue;
    }
    out[renameField(mm, key)] = val;
  }
  return out;
}

function translateNestedWrite(ctx: Ctx, target: PrismaModelMap | undefined, ops: Record<string, unknown>): unknown {
  const out: Record<string, unknown> = {};
  for (const [op, payload] of Object.entries(ops)) {
    switch (op) {
      case 'create':
      case 'createMany':
        out[op] = mapMaybeArray(payload, (p) => (target ? translateWriteData(ctx, target, p) : p));
        break;
      case 'connect':
      case 'disconnect':
      case 'delete':
      case 'set':
        out[op] = mapMaybeArray(payload, (p) => (target ? translateWhere(ctx, target, p) : p));
        break;
      case 'deleteMany':
      case 'updateMany':
        out[op] = mapMaybeArray(payload, (p) => translateWhereDataPair(ctx, target, p));
        break;
      case 'update':
        out[op] = mapMaybeArray(payload, (p) => translateWhereDataPair(ctx, target, p));
        break;
      case 'connectOrCreate':
        out[op] = mapMaybeArray(payload, (p) => translateConnectOrCreate(ctx, target, p));
        break;
      case 'upsert':
        out[op] = mapMaybeArray(payload, (p) => translateUpsertNested(ctx, target, p));
        break;
      default:
        out[op] = payload;
    }
  }
  return out;
}

function mapMaybeArray(val: unknown, fn: (item: unknown) => unknown): unknown {
  return Array.isArray(val) ? val.map(fn) : fn(val);
}

/** A `{ where?, data }` pair (nested update/updateMany), or a bare data object. */
function translateWhereDataPair(ctx: Ctx, target: PrismaModelMap | undefined, p: unknown): unknown {
  if (!isPlainObject(p)) return p;
  if ('data' in p || 'where' in p) {
    const out: Record<string, unknown> = {};
    if (p.where !== undefined) out.where = target ? translateWhere(ctx, target, p.where) : p.where;
    if (p.data !== undefined) out.data = target ? translateWriteData(ctx, target, p.data) : p.data;
    return out;
  }
  return target ? translateWriteData(ctx, target, p) : p;
}

function translateConnectOrCreate(ctx: Ctx, target: PrismaModelMap | undefined, p: unknown): unknown {
  if (!isPlainObject(p)) return p;
  const out: Record<string, unknown> = {};
  if (p.where !== undefined) out.where = target ? translateWhere(ctx, target, p.where) : p.where;
  if (p.create !== undefined) out.create = target ? translateWriteData(ctx, target, p.create) : p.create;
  return out;
}

function translateUpsertNested(ctx: Ctx, target: PrismaModelMap | undefined, p: unknown): unknown {
  if (!isPlainObject(p)) return p;
  const out: Record<string, unknown> = {};
  if (p.where !== undefined) out.where = target ? translateWhere(ctx, target, p.where) : p.where;
  if (p.create !== undefined) out.create = target ? translateWriteData(ctx, target, p.create) : p.create;
  if (p.update !== undefined) out.update = target ? translateWriteData(ctx, target, p.update) : p.update;
  return out;
}

// --- aggregate / groupBy translation --------------------------------------

const AGG_FIELD_BLOCKS = ['_sum', '_avg', '_min', '_max'] as const;

function translateAggregateArgs(
  ctx: Ctx,
  mm: PrismaModelMap,
  args: Record<string, unknown>,
  isGroupBy: boolean,
): Record<string, unknown> {
  const t: Record<string, unknown> = {};
  if (args.where !== undefined) t.where = translateWhere(ctx, mm, args.where);
  if (args._count !== undefined) t._count = renameAggBlock(mm, args._count, true);
  for (const block of AGG_FIELD_BLOCKS) {
    if (args[block] !== undefined) t[block] = renameAggBlock(mm, args[block], false);
  }
  if (typeof args.timeout === 'number') t.timeout = args.timeout;
  if (isGroupBy) {
    if (Array.isArray(args.by)) t.by = (args.by as string[]).map((f) => renameField(mm, f));
    if (args.orderBy !== undefined) t.orderBy = translateOrderBy(ctx, mm, args.orderBy);
    if (args.having !== undefined) t.having = renameHaving(mm, args.having);
    if (typeof args.take === 'number') t.limit = mapTake(args.take);
    if (typeof args.skip === 'number') t.offset = args.skip;
  }
  return t;
}

/** Rename field keys inside an aggregate block; `_count`'s `_all` passes through. */
function renameAggBlock(mm: PrismaModelMap, block: unknown, isCount: boolean): unknown {
  if (block === true || !isPlainObject(block)) return block;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(block)) {
    if (isCount && key === '_all') {
      out._all = val;
      continue;
    }
    out[renameField(mm, key)] = val;
  }
  return out;
}

function renameHaving(mm: PrismaModelMap, having: unknown): unknown {
  if (!isPlainObject(having)) return having;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(having)) {
    if (COMBINATORS.has(key)) {
      out[key] = Array.isArray(val) ? val.map((v) => renameHaving(mm, v)) : renameHaving(mm, val);
      continue;
    }
    if (key === '_count') {
      out._count = val;
      continue;
    }
    out[renameField(mm, key)] = val;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Result reshaping (turbine field/relation names → prisma names)
// ---------------------------------------------------------------------------

function reshapeRows(ctx: Ctx, mm: PrismaModelMap, rows: unknown): unknown {
  return Array.isArray(rows) ? rows.map((r) => reshapeRow(ctx, mm, r)) : rows;
}

function reshapeRowOrNull(ctx: Ctx, mm: PrismaModelMap, row: unknown): unknown {
  return row == null ? null : reshapeRow(ctx, mm, row);
}

function reshapeRow(ctx: Ctx, mm: PrismaModelMap, row: unknown): unknown {
  if (!isPlainObject(row)) return row;
  const l = lookupsFor(ctx, mm);
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(row)) {
    if (key === '_count') {
      out._count = reshapeCount(l, val);
      continue;
    }
    const rel = l.reverseRelations[key];
    if (rel) {
      const target = relTargetModel(ctx, mm, key);
      let rv: unknown;
      if (Array.isArray(val)) {
        const mapped = target ? val.map((x) => reshapeRow(ctx, target, x)) : val;
        // To-one guard: legacy 'many' metadata may still surface an array; the
        // map's cardinality is authoritative → first element or null.
        rv = rel.cardinality === 'one' ? (mapped.length ? mapped[0] : null) : mapped;
      } else if (isPlainObject(val)) {
        rv = target ? reshapeRow(ctx, target, val) : val;
      } else {
        rv = val; // null to-one
      }
      out[rel.prismaName] = rv;
      continue;
    }
    let sv = val;
    if (typeof sv === 'string' && l.timeFields.has(key)) {
      sv = timeStringToDate(sv) ?? sv;
    }
    out[l.identityFields ? key : (l.reverseFields[key] ?? key)] = sv;
  }
  return out;
}

function reshapeCount(l: ModelLookups, count: unknown): unknown {
  if (!isPlainObject(count)) return count;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(count)) {
    if (key === '_all') {
      out._all = val;
      continue;
    }
    out[l.reverseRelations[key]?.prismaName ?? key] = val;
  }
  return out;
}

/** Reshape an aggregate result: field keys inside blocks → prisma names. */
function reshapeAggregate(ctx: Ctx, mm: PrismaModelMap, res: unknown): unknown {
  if (!isPlainObject(res)) return res;
  const l = lookupsFor(ctx, mm);
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(res)) {
    if (key === '_count') {
      out._count = reshapeAggFieldBlock(l, val, true);
      continue;
    }
    if ((AGG_FIELD_BLOCKS as readonly string[]).includes(key)) {
      out[key] = reshapeAggFieldBlock(l, val, false);
      continue;
    }
    let sv = val;
    if (typeof sv === 'string' && l.timeFields.has(key)) {
      sv = timeStringToDate(sv) ?? sv;
    }
    out[l.identityFields ? key : (l.reverseFields[key] ?? key)] = sv;
  }
  return out;
}

function reshapeAggFieldBlock(l: ModelLookups, block: unknown, isCount: boolean): unknown {
  if (!isPlainObject(block)) return block;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(block)) {
    if (isCount && key === '_all') {
      out._all = val;
      continue;
    }
    out[l.reverseFields[key] ?? key] = val;
  }
  return out;
}

/** Reshape a groupBy row: by-field keys + aggregate blocks → prisma names. */
function reshapeGroupRow(ctx: Ctx, mm: PrismaModelMap, row: unknown): unknown {
  if (!isPlainObject(row)) return row;
  const l = lookupsFor(ctx, mm);
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(row)) {
    if (key === '_count') {
      out._count = reshapeAggFieldBlock(l, val, true);
      continue;
    }
    if ((AGG_FIELD_BLOCKS as readonly string[]).includes(key)) {
      out[key] = reshapeAggFieldBlock(l, val, false);
      continue;
    }
    let sv = val;
    if (typeof sv === 'string' && l.timeFields.has(key)) {
      sv = timeStringToDate(sv) ?? sv;
    }
    out[l.identityFields ? key : (l.reverseFields[key] ?? key)] = sv;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lazy PrismaPromise-style thenable + $transaction array batching seam
// ---------------------------------------------------------------------------

/** Symbol under which a lazy delegate call exposes its batchable plan. */
export const COMPAT_DEFERRED = Symbol.for('turbine.prismaCompat.deferred');

interface Batchable {
  /** Build the single Turbine {@link DeferredQuery} this call would run. */
  build(): DeferredQuery<unknown>;
  /** Reshape a raw Turbine result into the Prisma-shaped value. */
  reshape(raw: unknown): unknown;
  /**
   * True when this call cannot run as a single deferred statement (nested
   * write data, or an upsert needing the lookup-first path). The
   * `$transaction([...])` batch handler falls back to running the WHOLE array
   * sequentially inside one transaction so Prisma's array form still supports
   * nested writes.
   */
  nested(): boolean;
  /** Run the call via the async (nested-write capable) wrappers on a tx-bound table lookup. */
  execInTx(table: (name: string) => CompatQueryInterface): Promise<unknown>;
}

/**
 * A lazy, Prisma-style promise: the underlying query does not run until the
 * value is awaited (`.then`), and a `$transaction([...])` array can instead pull
 * the batchable plan via {@link COMPAT_DEFERRED} to run it atomically.
 */
class CompatPromise<T> implements PromiseLike<T> {
  private promise?: Promise<T>;
  /** Absent for calls that cannot be a single DeferredQuery (rare). */
  readonly [COMPAT_DEFERRED]?: Batchable;
  constructor(
    private readonly run: () => Promise<T>,
    batchable?: Batchable,
  ) {
    this[COMPAT_DEFERRED] = batchable;
  }

  private exec(): Promise<T> {
    this.promise ??= this.run();
    return this.promise;
  }
  // biome-ignore lint/suspicious/noThenProperty: a `then` member is the point, this is an intentional PrismaPromise-style thenable.
  then<R1 = T, R2 = never>(
    onFulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return this.exec().then(onFulfilled, onRejected);
  }
  catch<R = never>(onRejected?: ((reason: unknown) => R | PromiseLike<R>) | null): Promise<T | R> {
    return this.exec().catch(onRejected);
  }
  finally(onFinally?: (() => void) | null): Promise<T> {
    return this.exec().finally(onFinally);
  }
}

function batchableOf(v: unknown): Batchable | undefined {
  return v instanceof CompatPromise ? (v as unknown as { [COMPAT_DEFERRED]?: Batchable })[COMPAT_DEFERRED] : undefined;
}

// ---------------------------------------------------------------------------
// Public typed surface (hand-declared generic, driven by generated entity types)
// ---------------------------------------------------------------------------

/**
 * The per-model type bundle a consumer supplies to type a model delegate.
 * Populate `Row` (and optionally the arg shapes) from the generated entity
 * types; unspecified members fall back to permissive shapes.
 */
export interface PrismaModelTypes {
  Row: object;
  Create?: object;
  Update?: object;
  Where?: object;
  OrderBy?: object;
  Select?: object;
  Include?: object;
}

type Args = Record<string, unknown>;

/** A typed model delegate mirroring Prisma's `db.model.*` surface. */
export interface PrismaModelDelegate<M extends PrismaModelTypes> {
  findMany(args?: Args): Promise<M['Row'][]>;
  findFirst(args?: Args): Promise<M['Row'] | null>;
  findUnique(args: Args): Promise<M['Row'] | null>;
  findFirstOrThrow(args?: Args): Promise<M['Row']>;
  findUniqueOrThrow(args: Args): Promise<M['Row']>;
  create(args: Args): Promise<M['Row']>;
  createMany(args: Args): Promise<{ count: number }>;
  update(args: Args): Promise<M['Row']>;
  updateMany(args: Args): Promise<{ count: number }>;
  delete(args: Args): Promise<M['Row']>;
  deleteMany(args?: Args): Promise<{ count: number }>;
  upsert(args: Args): Promise<M['Row']>;
  count(args?: Args): Promise<number>;
  aggregate(args: Args): Promise<Record<string, unknown>>;
  groupBy(args: Args): Promise<Record<string, unknown>[]>;
}

/** The client-level surface (`$transaction` / raw), added to the model map. */
export interface PrismaCompatClientBase<S extends Record<string, PrismaModelTypes> = Record<string, PrismaModelTypes>> {
  $transaction<R>(
    fn: (tx: PrismaCompatTransactionClient<S>) => Promise<R>,
    options?: PrismaCompatTxOptions,
  ): Promise<R>;
  $transaction<P extends readonly PromiseLike<unknown>[]>(
    promises: readonly [...P],
  ): Promise<{ [K in keyof P]: Awaited<P[K]> }>;
  $queryRaw<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>;
  $queryRawUnsafe<T = unknown>(sql: string, ...params: unknown[]): Promise<T[]>;
  $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<number>;
  $executeRawUnsafe(sql: string, ...params: unknown[]): Promise<number>;
  $connect(): Promise<void>;
  $disconnect(): Promise<void>;
}

/** Options accepted by the callback form of `$transaction`. */
export interface PrismaCompatTxOptions {
  isolationLevel?: 'ReadUncommitted' | 'ReadCommitted' | 'RepeatableRead' | 'Serializable';
  timeout?: number;
  maxWait?: number;
}

/** The transaction-scoped client handed to a `$transaction(callback)`. */
export type PrismaCompatTransactionClient<
  S extends Record<string, PrismaModelTypes> = Record<string, PrismaModelTypes>,
> = {
  [K in keyof S]: PrismaModelDelegate<S[K]>;
};

/**
 * The full typed compat client: a model delegate per Prisma model name, plus the
 * client-level `$transaction` / raw surface. Parameterize `S` with your
 * generated entity types for full autocompletion.
 */
export type PrismaCompatClient<S extends Record<string, PrismaModelTypes> = Record<string, PrismaModelTypes>> = {
  [K in keyof S]: PrismaModelDelegate<S[K]>;
} & {
  // Prisma's generated client exposes each model with its first letter
  // lowercased (`prisma.user` for `model User`); mirror that so migrated call
  // sites keep working unchanged. Both spellings resolve to the same delegate.
  [K in keyof S as Uncapitalize<K & string>]: PrismaModelDelegate<S[K]>;
} & PrismaCompatClientBase<S>;

/**
 * Prisma's client-property spelling of a model name: first letter lowercased
 * (`model User` -> `prisma.user`). Returns null when the spelling is identical
 * (already lowercase) so callers can skip the alias.
 */
function prismaPropertyAlias(model: string): string | null {
  const alias = model.charAt(0).toLowerCase() + model.slice(1);
  return alias === model ? null : alias;
}

// ---------------------------------------------------------------------------
// Delegate construction
// ---------------------------------------------------------------------------

/**
 * Build one model delegate over a query-interface accessor. `getQI` returns the
 * QueryInterface for this model's table on the active connection (the base pool,
 * or a transaction's connection inside `$transaction(callback)`).
 */
// ---------------------------------------------------------------------------
// Prisma client-side defaults (@default(uuid()/cuid()) / @updatedAt / now())
// ---------------------------------------------------------------------------

let cuidCounter = Math.floor(Math.random() * 1296);

/**
 * A cuid-shaped id ('c' + timestamp + counter + fingerprint + random, 25
 * chars): collision-resistant and format-compatible with Prisma's
 * `@default(cuid())` call sites. Not byte-identical to any specific cuid
 * library; Prisma treats these as opaque unique strings.
 */
function makeCuid(): string {
  const ts = Date.now().toString(36);
  const count = (cuidCounter++ % 1296).toString(36).padStart(2, '0');
  const rand = (): string =>
    Math.floor(Math.random() * 36 ** 4)
      .toString(36)
      .padStart(4, '0');
  return `c${ts}${count}${rand()}${rand()}${rand()}`.slice(0, 25);
}

function clientDefaultValue(kind: 'uuid' | 'cuid' | 'now' | 'updatedAt'): unknown {
  if (kind === 'uuid') return globalThis.crypto.randomUUID();
  if (kind === 'cuid') return makeCuid();
  return new Date();
}

/** Fill missing create-side client defaults (uuid / cuid / now / updatedAt), by Prisma field name. */
function applyCreateDefaults(mm: PrismaModelMap, data: unknown): unknown {
  const cd = mm.clientDefaults;
  if (!cd || !isPlainObject(data)) return data;
  let out = data;
  for (const [field, kind] of Object.entries(cd)) {
    if (out[field] === undefined) {
      if (out === data) out = { ...data };
      out[field] = clientDefaultValue(kind);
    }
  }
  return out;
}

/** Touch @updatedAt fields on the update side (Prisma sets them on every update). */
function applyUpdateTouch(mm: PrismaModelMap, data: unknown): unknown {
  const cd = mm.clientDefaults;
  if (!cd || !isPlainObject(data)) return data;
  let out = data;
  for (const [field, kind] of Object.entries(cd)) {
    if (kind === 'updatedAt' && out[field] === undefined) {
      if (out === data) out = { ...data };
      out[field] = new Date();
    }
  }
  return out;
}

/** Whether TRANSLATED write data carries relation keys (nested-write shapes). */
function hasNestedKeys(ctx: Ctx, mm: PrismaModelMap, data: unknown): boolean {
  const rels = ctx.schema.tables[mm.table]?.relations;
  if (!rels || !isPlainObject(data)) return false;
  return Object.keys(data).some((k) => {
    if (!Object.hasOwn(rels, k)) return false;
    const v = data[k];
    return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
  });
}

/**
 * Whether an upsert's translated `where` key values all equal the
 * corresponding `create` values. When they do (the common Prisma idiom), the
 * native single-statement ON CONFLICT upsert is semantically identical to
 * Prisma's lookup-first and stays atomic. When they differ, native upsert
 * would insert the `create` row even though the `where` row exists, so the
 * adapter must emulate lookup-first instead.
 */
function upsertKeysMatch(t: Args): boolean {
  const where = t.where;
  const create = t.create;
  if (!isPlainObject(where) || !isPlainObject(create)) return false;
  const scalarEq = (a: unknown, b: unknown): boolean => {
    if (a instanceof Date || b instanceof Date) {
      return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
    }
    return a === b;
  };
  for (const [k, v] of Object.entries(where)) {
    if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
      // Compound-unique selector object: every member must scalar-match create.
      if (Array.isArray(v)) return false;
      for (const [mk, mv] of Object.entries(v as Record<string, unknown>)) {
        if (mv !== null && typeof mv === 'object' && !(mv instanceof Date)) return false;
        if (!scalarEq(mv, (create as Record<string, unknown>)[mk])) return false;
      }
      continue;
    }
    if (!scalarEq(v, (create as Record<string, unknown>)[k])) return false;
  }
  return true;
}

/** Prisma upsert semantics: look up by where; update the found row, else insert create. */
async function upsertLookupFirst(qi: CompatQueryInterface, t: Args): Promise<unknown> {
  const existing = await qi.findUnique({ where: t.where });
  if (existing) return qi.update({ where: t.where, data: t.update });
  return qi.create({ data: t.create });
}

/** Runs `fn` atomically with a tx-bound table lookup (opens a tx, or reuses the ambient one). */
type RunInTx = <T>(fn: (table: (name: string) => CompatQueryInterface) => Promise<T>) => Promise<T>;

function makeDelegate(
  ctx: Ctx,
  mm: PrismaModelMap,
  getQI: () => CompatQueryInterface,
  runInTx: RunInTx,
): PrismaModelDelegate<PrismaModelTypes> {
  const pe = ctx.options.prismaErrorCodes;
  // Build a lazy Prisma-style promise for one delegate call. Crucially, the
  // Prisma-arg `translate` step runs INSIDE the deferred paths (the run closure
  // and the batchable build closure), never eagerly at call time: a
  // translation/validation error (unknown relation in `include`, unknown
  // compound selector, negative take, ...) must surface as a REJECTED promise
  // so a Prisma-shaped `.catch()` fires, not as a synchronous throw. The
  // async run wrapper also converts any synchronous throw from the underlying
  // `qi.*` build into a rejection; the array `$transaction([...])` batch path
  // catches the same throw from `batch.build`.
  const defer = <T>(
    translate: () => Args,
    run: (qi: CompatQueryInterface, t: Args) => Promise<T>,
    batch?: {
      build: (qi: CompatQueryInterface, t: Args) => DeferredQuery<unknown>;
      reshape: (raw: unknown) => unknown;
      /** True when this call cannot run as one deferred statement (see Batchable.nested). */
      nested?: (t: Args) => boolean;
      /** Sequential-in-tx override used by the batch fallback (defaults to `run` on the tx table). */
      execInTx?: (table: (name: string) => CompatQueryInterface, t: Args) => Promise<unknown>;
    },
  ): CompatPromise<T> => {
    const batchable: Batchable | undefined = batch
      ? {
          build: () => batch.build(getQI(), translate()),
          reshape: batch.reshape,
          nested: () => {
            try {
              return batch.nested?.(translate()) ?? false;
            } catch {
              return false; // let the build path surface the translation error consistently
            }
          },
          execInTx: async (table) => {
            try {
              const t = translate();
              return batch.execInTx ? await batch.execInTx(table, t) : await run(table(mm.table), t);
            } catch (err) {
              throw decorate(err, pe);
            }
          },
        }
      : undefined;
    return new CompatPromise<T>(async () => {
      try {
        return await run(getQI(), translate());
      } catch (err) {
        throw decorate(err, pe);
      }
    }, batchable);
  };

  const requireWhere = (args: Args | undefined, op: string): Args => {
    if (!args || args.where === undefined) {
      throw new ValidationError(`[turbine] prisma-compat: ${op} on "${modelName(ctx, mm)}" requires a \`where\`.`);
    }
    return args;
  };

  return {
    findMany: (args = {}) =>
      defer(
        () => translateReadArgs(ctx, mm, args),
        (qi, t) => qi.findMany(t).then((r) => reshapeRows(ctx, mm, r)),
        { build: (qi, t) => qi.buildFindMany(t), reshape: (raw) => reshapeRows(ctx, mm, raw) },
      ) as unknown as Promise<PrismaModelTypes['Row'][]>,
    findFirst: (args = {}) =>
      defer(
        () => translateReadArgs(ctx, mm, args),
        (qi, t) => qi.findFirst(t).then((r) => reshapeRowOrNull(ctx, mm, r)),
        { build: (qi, t) => qi.buildFindFirst(t), reshape: (raw) => reshapeRowOrNull(ctx, mm, raw) },
      ) as unknown as Promise<PrismaModelTypes['Row'] | null>,
    findUnique: (args) =>
      defer(
        () => translateReadArgs(ctx, mm, requireWhere(args, 'findUnique')),
        (qi, t) => qi.findUnique(t).then((r) => reshapeRowOrNull(ctx, mm, r)),
        { build: (qi, t) => qi.buildFindUnique(t), reshape: (raw) => reshapeRowOrNull(ctx, mm, raw) },
      ) as unknown as Promise<PrismaModelTypes['Row'] | null>,
    findFirstOrThrow: (args = {}) =>
      defer(
        () => translateReadArgs(ctx, mm, args),
        (qi, t) => qi.findFirstOrThrow(t).then((r) => reshapeRow(ctx, mm, r)),
        { build: (qi, t) => qi.buildFindFirstOrThrow(t), reshape: (raw) => reshapeRow(ctx, mm, raw) },
      ) as unknown as Promise<PrismaModelTypes['Row']>,
    findUniqueOrThrow: (args) =>
      defer(
        () => translateReadArgs(ctx, mm, requireWhere(args, 'findUniqueOrThrow')),
        (qi, t) => qi.findUniqueOrThrow(t).then((r) => reshapeRow(ctx, mm, r)),
        { build: (qi, t) => qi.buildFindUniqueOrThrow(t), reshape: (raw) => reshapeRow(ctx, mm, raw) },
      ) as unknown as Promise<PrismaModelTypes['Row']>,
    create: (args) =>
      defer(
        () => {
          const t: Args = { data: translateWriteData(ctx, mm, applyCreateDefaults(mm, (args as Args).data)) };
          if (typeof (args as Args).timeout === 'number') t.timeout = (args as Args).timeout;
          return t;
        },
        (qi, t) => qi.create(t).then((r) => reshapeRow(ctx, mm, r)),
        {
          build: (qi, t) => qi.buildCreate(t),
          reshape: (raw) => reshapeRow(ctx, mm, raw),
          nested: (t) => hasNestedKeys(ctx, mm, t.data),
        },
      ) as unknown as Promise<PrismaModelTypes['Row']>,
    createMany: (args) =>
      defer(
        () => {
          const data = (args as Args).data;
          const rows = Array.isArray(data)
            ? data.map((d) => translateWriteData(ctx, mm, applyCreateDefaults(mm, d)))
            : [];
          const t: Args = { data: rows };
          if ((args as Args).skipDuplicates) t.skipDuplicates = true;
          return t;
        },
        (qi, t) => qi.createMany(t).then((r) => ({ count: (r as unknown[]).length })),
        { build: (qi, t) => qi.buildCreateMany(t), reshape: (raw) => ({ count: (raw as unknown[]).length }) },
      ) as unknown as Promise<{ count: number }>,
    update: (args) =>
      defer(
        () => {
          const a = requireWhere(args, 'update');
          return {
            where: translateWhere(ctx, mm, a.where),
            data: translateWriteData(ctx, mm, applyUpdateTouch(mm, a.data)),
          } as Args;
        },
        (qi, t) => qi.update(t).then((r) => reshapeRow(ctx, mm, r)),
        {
          build: (qi, t) => qi.buildUpdate(t),
          reshape: (raw) => reshapeRow(ctx, mm, raw),
          nested: (t) => hasNestedKeys(ctx, mm, t.data),
        },
      ) as unknown as Promise<PrismaModelTypes['Row']>,
    updateMany: (args) =>
      defer(
        () => {
          const a = args as Args;
          const t: Args = {
            where: translateWhere(ctx, mm, a.where ?? {}),
            data: translateWriteData(ctx, mm, applyUpdateTouch(mm, a.data)),
          };
          if (a.where === undefined) t.allowFullTableScan = true;
          return t;
        },
        (qi, t) => qi.updateMany(t),
        { build: (qi, t) => qi.buildUpdateMany(t), reshape: (raw) => raw },
      ) as unknown as Promise<{ count: number }>,
    delete: (args) =>
      defer(
        () => {
          const a = requireWhere(args, 'delete');
          return { where: translateWhere(ctx, mm, a.where) } as Args;
        },
        (qi, t) => qi.delete(t).then((r) => reshapeRow(ctx, mm, r)),
        { build: (qi, t) => qi.buildDelete(t), reshape: (raw) => reshapeRow(ctx, mm, raw) },
      ) as unknown as Promise<PrismaModelTypes['Row']>,
    deleteMany: (args = {}) =>
      defer(
        () => {
          const a = args as Args;
          const t: Args = { where: translateWhere(ctx, mm, a.where ?? {}) };
          if (a.where === undefined) t.allowFullTableScan = true;
          return t;
        },
        (qi, t) => qi.deleteMany(t),
        { build: (qi, t) => qi.buildDeleteMany(t), reshape: (raw) => raw },
      ) as unknown as Promise<{ count: number }>,
    upsert: (args) =>
      defer(
        () => {
          const a = requireWhere(args, 'upsert');
          return {
            where: translateWhere(ctx, mm, a.where),
            create: translateWriteData(ctx, mm, applyCreateDefaults(mm, a.create)),
            update: translateWriteData(ctx, mm, applyUpdateTouch(mm, a.update)),
          } as Args;
        },
        (qi, t) => {
          // Native ON CONFLICT upsert is only Prisma-equivalent when the where
          // key values equal the create values AND no nested write data is
          // present; otherwise emulate Prisma's lookup-first atomically.
          if (upsertKeysMatch(t) && !hasNestedKeys(ctx, mm, t.create) && !hasNestedKeys(ctx, mm, t.update)) {
            return qi.upsert(t).then((r) => reshapeRow(ctx, mm, r));
          }
          return runInTx(async (table) => {
            const row = await upsertLookupFirst(table(mm.table), t);
            return reshapeRow(ctx, mm, row);
          });
        },
        {
          build: (qi, t) => qi.buildUpsert(t),
          reshape: (raw) => reshapeRow(ctx, mm, raw),
          nested: (t) => !upsertKeysMatch(t) || hasNestedKeys(ctx, mm, t.create) || hasNestedKeys(ctx, mm, t.update),
          execInTx: async (table, t) => {
            if (upsertKeysMatch(t) && !hasNestedKeys(ctx, mm, t.create) && !hasNestedKeys(ctx, mm, t.update)) {
              return reshapeRow(ctx, mm, await table(mm.table).upsert(t));
            }
            return reshapeRow(ctx, mm, await upsertLookupFirst(table(mm.table), t));
          },
        },
      ) as unknown as Promise<PrismaModelTypes['Row']>,
    count: (args = {}) =>
      defer(
        () => {
          const t: Args = {};
          if ((args as Args).where !== undefined) t.where = translateWhere(ctx, mm, (args as Args).where);
          if (typeof (args as Args).timeout === 'number') t.timeout = (args as Args).timeout;
          return t;
        },
        (qi, t) => qi.count(t),
        { build: (qi, t) => qi.buildCount(t), reshape: (raw) => raw },
      ) as unknown as Promise<number>,
    aggregate: (args) =>
      defer(
        () => translateAggregateArgs(ctx, mm, args as Args, false),
        (qi, t) => qi.aggregate(t).then((r) => reshapeAggregate(ctx, mm, r)),
        { build: (qi, t) => qi.buildAggregate(t), reshape: (raw) => reshapeAggregate(ctx, mm, raw) },
      ) as unknown as Promise<Record<string, unknown>>,
    groupBy: (args) =>
      defer(
        () => translateAggregateArgs(ctx, mm, args as Args, true),
        (qi, t) => qi.groupBy(t).then((rows) => (rows as unknown[]).map((r) => reshapeGroupRow(ctx, mm, r))),
        {
          build: (qi, t) => qi.buildGroupBy(t),
          reshape: (raw) => (raw as unknown[]).map((r) => reshapeGroupRow(ctx, mm, r)),
        },
      ) as unknown as Promise<Record<string, unknown>[]>,
  };
}

// ---------------------------------------------------------------------------
// Raw SQL
// ---------------------------------------------------------------------------

interface PgLikePool {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

interface DialectLike {
  paramPlaceholder(n: number): string;
}

function poolOf(db: CompatTurbineClient): PgLikePool {
  const pool = (db as unknown as { pool?: PgLikePool }).pool;
  if (!pool) throw new ValidationError('[turbine] prisma-compat: raw SQL needs a TurbineClient with an active pool.');
  return pool;
}

function placeholderOf(db: CompatTurbineClient): (n: number) => string {
  const dialect = (db as unknown as { dialect?: DialectLike }).dialect;
  return dialect ? (n) => dialect.paramPlaceholder(n) : (n) => `$${n}`;
}

/**
 * Flatten a Prisma-style tagged template, including nested {@link Sql}
 * fragments, into a single `{ text, params }` pair. Values only ever become
 * bound `$N` params (never string-concatenated), so composition is
 * injection-safe. `Prisma.raw(...)` fragments are the sole verbatim splice, by
 * contract.
 */
function flattenTemplate(
  strings: readonly string[],
  values: readonly unknown[],
  ph: (n: number) => string,
): { text: string; params: unknown[] } {
  const params: unknown[] = [];
  let text = '';
  const append = (segStrings: readonly string[], segValues: readonly unknown[]): void => {
    for (let i = 0; i < segStrings.length; i++) {
      text += segStrings[i];
      if (i < segValues.length) {
        const v = segValues[i];
        if (isSqlFragment(v)) {
          append(v.strings, v.values);
        } else {
          params.push(v);
          text += ph(params.length);
        }
      }
    }
  };
  append(strings, values);
  return { text, params };
}

// ---------------------------------------------------------------------------
// createPrismaCompatClient
// ---------------------------------------------------------------------------

/**
 * Create a PrismaClient-surface adapter over a {@link TurbineClient}, driven by a
 * {@link PrismaCompatMap} (the `prisma-map.ts` that `turbine
 * migrate-from-prisma` emits).
 *
 * The returned object exposes a delegate per Prisma model name (by the map's
 * keys) plus the client-level `$transaction` / `$queryRaw` / `$executeRaw`
 * surface. Model and field names are translated through the map in both
 * directions; when field names are identity (the `--keep-column-names` pairing)
 * result rekeying is skipped entirely.
 *
 * @typeParam S - Per-model type bundles (from your generated entity types) for
 *   full autocompletion. Defaults to a permissive shape.
 * @param client - The TurbineClient (or generated subclass / `turbineHttp` client).
 * @param map - The resolved `PRISMA_MAP`.
 * @param options - {@link PrismaCompatOptions}.
 */
export function createPrismaCompatClient<S extends Record<string, PrismaModelTypes> = Record<string, PrismaModelTypes>>(
  client: TurbineClient,
  map: PrismaCompatMap,
  options: PrismaCompatOptions = {},
): PrismaCompatClient<S> {
  // The adapter only ever needs the narrow {@link CompatTurbineClient} surface;
  // the real client satisfies it structurally (the cast just relaxes the strict
  // callback-param variance on `$transaction`).
  const db = client as unknown as CompatTurbineClient;

  const tableToModel = new Map<string, string>();
  for (const [prismaModel, mm] of Object.entries(map.models)) tableToModel.set(mm.table, prismaModel);

  const ctx: Ctx = {
    map,
    schema: db.schema,
    tableToModel,
    lookups: new Map(),
    options: {
      stablePkOrder: options.stablePkOrder ?? false,
      prismaErrorCodes: options.prismaErrorCodes ?? false,
    },
  };

  // Delegates bound to the base client (each call reads db.table(...) lazily).
  const delegates = new Map<string, PrismaModelDelegate<PrismaModelTypes>>();
  for (const [prismaModel, mm] of Object.entries(map.models)) {
    delegates.set(
      prismaModel,
      makeDelegate(
        ctx,
        mm,
        () => db.table(mm.table),
        (fn) => db.$transaction((tx) => fn((n) => tx.table(n))),
      ),
    );
  }

  const ph = placeholderOf(db);

  const runRaw = async (text: string, params: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }> => {
    try {
      return await poolOf(db).query(text, params);
    } catch (err) {
      throw decorate(wrapPgError(err), ctx.options.prismaErrorCodes);
    }
  };

  const base: PrismaCompatClientBase = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    $transaction: ((arg: unknown, txOptions?: PrismaCompatTxOptions): Promise<unknown> => {
      // Array (lazy batch) form. Wrapped so validation/build errors REJECT the
      // returned promise (Prisma's $transaction is always thenable) rather than
      // throwing synchronously.
      if (Array.isArray(arg)) {
        return (async () => {
          try {
            const batchables = arg.map((p, i) => {
              const b = batchableOf(p);
              if (!b) {
                throw new ValidationError(
                  `[turbine] prisma-compat: $transaction([...]) item ${i} is not a lazy model call. Pass un-awaited delegate calls (e.g. prisma.User.create(...)).`,
                );
              }
              return b;
            });
            // Nested write data (or a lookup-first upsert) cannot run as a
            // single deferred statement. Prisma's array form still supports
            // those, so fall back to running the WHOLE array sequentially
            // inside one transaction; ordering and atomicity are preserved.
            if (batchables.some((b) => b.nested())) {
              return await db.$transaction(async (tx) => {
                const out: unknown[] = [];
                for (const b of batchables) out.push(await b.execInTx((n) => tx.table(n)));
                return out;
              }, txOptions);
            }
            const deferreds = batchables.map((b) => b.build());
            const results = (await db.$transaction(deferreds)) as unknown[];
            return results.map((raw, i) => batchables[i]!.reshape(raw));
          } catch (err) {
            throw decorate(err, ctx.options.prismaErrorCodes);
          }
        })();
      }
      // Callback form: hand the user a compat client bound to the tx connection.
      const fn = arg as (tx: PrismaCompatTransactionClient) => Promise<unknown>;
      return db.$transaction((tx: CompatTransactionClient) => {
        const txDelegates: Record<string, PrismaModelDelegate<PrismaModelTypes>> = {};
        for (const [prismaModel, mm] of Object.entries(map.models)) {
          txDelegates[prismaModel] = makeDelegate(
            ctx,
            mm,
            () => tx.table(mm.table),
            (fn) => fn((n) => tx.table(n)),
          );
          const alias = prismaPropertyAlias(prismaModel);
          if (alias && !(alias in map.models) && !(alias in txDelegates)) {
            txDelegates[alias] = txDelegates[prismaModel]!;
          }
        }
        return fn(txDelegates as unknown as PrismaCompatTransactionClient);
      }, txOptions);
    }) as PrismaCompatClientBase['$transaction'],

    $queryRaw: async <T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]> => {
      const { text, params } = flattenTemplate(strings as unknown as string[], values, ph);
      return (await runRaw(text, params)).rows as T[];
    },
    $queryRawUnsafe: async <T = unknown>(sql: string, ...params: unknown[]): Promise<T[]> => {
      return (await runRaw(sql, params)).rows as T[];
    },
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]): Promise<number> => {
      const { text, params } = flattenTemplate(strings as unknown as string[], values, ph);
      return (await runRaw(text, params)).rowCount ?? 0;
    },
    $executeRawUnsafe: async (sql: string, ...params: unknown[]): Promise<number> => {
      return (await runRaw(sql, params)).rowCount ?? 0;
    },
    $connect: async () => {},
    $disconnect: async () => {},
  };

  // Assemble the result: model delegates keyed by Prisma model name, plus the
  // client-level base methods. A plain object suffices, every model is a known
  // key from the map, so no dynamic-access proxy is needed.
  const result: Record<string, unknown> = { ...base };
  for (const [prismaModel, delegate] of delegates) result[prismaModel] = delegate;
  // Prisma-spelling aliases (`prisma.user` for `model User`). Skipped when the
  // lowercased name is itself a model or already taken (never shadow a real key).
  for (const [prismaModel, delegate] of delegates) {
    const alias = prismaPropertyAlias(prismaModel);
    if (alias && !(alias in result)) result[alias] = delegate;
  }

  return result as unknown as PrismaCompatClient<S>;
}
