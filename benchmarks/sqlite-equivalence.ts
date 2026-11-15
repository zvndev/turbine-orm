/** Exact independent native expectations for every SQLite comparison operation. */
import type { DatabaseSync } from 'node:sqlite';
import type { Arm } from './bench-harness.js';
import { assertExact } from './equivalence.js';
import { decodeRow, fixtureRow, volumes } from './sqlite-seed.js';

export { assertExact } from './equivalence.js';
// biome-ignore lint/suspicious/noExplicitAny: fixtures include native rows, relations and aggregate objects.
export type Row = Record<string, any>;
export type Fixture = Record<string, Row[]>;
export type Status = 'supported' | 'refused' | 'not-applicable';
export interface ComparisonScenario {
  id: string;
  group: string;
  scenario: string;
  arms: Arm[];
  expected: (i: number) => unknown;
  note?: string;
  stream?: boolean;
  write?: string;
  normalize?: (value: Row[]) => unknown;
  after?: (arm: Arm, i: number) => Promise<void>;
  restore?: () => void;
}
export function nativeFixture(db: DatabaseSync): Fixture {
  const f: Fixture = {};
  for (const [t, n] of Object.entries(volumes)) {
    f[t] = db
      .prepare(`SELECT * FROM ${t} ORDER BY ${t === 'post_tags' ? 'post_id,tag_id' : 'id'}`)
      .all()
      .map((r) => decodeRow(t, r));
    if (f[t]!.length !== n) throw new Error(`SEED MISMATCH ${t}: expected ${n}, got ${f[t]!.length}`);
    if (!['post_tags', 'bench_writes'].includes(t))
      for (let id = 1; id <= n; id++) assertExact(`seed ${t}/${id}`, f[t]![id - 1], fixtureRow(t, id));
  }
  if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Foreign key check failed');
  return f;
}
export const nestedUsers = (f: Fixture, n: number, postLimit = 10, comments = false) =>
  f.users!.slice(0, n).map((u) => ({
    ...u,
    posts: f
      .posts!.filter((p) => p.userId === u.id)
      .slice(0, postLimit)
      .map((p) => (comments ? { ...p, comments: f.comments!.filter((c) => c.postId === p.id) } : p)),
  }));
export const authors = (f: Fixture, n: number) =>
  f.posts!.slice(0, n).map((p) => ({ ...p, user: f.users!.find((u) => u.id === p.userId) }));
export const tags = (f: Fixture, n: number) =>
  f.posts!.slice(0, n).map((p) => ({
    ...p,
    tags: f.post_tags!.filter((j) => j.postId === p.id).map((j) => f.tags!.find((t) => t.id === j.tagId)),
  }));
export function assertCatalog(scenarios: ComparisonScenario[], required: readonly string[]): void {
  if (
    scenarios.length !== required.length ||
    new Set(scenarios.map((s) => s.id)).size !== required.length ||
    required.some((id) => !scenarios.some((s) => s.id === id))
  )
    throw new Error('SQLite catalog incomplete or duplicated');
  for (const s of scenarios)
    if (!s.arms.length || new Set(s.arms.map((a) => a.name)).size !== s.arms.length)
      throw new Error(`SQLite catalog empty/duplicate arms: ${s.id}`);
}
export async function verifyScenarios(
  scenarios: ComparisonScenario[],
  fault = 'none',
  checked: { id: string; arm: string; values: number; inputs: number[] }[] = [],
): Promise<{ id: string; arm: string; values: number; inputs: number[] }[]> {
  for (const s of scenarios) {
    let primary: unknown;
    try {
      for (const arm of s.arms) {
        try {
          const inputs = s.id === 'headline-10' ? Array.from({ length: 50 }, (_, i) => i) : [37];
          let values = 0;
          for (const i of inputs) {
            await arm.setup?.(i);
            const observed: unknown[] = [];
            let value = await arm.fn(i, s.stream ? (r) => observed.push(r) : undefined);
            if (fault === 'hot-input' && s.id === 'headline-10' && arm.name === 'Raw' && i === 49)
              value = { ...(value as Row), id: -1 };
            if (fault === 'value' && s.id === 'headline-0' && arm.name === 'Raw') value = (value as Row[]).slice(1);
            if (fault === 'order' && s.id === 'headline-1' && arm.name === 'Raw') {
              value = structuredClone(value);
              (value as Row[])[0]!.posts.reverse();
            }
            if (fault === 'type' && s.id === 'headline-0' && arm.name === 'Raw') {
              value = structuredClone(value);
              (value as Row[])[0]!.lastLoginAt = 'null';
            }
            if (fault === 'stream' && s.stream && arm.name === 'Raw') observed.splice(100, 1);
            if (fault === 'stream-order' && s.stream && arm.name === 'Raw')
              [observed[0], observed[1]] = [observed[1], observed[0]];
            const expected = s.expected(i);
            if (s.stream) {
              assertExact(`${s.id}/${arm.name} stream count`, value, (expected as unknown[]).length);
              assertExact(`${s.id}/${arm.name} complete ordered stream`, observed, expected);
            } else assertExact(`${s.id}/${arm.name}`, s.normalize ? s.normalize(value as Row[]) : value, expected);
            await s.after?.(arm, i);
            values = s.stream ? observed.length : Array.isArray(expected) ? expected.length : 1;
          }
          checked.push({
            id: s.id,
            arm: arm.name,
            values,
            inputs,
          });
        } catch (e) {
          throw new Error(`${s.id}/${arm.name}: ${(e as Error).message}`, { cause: e });
        }
      }
    } catch (e) {
      primary = e;
    }
    try {
      s.restore?.();
    } catch (cleanup) {
      primary = primary
        ? new AggregateError(
            [primary, cleanup],
            `${(primary as Error).message}; restoration also failed: ${(cleanup as Error).message}`,
            { cause: primary },
          )
        : cleanup;
    }
    if (primary) throw primary;
  }
  return checked;
}
