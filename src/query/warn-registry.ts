/**
 * turbine-orm, process-wide once-per-key dev-warning dedupe registry.
 *
 * Several dev-only diagnostics (the missing-FK-index warning in relations.ts,
 * the `relationLoadStrategy: 'auto'` engagement note, the deep-`with` warning)
 * must fire AT MOST ONCE per distinct key for the life of the process. A
 * module-level `Set` almost does this, but it is defeated by the two field
 * realities this package actually ships into:
 *
 *   1. **Dual-package loading.** Turbine ships ESM (`dist/`) AND CJS
 *      (`dist/cjs/`). A mixed `require`/`import` graph (a compat layer, a tool
 *      that loads both) instantiates the module twice, giving two independent
 *      `Set`s that each warn once, a double warning.
 *   2. **Bundler / HMR re-evaluation.** Under Next.js dev the module is
 *      re-evaluated per recompile, resetting a module-level `Set` and making the
 *      warning appear to fire every time.
 *
 * Hanging the registry off `globalThis` under a `Symbol.for(...)` key gives every
 * module copy in the realm ONE shared registry (cross-copy identity without
 * polluting enumerable globals), and `globalThis` survives webpack recompiles
 * because the realm persists, which is exactly what fixes the every-recompile
 * firing in dev servers. Per-process firing (worker threads, separate processes)
 * is acceptable and stays.
 *
 * Bounded: each namespace stops recording AND stops warning once it reaches
 * {@link WARN_ONCE_CAP} distinct keys. A schema with 500+ distinct unindexed
 * relations has long since gotten the message, and the cap prevents unbounded
 * growth if metadata objects are churned dynamically. (Clearing on overflow
 * would be wrong, it would re-warn.)
 */

const REGISTRY_KEY = Symbol.for('turbine.warnOnce.registry');

/** Per-namespace cap on distinct recorded keys (see module doc). */
export const WARN_ONCE_CAP = 500;

type Registry = Record<string, Set<string> | undefined>;

function registry(): Registry {
  const g = globalThis as Record<symbol, unknown>;
  let reg = g[REGISTRY_KEY] as Registry | undefined;
  if (!reg) {
    reg = Object.create(null) as Registry;
    g[REGISTRY_KEY] = reg;
  }
  return reg;
}

function namespaceSet(ns: string): Set<string> {
  const reg = registry();
  let set = reg[ns];
  if (!set) {
    set = new Set<string>();
    reg[ns] = set;
  }
  return set;
}

/**
 * Record `(ns, key)` and report whether THIS call is the first to see it
 * process-wide. Returns `true` exactly once per distinct key (the caller should
 * emit its warning then), `false` on every subsequent call for that key, and
 * `false` once the namespace has recorded {@link WARN_ONCE_CAP} distinct keys
 * (bounded growth; the warning simply stops rather than re-firing).
 */
export function shouldWarnOnce(ns: string, key: string): boolean {
  const set = namespaceSet(ns);
  if (set.has(key)) return false;
  if (set.size >= WARN_ONCE_CAP) return false;
  set.add(key);
  return true;
}

/** True when `(ns, key)` has already been recorded (no mutation). */
export function hasWarnedOnce(ns: string, key: string): boolean {
  return namespaceSet(ns).has(key);
}

/**
 * @internal Test-only: clear one namespace, or the whole registry when `ns` is
 * omitted. Lets a single test process verify that a warning fires once and then
 * re-verify after a reset without spawning a new process.
 */
export function resetWarnOnce(ns?: string): void {
  if (ns === undefined) {
    (globalThis as Record<symbol, unknown>)[REGISTRY_KEY] = undefined;
    return;
  }
  registry()[ns] = undefined;
}

/** Namespace constants so callers never typo a bare string. */
export const WARN_NS = {
  /** Missing-FK-index runtime warning (relations.ts `buildRelationSubquery`). */
  unindexedRelation: 'unindexedRelation',
  /** `relationLoadStrategy: 'auto'` batched-fallback engagement note. */
  autoStrategy: 'autoStrategy',
  /** Deep-`with` (depth > 5) advisory (builder.ts `findMany`). */
  deepWith: 'deepWith',
} as const;
