/**
 * turbine-orm: `sqlComment`, sqlcommenter-style key/values on each statement
 * Turbine builds, so `pg_stat_activity`, the server log, `auto_explain` and
 * database APM tools can attribute a statement to a service, a model, a feature
 * or a trace.
 *
 *   SELECT ... LIMIT $2 /*action='findMany',application='billing',model='users'*\/
 *
 * FORMAT (the sqlcommenter spec): keys sorted, each value URL-encoded with
 * `encodeURIComponent` and then `'` escaped as `\'`, each pair `key='value'`,
 * pairs joined by commas, the whole comment appended after the statement with
 * one space before it.
 *
 * WHY A VALUE CANNOT ESCAPE THE COMMENT. `encodeURIComponent` encodes `/`, so a
 * value can hold neither `*\/` (the comment's end) nor `/*` (PostgreSQL and SQL
 * Server nest block comments, so an opener would swallow the rest of the
 * text). It also encodes every character a driver-side placeholder rewrite
 * looks for (`$`, `?`, `:`, `@`) and `;`. Keys must match
 * {@link SQL_COMMENT_KEY_PATTERN}, whose first-character rule also rules out
 * MySQL's executable `/*!` and optimizer-hint `/*+` comments.
 *
 * WHERE IT IS APPENDED: at the execute seam, AFTER the SQL-template cache. The
 * cache stores commentless text, so its keys, its hit rate and the lockstep
 * checks are untouched by any comment, and a per-request value can never grow
 * it. `$on('query')` events keep `sql` commentless and carry the comment in
 * their own field.
 *
 * PREPARED-STATEMENT NAMES. node-postgres refuses to reuse a statement name for
 * different text on one connection, and every name a connection prepares stays
 * on the server until the connection closes. So:
 *
 *   - no comment: the template's own name, as before;
 *   - static, model, action and tag only (constant per call site and label):
 *     `c_<16 hex>`, a hash of the template name and the comment, claimed from
 *     the same process-wide budget as every other name
 *     (`PREPARED_STATEMENT_BUDGET`), so the server-side cost stays bounded
 *     however many labels there are;
 *   - any dynamic value (a trace id, unique per request): unnamed, parsed on
 *     every execution and never kept. A per-request value under a name would
 *     prepare a new statement on every pooled connection for every request.
 *
 * Leaf apart from errors.ts, logger.ts, query-events.ts (the `$tag` scope) and
 * utils.ts (the name budget); nothing here is Node-only.
 */

import { UnsupportedFeatureError, ValidationError } from '../errors.js';
import { logTo, type TurbineLogger } from '../logger.js';
import { currentQueryTag } from '../query-events.js';
import type { DeferredQuery } from './deferred.js';
import { claimPreparedName, fnv1a64Hex, LRUCache } from './utils.js';
import { shouldWarnOnce } from './warn-registry.js';

/** `TurbineConfig.sqlComment`. */
export interface SqlCommentOptions {
  /** Constant key/values on every statement this client builds: `{ application: 'billing' }`. */
  static?: Readonly<Record<string, string>> | undefined;
  /** Add `model` (the table) and `action` (`'findMany'`, `'update'`, ...) of the operation. */
  model?: boolean | undefined;
  /** Add the label of the innermost `db.$tag(label, fn)` scope as `tag`. */
  tag?: boolean | undefined;
  /**
   * Per-statement values, computed in the caller's async context (for example
   * a W3C `traceparent`). A key whose value is `undefined` is left out. A
   * statement carrying any dynamic value is sent unnamed: parsed on every
   * execution, never kept as a prepared statement. A key or value this
   * function returns that cannot be used is dropped with a warning
   * (`sql-comment-dropped`), and a throw drops all of them: a tracing hook
   * never fails a query.
   */
  dynamic?: (() => Readonly<Record<string, string | undefined>> | undefined | null) | undefined;
}

/** What a comment key must look like. Lower case, so it can never open `/*!` or `/*+`. */
export const SQL_COMMENT_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

/** Longest value accepted, in characters before encoding. */
export const MAX_SQL_COMMENT_VALUE_LENGTH = 256;

/** The keys `model: true` and `tag: true` fill in. */
const MODEL_KEYS = ['action', 'model'] as const;
const TAG_KEY = 'tag';

const OPTION_KEYS = new Set(['static', 'model', 'tag', 'dynamic']);

/** Once-only warning namespace for dropped dynamic values. */
const DROPPED_WARN_NS = 'sqlCommentDropped';

/** One statement's comment. */
export interface StatementComment {
  /** The comment exactly as appended, without the space before it: `/*key='value',...*\/`. */
  readonly comment: string;
  /** It carries a dynamic value, so the statement goes out unnamed. */
  readonly dynamic: boolean;
}

/**
 * `value` URL-encoded with `'` escaped, or `undefined` when it cannot be encoded
 * (a lone surrogate). `encodeURIComponent` leaves `'` as is and never emits a
 * backslash; the escape covers both anyway, so it stays complete on its own.
 */
function encodeValue(value: string): string | undefined {
  try {
    return encodeURIComponent(value).replace(/[\\']/g, '\\$&');
  } catch {
    return undefined;
  }
}

function render(pairs: ReadonlyArray<readonly [string, string]>): string {
  let out = '/*';
  for (let i = 0; i < pairs.length; i++) {
    const [key, value] = pairs[i]!;
    out += `${i === 0 ? '' : ','}${key}='${value}'`;
  }
  return `${out}*/`;
}

function byKey(a: readonly [string, string], b: readonly [string, string]): number {
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** A short, printable rendering of a caller's key for a message. */
function describeKey(key: string): string {
  return JSON.stringify(key.length > 64 ? `${key.slice(0, 64)}...` : key);
}

/**
 * Builds the comment for each statement and the name it is sent under. One per
 * client, shared by every table accessor and transaction of that client.
 */
export class SqlCommenter {
  /** Static pairs, encoded and sorted. */
  private readonly staticPairs: ReadonlyArray<readonly [string, string]>;
  /** Keys a dynamic value may not take: the static ones and the ones model / tag fill in. */
  private readonly reservedKeys: ReadonlySet<string>;
  private readonly withModel: boolean;
  private readonly withTag: boolean;
  private readonly dynamic: SqlCommentOptions['dynamic'];
  /** The comment when it depends on nothing per statement (no model, no tag). */
  private readonly constant: StatementComment | undefined;
  /** Rendered model / action / tag comments. Bounded: tags may come from data. */
  private readonly rendered = new LRUCache<string, { pairs: Array<readonly [string, string]>; comment: string }>(1000);
  /** Claimed `c_` names by template name and comment. Holds only claimed names, so the budget bounds it. */
  private readonly names = new Map<string, string>();

  /**
   * Every statement gets a comment (a static key, or the model and action),
   * so a template's own name is never sent and need not be claimed from the
   * budget; the commented name is claimed instead.
   */
  readonly alwaysComments: boolean;

  constructor(
    staticPairs: ReadonlyArray<readonly [string, string]>,
    withModel: boolean,
    withTag: boolean,
    dynamic: SqlCommentOptions['dynamic'],
    private readonly logger: TurbineLogger,
  ) {
    this.staticPairs = [...staticPairs].sort(byKey);
    this.withModel = withModel;
    this.withTag = withTag;
    this.dynamic = dynamic;
    const reserved = new Set(this.staticPairs.map(([k]) => k));
    if (withModel) for (const k of MODEL_KEYS) reserved.add(k);
    if (withTag) reserved.add(TAG_KEY);
    this.reservedKeys = reserved;
    this.alwaysComments = this.staticPairs.length > 0 || withModel;
    this.constant =
      !withModel && !withTag && this.staticPairs.length > 0
        ? { comment: render(this.staticPairs), dynamic: false }
        : undefined;
  }

  /**
   * The comment for one statement of operation `action` on `model`, or
   * `undefined` when it carries none. Reads the `$tag` scope and calls
   * `dynamic` in the caller's async context, so call it where the statement
   * is sent.
   */
  commentFor(model: string, action: string): StatementComment | undefined {
    let pairs: ReadonlyArray<readonly [string, string]>;
    let base: StatementComment | undefined;
    if (this.withModel || this.withTag) {
      const tag = this.withTag ? currentQueryTag() : undefined;
      const key = `${model}\u0000${action}\u0000${tag ?? ''}`;
      let hit = this.rendered.get(key);
      if (hit === undefined) {
        const built: Array<readonly [string, string]> = [...this.staticPairs];
        if (this.withModel) {
          built.push(['action', encodeValue(action) ?? ''], ['model', encodeValue(model) ?? '']);
        }
        // A `$tag` label is 1 to 128 characters, checked when the scope opens.
        const encodedTag = tag === undefined ? undefined : encodeValue(tag);
        if (encodedTag !== undefined) built.push([TAG_KEY, encodedTag]);
        built.sort(byKey);
        hit = { pairs: built, comment: built.length > 0 ? render(built) : '' };
        this.rendered.set(key, hit);
      }
      pairs = hit.pairs;
      base = hit.comment === '' ? undefined : { comment: hit.comment, dynamic: false };
    } else {
      pairs = this.staticPairs;
      base = this.constant;
    }
    if (this.dynamic === undefined) return base;
    const extra = this.dynamicPairs();
    if (extra === undefined) return base;
    return { comment: render([...pairs, ...extra].sort(byKey)), dynamic: true };
  }

  /**
   * The name a statement with comment `c` is sent under, given its template's
   * name. A template sent unnamed stays unnamed; a dynamic comment is unnamed;
   * anything else gets a stable `c_` name from the process-wide budget, or
   * goes unnamed once that is spent.
   */
  preparedName(templateName: string | undefined, c: StatementComment): string | undefined {
    if (!templateName) return templateName;
    if (c.dynamic) return '';
    const key = `${templateName}\u0000${c.comment}`;
    const known = this.names.get(key);
    if (known !== undefined) return known;
    const name = claimPreparedName(`c_${fnv1a64Hex(key)}`);
    if (name !== '') this.names.set(key, name);
    return name;
  }

  /** The usable dynamic pairs, encoded, or `undefined` when there are none. */
  private dynamicPairs(): Array<readonly [string, string]> | undefined {
    let values: unknown;
    try {
      values = this.dynamic?.();
    } catch (err) {
      this.dropped(
        'threw',
        '',
        `sqlComment.dynamic threw (${err instanceof Error ? err.message : String(err)}), so ` +
          'this statement carries no dynamic values. The statement itself ran as usual.',
      );
      return undefined;
    }
    if (values === undefined || values === null) return undefined;
    if (typeof values !== 'object' || Array.isArray(values)) {
      this.dropped(
        'shape',
        '',
        'sqlComment.dynamic returned something other than an object of string values, so this statement carries ' +
          'no dynamic values. Return an object such as { traceparent: "00-..." }, or undefined for none.',
      );
      return undefined;
    }
    let out: Array<readonly [string, string]> | undefined;
    for (const key of Object.keys(values)) {
      const value = (values as Record<string, unknown>)[key];
      if (value === undefined) continue;
      const reason = this.refusal(key, value);
      if (reason !== undefined) {
        this.dropped(
          reason[0],
          key,
          `sqlComment.dynamic key ${describeKey(key)} was left out of the comment: ${reason[1]}`,
        );
        continue;
      }
      const encoded = encodeValue(value as string);
      if (encoded === undefined) {
        this.dropped(
          'encoding',
          key,
          `sqlComment.dynamic key ${describeKey(key)} was left out of the comment: its value is not well-formed ` +
            'Unicode (a lone surrogate), so it cannot be URL-encoded.',
        );
        continue;
      }
      if (out === undefined) out = [];
      out.push([key, encoded]);
    }
    return out;
  }

  /** Why a dynamic key or value cannot be used, as [warning key, sentence], or `undefined`. */
  private refusal(key: string, value: unknown): [string, string] | undefined {
    if (!SQL_COMMENT_KEY_PATTERN.test(key)) {
      return ['key', 'a key must be lower-case letters, digits and underscores, starting with a letter.'];
    }
    if (this.reservedKeys.has(key)) {
      return ['reserved', 'that key is already set by sqlComment.static, model or tag, which take precedence.'];
    }
    if (typeof value !== 'string') return ['type', `its value is ${typeof value}, not a string.`];
    if (value.length > MAX_SQL_COMMENT_VALUE_LENGTH) {
      return ['length', `its value is ${value.length} characters, over the ${MAX_SQL_COMMENT_VALUE_LENGTH} allowed.`];
    }
    return undefined;
  }

  /** One warning per reason and key, so a hook that misbehaves on every statement says it once. */
  private dropped(reason: string, key: string, message: string): void {
    if (!shouldWarnOnce(DROPPED_WARN_NS, `${reason}|${key.slice(0, 64)}`)) return;
    logTo(this.logger, 'warn', message, { code: 'sql-comment-dropped', reason });
  }
}

/**
 * Validate `TurbineConfig.sqlComment` and build its commenter, or `undefined`
 * when there is nothing to add. Throws `ValidationError` (E003) for a malformed
 * option, and `UnsupportedFeatureError` (E017) where it cannot be honoured:
 *
 *   - a backend that builds no SQL (PowDB, which injects its own query
 *     interface) has nothing to comment;
 *   - `dynamic` on an engine that prepares every statement text
 *     (`preparesEveryStatement`), which is MySQL: the MySQL engine sends each
 *     parameterized statement through mysql2's `execute()`, which keeps one
 *     SERVER-side prepared
 *     statement per distinct text per connection (up to 16,000 each), and the
 *     server caps the total across every client at `max_prepared_stmt_count`
 *     (16,382 by default). A value unique per request makes every text
 *     distinct, so a busy pool reaches that cap (error 1461) and every client
 *     of the server then fails to prepare.
 */
export function resolveSqlComment(
  value: unknown,
  logger: TurbineLogger,
  engine: { readonly dialect: string; readonly preparesEveryStatement: boolean; readonly buildsSql: boolean },
): SqlCommenter | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw new ValidationError(
      'Invalid sqlComment: expected an object with any of `static`, `model`, `tag` and `dynamic`, for example ' +
        "{ static: { application: 'billing' }, model: true }.",
    );
  }
  for (const key of Object.keys(value)) {
    if (!OPTION_KEYS.has(key)) {
      throw new ValidationError(
        `Invalid sqlComment: unknown key ${describeKey(key)}. The keys are \`static\`, \`model\`, \`tag\` and \`dynamic\`.`,
      );
    }
  }
  const { static: staticValues, model, tag, dynamic } = value as SqlCommentOptions;
  for (const [name, flag] of [
    ['model', model],
    ['tag', tag],
  ] as const) {
    if (flag !== undefined && typeof flag !== 'boolean') {
      throw new ValidationError(`Invalid sqlComment.${name}: expected true or false, got ${typeof flag}.`);
    }
  }
  if (dynamic !== undefined && typeof dynamic !== 'function') {
    throw new ValidationError(
      `Invalid sqlComment.dynamic: expected a function returning an object of string values, got ${typeof dynamic}.`,
    );
  }
  const pairs: Array<readonly [string, string]> = [];
  if (staticValues !== undefined) {
    if (!isPlainObject(staticValues)) {
      throw new ValidationError(
        "Invalid sqlComment.static: expected an object of string values, for example { application: 'billing' }.",
      );
    }
    for (const key of Object.keys(staticValues)) {
      const v = staticValues[key];
      const where = `sqlComment.static key ${describeKey(key)}`;
      if (!SQL_COMMENT_KEY_PATTERN.test(key)) {
        throw new ValidationError(
          `Invalid ${where}: a key must be lower-case letters, digits and underscores, starting with a letter ` +
            '(the comment must never open a MySQL executable or hint comment, `/*!` or `/*+`).',
        );
      }
      if ((model === true && (MODEL_KEYS as readonly string[]).includes(key)) || (tag === true && key === TAG_KEY)) {
        throw new ValidationError(
          `Invalid ${where}: \`${key}\` is filled in by sqlComment.${key === TAG_KEY ? 'tag' : 'model'}. ` +
            'Rename the static key or turn that option off.',
        );
      }
      if (typeof v !== 'string') {
        throw new ValidationError(`Invalid ${where}: expected a string value, got ${typeof v}.`);
      }
      if (v.length > MAX_SQL_COMMENT_VALUE_LENGTH) {
        throw new ValidationError(
          `Invalid ${where}: the value is ${v.length} characters, over the ${MAX_SQL_COMMENT_VALUE_LENGTH} allowed.`,
        );
      }
      const encoded = encodeValue(v);
      if (encoded === undefined) {
        throw new ValidationError(
          `Invalid ${where}: the value is not well-formed Unicode (a lone surrogate), so it cannot be URL-encoded.`,
        );
      }
      pairs.push([key, encoded]);
    }
  }
  if (pairs.length === 0 && model !== true && tag !== true && dynamic === undefined) return undefined;
  if (!engine.buildsSql) {
    throw new UnsupportedFeatureError(
      'sqlComment',
      engine.dialect,
      'This engine does not run SQL, so there is no statement to carry a comment. Remove the option for this client.',
    );
  }
  if (dynamic !== undefined && engine.preparesEveryStatement) {
    throw new UnsupportedFeatureError(
      'sqlComment.dynamic',
      engine.dialect,
      'The MySQL engine prepares each distinct statement text on the server (mysql2 execute(), up to 16,000 per ' +
        'connection), and the server caps prepared statements across all clients at max_prepared_stmt_count ' +
        '(16,382 by default). A per-statement value makes every text distinct, so a busy pool reaches that cap ' +
        '(error 1461) and prepares start failing server-wide. Use `static`, `model` and `tag`, which are bounded.',
    );
  }
  return new SqlCommenter(pairs, model === true, tag === true, dynamic, logger);
}

/**
 * `sql` with a comment Turbine appended removed, for code that reads statement
 * text to decide how to run it (an engine shim telling a row-returning
 * statement from a change count). A value can never contain `/*` (it is
 * URL-encoded), so the last ` /*` of a statement ending in `*\/` is the
 * comment's own opener; text Turbine did not comment is returned unchanged
 * unless it, too, ends in a block comment, which is equally not code.
 */
export function withoutTrailingComment(sql: string): string {
  if (!sql.endsWith('*/')) return sql;
  const at = sql.lastIndexOf(' /*');
  return at < 0 ? sql : sql.slice(0, at);
}

/**
 * `q` as sent with `comment`: its statement, and every statement of its
 * reselect plan (MySQL), carry the comment. Everything else on the query is
 * kept. Used by the batch paths (`pipeline`, `$transaction([...])`), which run
 * deferred queries without going through a query interface.
 */
export function commentDeferred<T>(q: DeferredQuery<T>, comment: string | undefined): DeferredQuery<T> {
  if (comment === undefined) return q;
  const reselect = q.reselect;
  return {
    ...q,
    sql: `${q.sql} ${comment}`,
    ...(reselect
      ? { reselect: (exec) => reselect((sql, params, name) => exec(`${sql} ${comment}`, params, name)) }
      : {}),
  };
}
