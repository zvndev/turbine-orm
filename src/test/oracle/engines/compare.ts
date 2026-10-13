/**
 * Type-tagged comparison for the cross-engine battery.
 *
 * Every value is rewritten into a tree where each leaf names its JS type:
 * `num:1`, `str:"1"`, `bigint:1`, `bool:true`, `date:2026-01-01T00:00:00.000Z`.
 * Two engines agree only when the tagged trees are identical, so a `1` against
 * a `true`, a `12.5` against a `"12.5"`, a Date against an ISO string, and `[]`
 * against `{}` are all differences.
 *
 * The one exception is a REPRESENTATION RULE from `allowlist.ts`: a named,
 * per-engine statement such as "booleans read as 0/1", which accepts exactly
 * that pair of leaves and counts every use. A rule that is never used fails the
 * battery, so it cannot outlive the behavior it describes.
 *
 * Object keys are compared as a set (sorted), because key order is not a value.
 */

export type Tagged = string | Tagged[] | { [key: string]: Tagged };

export function tag(value: unknown): Tagged {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  switch (typeof value) {
    case 'boolean':
      return `bool:${value}`;
    case 'number':
      if (Number.isNaN(value)) return 'num:NaN';
      if (Object.is(value, -0)) return 'num:-0';
      return `num:${value}`;
    case 'bigint':
      return `bigint:${value}`;
    case 'string':
      return `str:${JSON.stringify(value)}`;
    case 'function':
    case 'symbol':
      return `${typeof value}`;
  }
  if (value instanceof Date) return `date:${Number.isNaN(value.getTime()) ? 'INVALID' : value.toISOString()}`;
  if (value instanceof Uint8Array) return `bytes:${Buffer.from(value).toString('hex')}`;
  if (Array.isArray(value)) return value.map(tag);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return `object:${proto?.constructor?.name ?? 'unknown'}`;
  const out: { [key: string]: Tagged } = {};
  for (const key of Object.keys(value as object).sort()) out[key] = tag((value as Record<string, unknown>)[key]);
  return out;
}

/**
 * A representation rule: given the oracle's subtree and the engine's leaf at
 * the same position, return `true` when they are the same value written the
 * way this rule describes, a Tagged tree to keep comparing against (the engine
 * value decoded), or `false` when the rule does not apply.
 */
export interface ReprRule {
  id: string;
  /** Property names (the last path segment) the rule may apply under. */
  fields: readonly string[];
  accept(oracle: Tagged, engine: Tagged): boolean | Tagged;
}

/** The property a path ends in: `$.state.oe_users[2].active` is `active`. */
export function lastField(path: string): string {
  const m = /\.([^.[\]]+)(?:\[\d+\])*$/.exec(path);
  return m?.[1] ?? '';
}

/** Decode a `str:"..."` leaf back to its JS string. */
export function leafString(t: Tagged): string | undefined {
  return typeof t === 'string' && t.startsWith('str:') ? (JSON.parse(t.slice(4)) as string) : undefined;
}

export interface Difference {
  path: string;
  oracle: string;
  engine: string;
}

export class Comparison {
  readonly used = new Map<string, number>();
  readonly diffs: Difference[] = [];

  constructor(
    private readonly rules: readonly ReprRule[],
    private readonly maxDiffs = 8,
  ) {}

  /** True when the trees are the same value, allowing only the rules' representations. */
  equal(oracle: Tagged, engine: Tagged, path = '$'): boolean {
    if (typeof oracle === 'string' && typeof engine === 'string' && oracle === engine) return true;
    if (typeof oracle !== 'string' && typeof engine !== 'string' && Array.isArray(oracle) === Array.isArray(engine)) {
      return Array.isArray(oracle)
        ? this.arrays(oracle, engine as Tagged[], path)
        : this.objects(oracle, engine as Record<string, Tagged>, path);
    }
    const field = lastField(path);
    for (const rule of this.rules) {
      if (!rule.fields.includes(field)) continue;
      const verdict = rule.accept(oracle, engine);
      if (verdict === false) continue;
      if (verdict === true || this.quiet(() => this.equal(oracle, verdict, path))) {
        this.used.set(rule.id, (this.used.get(rule.id) ?? 0) + 1);
        return true;
      }
    }
    this.note(path, oracle, engine);
    return false;
  }

  /** Same as `equal`, but every array may be in any order (an allowlisted ORDER difference). */
  equalUnordered(oracle: Tagged, engine: Tagged): boolean {
    return this.quiet(() => this.unordered(oracle, engine));
  }

  private unordered(oracle: Tagged, engine: Tagged): boolean {
    if (Array.isArray(oracle) && Array.isArray(engine)) {
      if (oracle.length !== engine.length) return false;
      const left = [...engine];
      for (const o of oracle) {
        const i = left.findIndex((e) => this.unordered(o, e));
        if (i === -1) return false;
        left.splice(i, 1);
      }
      return true;
    }
    if (
      oracle &&
      engine &&
      typeof oracle === 'object' &&
      typeof engine === 'object' &&
      !Array.isArray(oracle) &&
      !Array.isArray(engine)
    ) {
      const keys = new Set([...Object.keys(oracle), ...Object.keys(engine)]);
      for (const k of keys) {
        if (!(k in oracle) || !(k in engine)) return false;
        if (!this.unordered(oracle[k] as Tagged, engine[k] as Tagged)) return false;
      }
      return true;
    }
    return this.equal(oracle, engine);
  }

  private arrays(oracle: Tagged[], engine: Tagged[], path: string): boolean {
    let ok = oracle.length === engine.length;
    if (!ok) this.note(`${path}.length`, String(oracle.length), String(engine.length));
    for (let i = 0; i < Math.min(oracle.length, engine.length); i++) {
      if (!this.equal(oracle[i] as Tagged, engine[i] as Tagged, `${path}[${i}]`)) ok = false;
    }
    return ok;
  }

  private objects(oracle: Record<string, Tagged>, engine: Record<string, Tagged>, path: string): boolean {
    let ok = true;
    for (const key of new Set([...Object.keys(oracle), ...Object.keys(engine)])) {
      if (!(key in oracle)) {
        this.note(`${path}.${key}`, '(absent)', engine[key] as Tagged);
        ok = false;
      } else if (!(key in engine)) {
        this.note(`${path}.${key}`, oracle[key] as Tagged, '(absent)');
        ok = false;
      } else if (!this.equal(oracle[key] as Tagged, engine[key] as Tagged, `${path}.${key}`)) ok = false;
    }
    return ok;
  }

  /** Run a trial comparison without recording its differences or rule uses. */
  private quiet(fn: () => boolean): boolean {
    const used = new Map(this.used);
    const diffCount = this.diffs.length;
    const result = fn();
    this.diffs.length = diffCount;
    if (!result) {
      this.used.clear();
      for (const [k, v] of used) this.used.set(k, v);
    }
    return result;
  }

  private note(path: string, oracle: Tagged | string, engine: Tagged | string): void {
    if (this.diffs.length < this.maxDiffs) this.diffs.push({ path, oracle: brief(oracle), engine: brief(engine) });
  }
}

function brief(value: Tagged | string): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.length > 160 ? `${s.slice(0, 160)}...` : s;
}
