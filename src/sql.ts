/** Optional, execution-free SQL composition. Import from `turbine-orm/sql`. */
declare const fragmentBrand: unique symbol;

/** Opaque SQL structure. Only this module's factories create genuine fragments. */
export interface SqlFragment {
  readonly [fragmentBrand]: true;
}

/** The two existing dialect hooks used by the compiler. */
export interface SqlDialect {
  paramPlaceholder(index: number): string;
  quoteIdentifier(name: string): string;
}

/** Fresh output for a driver's query(text, params) or db.rawUnsafe(text, ...params). */
export interface CompiledSql {
  sql: string;
  params: unknown[];
}

type Part =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'value'; readonly value: unknown }
  | {
      readonly kind: 'identifier';
      readonly names: readonly string[];
      readonly owner?: object;
      readonly cte?: object;
      readonly physical?: boolean;
    }
  | {
      readonly kind: 'fragment';
      readonly parts: readonly Part[];
      readonly closed?: boolean;
      readonly visible?: readonly object[];
      readonly reserved?: readonly string[];
    };

// Identity, not object shape, is the trust boundary. JSON, object spread and
// copied symbols/prototypes cannot manufacture entries in this private map.
const fragments = new WeakMap<SqlFragment, readonly Part[]>();

function create(parts: readonly Part[]): SqlFragment {
  const fragment = Object.freeze(Object.create(null)) as SqlFragment;
  fragments.set(fragment, parts);
  return fragment;
}

function partsOf(value: unknown): readonly Part[] | undefined {
  return typeof value === 'object' && value !== null ? fragments.get(value as SqlFragment) : undefined;
}

function interpolation(value: unknown): Part {
  const parts = partsOf(value);
  return parts ? { kind: 'fragment', parts } : { kind: 'value', value };
}

/**
 * Build reusable SQL from a tagged template. Ordinary interpolations are always
 * bound values; only genuine fragments (including identifiers/joins) expand.
 * Structure is immutable. Parameter objects retain their identity and are not
 * cloned, frozen, serialized or converted by this module.
 */
export function sql(strings: TemplateStringsArray, ...values: unknown[]): SqlFragment {
  // Kept local so this optional leaf does not load typed-sql's execution graph.
  if (
    !Array.isArray(strings) ||
    !Object.isFrozen(strings) ||
    !Array.isArray(strings.raw) ||
    !Object.isFrozen(strings.raw) ||
    strings.raw.length !== strings.length ||
    strings.length !== values.length + 1
  ) {
    throw new TypeError('sql must be called as a tagged template with one more segment than values.');
  }
  const parts: Part[] = [];
  for (let i = 0; i < strings.length; i++) {
    const text = strings[i];
    if (typeof text !== 'string' || typeof strings.raw[i] !== 'string') {
      throw new TypeError('sql template segments must be strings; check for invalid escape sequences.');
    }
    parts.push({ kind: 'text', text });
    if (i < values.length) parts.push(interpolation(values[i]));
  }
  return create(parts);
}

/**
 * Quote each identifier component with the compilation dialect. Dots inside a
 * component are literal: identifier('app', 'users') is a qualified name.
 * This quotes names; callers still decide which names a user may access.
 */
export function identifier(...names: string[]): SqlFragment {
  return quoted(names);
}

function quoted(names: string[], physical?: boolean): SqlFragment {
  if (
    names.length === 0 ||
    names.some((name) => typeof name !== 'string' || name.length === 0 || name.includes('\u0000'))
  ) {
    throw new TypeError('identifier requires one or more non-empty strings without NUL characters.');
  }
  return create([{ kind: 'identifier', names: names.slice(), physical }]);
}

const comma = create([{ kind: 'text', text: ', ' }]);

/**
 * Join values/fragments with a genuine fragment separator (default: comma and
 * space). Empty input emits no SQL or parameters. Supply IN-list parentheses
 * and choose an explicit predicate for empty lists in the calling code.
 */
export function join(values: readonly unknown[], separator: SqlFragment = comma): SqlFragment {
  if (!Array.isArray(values)) throw new TypeError('join requires an array of values or fragments.');
  const separatorParts = partsOf(separator);
  if (!separatorParts) throw new TypeError('join separator must be a genuine SQL fragment.');
  const parts: Part[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i > 0) parts.push({ kind: 'fragment', parts: separatorParts });
    parts.push(interpolation(values[i]));
  }
  return create(parts);
}

/**
 * Compile without executing or inferring result types. Number placeholders in
 * final traversal order, including repeated fragments and separators. Static
 * SQL is never scanned or rewritten, so literal '$1' text stays untouched.
 */
export function compile(fragment: SqlFragment, dialect: SqlDialect): CompiledSql {
  const parts = partsOf(fragment);
  if (!parts) throw new TypeError('compile requires a genuine SQL fragment.');
  if (!dialect || typeof dialect.paramPlaceholder !== 'function' || typeof dialect.quoteIdentifier !== 'function') {
    throw new TypeError('compile requires a SQL dialect with paramPlaceholder and quoteIdentifier methods.');
  }
  const text: string[] = [];
  const params: unknown[] = [];
  // Iterative traversal also permits deeply nested reusable fragments without
  // depending on the JavaScript call-stack limit. No fragment stores offsets.
  const stack = [{ parts, index: 0, visible: [] as readonly object[], reserved: [] as readonly string[] }];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if (frame.index === frame.parts.length) {
      stack.pop();
      continue;
    }
    const part = frame.parts[frame.index++]!;
    switch (part.kind) {
      case 'text':
        text.push(part.text);
        break;
      case 'value':
        params.push(part.value);
        text.push(dialect.paramPlaceholder(params.length));
        break;
      case 'identifier':
        if (part.physical && part.names.length === 1 && frame.reserved.includes(part.names[0]!.toLowerCase())) {
          throw new TypeError('SQL CTE name captures an unqualified physical table; qualify its schema.');
        }
        if (part.cte && !frame.visible.includes(part.cte)) {
          throw new TypeError('Unresolved SQL CTE reference (omitted, forward or recursive definition).');
        }
        text.push(part.names.map((name) => dialect.quoteIdentifier(name)).join('.'));
        break;
      case 'fragment':
        stack.push({
          parts: part.parts,
          index: 0,
          visible: part.visible ?? frame.visible,
          reserved: part.reserved ? [...frame.reserved, ...part.reserved] : frame.reserved,
        });
        break;
    }
  }
  return { sql: text.join(''), params };
}

// These brands carry declarations only; private maps authenticate runtime tokens.
declare const columnBrand: unique symbol;
declare const tableBrand: unique symbol;
declare const resultBrand: unique symbol;

/** A caller-declared column value and its explicit table alias. No decoding. */
export interface SqlColumn<Value, Alias extends string> extends SqlFragment {
  readonly [columnBrand]: { readonly value: Value; readonly alias: Alias };
}

export interface SqlTable<Row, Alias extends string> {
  readonly [tableBrand]: { readonly row: Row; readonly alias: Alias };
  column<Key extends keyof Row & string>(name: Key): SqlColumn<Row[Key], Alias>;
}

/** A closed SELECT fragment. The result brand is compile-time information only. */
export interface SqlSelection<Row> extends SqlFragment {
  readonly [resultBrand]: Row;
}

export type SqlResult<Query extends SqlSelection<unknown>> = Query[typeof resultBrand];

type Selected<Fields, Nullable extends string> = {
  -readonly [Key in keyof Fields]: NonNullable<Fields[Key]> extends SqlColumn<infer Value, infer Alias>
    ? Value | (Extract<Alias, Nullable> extends never ? never : null)
    : never;
};

declare const nullableScopeBrand: unique symbol;

/** An explicit sort key using a genuine column from the current query scope. */
export interface SqlOrder<Scope extends string> {
  readonly column: SqlColumn<unknown, Scope>;
  readonly direction: 'asc' | 'desc';
}

export interface SqlSelect<Scope extends string, Nullable extends string = never> {
  readonly [nullableScopeBrand]: Nullable;
  innerJoin<Row, Alias extends string>(
    table: Extract<Alias, Scope> extends never ? SqlTable<Row, Alias> : never,
    on: SqlFragment,
  ): SqlSelect<Scope | Alias, Nullable>;
  leftJoin<Row, Alias extends string>(
    table: Extract<Alias, Scope> extends never ? SqlTable<Row, Alias> : never,
    on: SqlFragment,
  ): SqlSelect<Scope | Alias, Nullable | Alias>;
  where(predicate: SqlFragment): SqlSelect<Scope, Nullable>;
  /** Append keys in call order; ties have no implicit ordering guarantee. */
  orderBy(...keys: readonly [SqlOrder<Scope>, ...SqlOrder<Scope>[]]): SqlSelect<Scope, Nullable>;
  select<Fields extends Record<string, SqlColumn<unknown, Scope>>>(
    fields: Fields,
  ): SqlSelection<Selected<Fields, Nullable>>;
}

const tables = new WeakMap<object, { alias: string; source: SqlFragment }>();
const columns = new WeakSet<object>();

// Portable bounded aliases avoid engine truncation and case-folding collisions.
function aliasName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(name)) {
    throw new TypeError('SQL aliases must be ASCII identifiers of 1..63 characters.');
  }
}

/** Declare physical SQL names and driver value types; this does not inspect a schema. */
export function table<Row>() {
  return <const Alias extends string>(
    name: string | readonly string[],
    alias: string extends Alias ? never : Alias,
  ): SqlTable<Row, Alias> => {
    aliasName(alias);
    const source = quoted(typeof name === 'string' ? [name] : [...name], true);
    return tableReference(source, alias) as SqlTable<Row, Alias>;
  };
}

function tableReference(source: SqlFragment, alias: string, names?: readonly string[]): object {
  aliasName(alias);
  const token = Object.freeze({
    column(key: string) {
      identifier(key);
      if (names && !names.includes(key)) throw new TypeError('Unknown SQL CTE projection column.');
      const column = create([{ kind: 'identifier', names: [alias, key], owner: token }]);
      columns.add(column);
      return column;
    },
  });
  tables.set(token, { alias, source: sql`${source} AS ${identifier(alias)}` });
  return token;
}

function tableInfo(token: object) {
  const info = token && tables.get(token);
  if (!info) throw new TypeError('Expected a genuine SQL table reference.');
  return info;
}

function assertScope(fragment: SqlFragment, scope: readonly object[]): void {
  const parts = partsOf(fragment);
  if (!parts) throw new TypeError('Expected a genuine SQL fragment for a query clause.');
  const pending = [parts];
  while (pending.length) {
    for (const part of pending.pop()!) {
      if (part.kind === 'identifier' && part.owner && !scope.includes(part.owner)) {
        throw new TypeError('SQL column reference is outside the declared query scope.');
      }
      if (part.kind === 'fragment' && !part.closed) pending.push(part.parts);
    }
  }
}

function selectBuilder(
  scope: readonly object[],
  body: SqlFragment,
  predicates: readonly SqlFragment[],
  ordering: readonly SqlFragment[],
): unknown {
  const addJoin = (target: object, on: SqlFragment, kind: SqlFragment) => {
    const info = tableInfo(target);
    if (scope.some((token) => tableInfo(token).alias.toLowerCase() === info.alias.toLowerCase())) {
      throw new TypeError('Duplicate SQL table alias in query scope.');
    }
    const next = [...scope, target];
    assertScope(on, next);
    return selectBuilder(next, sql`${body}${kind}${info.source} ON (${on})`, predicates, ordering);
  };
  return Object.freeze({
    innerJoin: (target: object, on: SqlFragment) => addJoin(target, on, sql` INNER JOIN `),
    leftJoin: (target: object, on: SqlFragment) => addJoin(target, on, sql` LEFT JOIN `),
    where(predicate: SqlFragment) {
      assertScope(predicate, scope);
      return selectBuilder(scope, body, [...predicates, sql`(${predicate})`], ordering);
    },
    orderBy(...keys: SqlOrder<string>[]) {
      if (!keys.length) throw new TypeError('SQL ordering requires at least one column and direction.');
      const added = keys.map((key) => {
        const column = key && Object.getOwnPropertyDescriptor(key, 'column')?.value;
        const direction = key && Object.getOwnPropertyDescriptor(key, 'direction')?.value;
        if (!columns.has(column)) throw new TypeError('SQL ordering requires genuine column references.');
        assertScope(column, scope);
        if (direction !== 'asc' && direction !== 'desc') {
          throw new TypeError('SQL ordering direction must be asc or desc.');
        }
        return sql`${column}${direction === 'asc' ? sql` ASC` : sql` DESC`}`;
      });
      return selectBuilder(scope, body, predicates, [...ordering, ...added]);
    },
    select(fields: Record<string, SqlFragment>) {
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
        throw new TypeError('SQL selection requires a nonempty named column map.');
      }
      const names = Reflect.ownKeys(fields);
      if (!names.length) throw new TypeError('SQL selection requires a nonempty named column map.');
      const seen = new Set<string>();
      const projection = names.map((name) => {
        aliasName(name);
        if (seen.has(name.toLowerCase())) throw new TypeError('Duplicate SQL selected field alias.');
        seen.add(name.toLowerCase());
        const column = Object.getOwnPropertyDescriptor(fields, name)?.value;
        if (!columns.has(column)) throw new TypeError('SQL selection requires genuine column references.');
        assertScope(column, scope);
        return sql`${column} AS ${identifier(name)}`;
      });
      const filter = predicates.length ? sql` WHERE ${join(predicates, sql` AND `)}` : sql``;
      const order = ordering.length ? sql` ORDER BY ${join(ordering)}` : sql``;
      const query = sql`SELECT ${join(projection)} FROM ${body}${filter}${order}`;
      // A completed query owns its internal scope when reused in raw subqueries.
      return selection(query, names as string[]);
    },
  });
}

/** Start an immutable, execution-free SELECT with one explicitly aliased table. */
export function selectFrom<Row, Alias extends string>(from: SqlTable<Row, Alias>): SqlSelect<Alias> {
  return selectBuilder([from], tableInfo(from).source, [], []) as SqlSelect<Alias>;
}

const selections = new WeakMap<object, readonly string[]>();

function selection(query: SqlFragment, names: readonly string[]): SqlSelection<unknown> {
  const result = create([{ kind: 'fragment', parts: partsOf(query)!, closed: true }]) as SqlSelection<unknown>;
  selections.set(result, names);
  return result;
}

function selectionNames(query: object): readonly string[] {
  const names = query && selections.get(query);
  if (!names) throw new TypeError('Expected a genuine closed SQL selection.');
  return names;
}

declare const cteBrand: unique symbol;

/** An immutable nonrecursive definition; references have independent table identity. */
export interface SqlCte<Row> {
  readonly [cteBrand]: Row;
  ref<const Alias extends string>(alias: string extends Alias ? never : Alias): SqlTable<Row, Alias>;
}

const definitions = new WeakMap<object, { name: string; query: SqlFragment }>();
const withSelections = new WeakSet<object>();

export function cte<Row>(name: string, query: SqlSelection<Row>): SqlCte<Row> {
  aliasName(name);
  const names = selectionNames(query);
  const token = Object.freeze({
    ref(alias: string) {
      return tableReference(create([{ kind: 'identifier', names: [name], cte: token }]), alias, names);
    },
  }) as SqlCte<Row>;
  definitions.set(token, { name, query });
  return token;
}

/** Definitions are visible in list order. A nested WITH owns its entire CTE scope. */
export function withCtes<Row>(ctes: readonly SqlCte<unknown>[], body: SqlSelection<Row>): SqlSelection<Row> {
  const names = selectionNames(body);
  if (!Array.isArray(ctes) || !ctes.length) throw new TypeError('WITH requires a nonempty SQL CTE array.');
  const visible: object[] = [];
  const aliases = new Set<string>();
  const clauses = Array.from({ length: ctes.length }, (_, index) => {
    const token = ctes[index];
    const info = token && definitions.get(token);
    if (!info) throw new TypeError('Expected a genuine SQL CTE definition.');
    if (aliases.has(info.name.toLowerCase())) throw new TypeError('Duplicate SQL CTE name.');
    aliases.add(info.name.toLowerCase());
    const query = create([{ kind: 'fragment', parts: partsOf(info.query)!, visible: visible.slice() }]);
    visible.push(token);
    return sql`${identifier(info.name)} AS (${query})`;
  });
  const scoped = create([{ kind: 'fragment', parts: partsOf(body)!, visible }]);
  const nested = withSelections.has(body) ? sql`SELECT * FROM (${scoped}) AS ${identifier('_with')}` : scoped;
  const query = sql`WITH ${join(clauses)} ${nested}`;
  const result = selection(create([{ kind: 'fragment', parts: partsOf(query)!, reserved: [...aliases] }]), names);
  withSelections.add(result);
  return result as SqlSelection<Row>;
}

type Widen<Value> = Value extends string
  ? string
  : Value extends number
    ? number
    : Value extends bigint
      ? bigint
      : Value extends boolean
        ? boolean
        : Value;
type SetProblem<Left, Right> = string extends keyof Left | keyof Right
  ? true
  : Left extends Required<Left>
    ? Right extends Required<Right>
      ? [keyof Left] extends [keyof Right]
        ? [keyof Right] extends [keyof Left]
          ? {
              [Key in keyof Left]: Key extends keyof Right
                ? [NonNullable<Left[Key]>] extends [never]
                  ? never
                  : [NonNullable<Right[Key]>] extends [never]
                    ? never
                    : [Widen<NonNullable<Left[Key]>>] extends [Widen<NonNullable<Right[Key]>>]
                      ? [Widen<NonNullable<Right[Key]>>] extends [Widen<NonNullable<Left[Key]>>]
                        ? never
                        : true
                      : true
                : true;
            }[keyof Left]
          : true
        : true
      : true
    : true;
type SetChecked<Left, Right, Operator extends string = 'UNION'> = [SetProblem<Left, Right>] extends [never]
  ? unknown
  : {
      readonly __sqlSetError: `${Operator} requires matching required named fields and compatible declared value types`;
    };
type SetRow<Left, Right> = {
  -readonly [Key in keyof Left]: Left[Key] | (Key extends keyof Right ? Right[Key] : never);
};

function setSelection(left: object, right: object, operator: SqlFragment, name = 'UNION'): SqlSelection<unknown> {
  const names = selectionNames(left);
  const other = selectionNames(right);
  if (names.length !== other.length || names.some((name, index) => name !== other[index])) {
    throw new TypeError(`${name} requires identical ordered projection aliases and arity.`);
  }
  // Derived SELECTs preserve compound grouping and permit nested WITH on SQLite.
  return selection(
    sql`SELECT * FROM (${left}) AS ${identifier('_set')} ${operator} SELECT * FROM (${right}) AS ${identifier('_set')}`,
    names,
  );
}

export function union<Left, Right>(
  left: SqlSelection<Left>,
  right: SqlSelection<Right> & SetChecked<NoInfer<Left>, NoInfer<Right>>,
): SqlSelection<SetRow<Left, Right>> {
  return setSelection(left, right, sql`UNION`) as SqlSelection<SetRow<Left, Right>>;
}

export function unionAll<Left, Right>(
  left: SqlSelection<Left>,
  right: SqlSelection<Right> & SetChecked<NoInfer<Left>, NoInfer<Right>>,
): SqlSelection<SetRow<Left, Right>> {
  return setSelection(left, right, sql`UNION ALL`) as SqlSelection<SetRow<Left, Right>>;
}

/** Distinct rows present in both selections; function nesting fixes compound grouping. */
export function intersect<Left, Right>(
  left: SqlSelection<Left>,
  right: SqlSelection<Right> & SetChecked<NoInfer<Left>, NoInfer<Right>, 'INTERSECT'>,
): SqlSelection<SetRow<Left, Right>> {
  return setSelection(left, right, sql`INTERSECT`, 'INTERSECT') as SqlSelection<SetRow<Left, Right>>;
}

/** Distinct rows from the left selection absent from the right selection. */
export function except<Left, Right>(
  left: SqlSelection<Left>,
  right: SqlSelection<Right> & SetChecked<NoInfer<Left>, NoInfer<Right>, 'EXCEPT'>,
): SqlSelection<SetRow<Left, Right>> {
  return setSelection(left, right, sql`EXCEPT`, 'EXCEPT') as SqlSelection<SetRow<Left, Right>>;
}
