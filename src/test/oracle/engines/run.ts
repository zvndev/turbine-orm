/**
 * Registers the cross-engine battery for one engine against the Postgres oracle.
 *
 * For each scenario the oracle and the engine each produce an OUTCOME: the
 * type-tagged return value (plus the final table state for a write), or the
 * thrown error's class and code. The outcomes must be identical unless
 * `allowlist.ts` says otherwise, and every allowlist entry is itself verified.
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import { TurbineError, UnsupportedFeatureError } from '../../../errors.js';
import type { GatedRunners } from '../../helpers.js';
import { REPRESENTATIONS, representationRules, SCENARIO_ENTRIES, scenarioEntry } from './allowlist.js';
import { Comparison, type Tagged, tag } from './compare.js';
import type { EngineHarness, EngineName } from './harness.js';
import { SCENARIOS, type Scenario } from './scenarios.js';

type Outcome = { ok: true; tagged: Tagged } | { ok: false; error: unknown; tagged: Tagged };

function errorTag(err: unknown): string {
  if (err instanceof TurbineError) return `error:${err.constructor.name}:${err.code}`;
  if (err instanceof Error) return `error:${err.constructor.name}`;
  return `error:${String(err)}`;
}

function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split('\n')[0]?.slice(0, 240) ?? '';
}

async function outcome(h: EngineHarness, s: Scenario): Promise<Outcome> {
  try {
    const value = await h.withClient(s.config, (db) => s.run(db));
    if (s.kind === 'read') return { ok: true, tagged: tag(value) };
    const state: Record<string, unknown> = {};
    for (const table of s.state ?? []) {
      state[table] = await h.withClient(undefined, (db) => db.table(table).findMany({ orderBy: { id: 'asc' } }));
    }
    return { ok: true, tagged: tag({ returned: value, state }) };
  } catch (error) {
    return { ok: false, error, tagged: errorTag(error) };
  }
}

function explain(oracle: Outcome, engine: Outcome, cmp: Comparison): string {
  const lines: string[] = [];
  if (!oracle.ok) lines.push(`  postgres threw: ${errorTag(oracle.error)}: ${errorText(oracle.error)}`);
  if (!engine.ok) lines.push(`  engine threw:   ${errorTag(engine.error)}: ${errorText(engine.error)}`);
  if (oracle.ok && engine.ok) {
    for (const d of cmp.diffs) lines.push(`  at ${d.path}`, `    postgres: ${d.oracle}`, `    engine:   ${d.engine}`);
  }
  return lines.join('\n');
}

/**
 * Decide one scenario. Returns a note for the test's diagnostics when an
 * allowlisted difference was observed; throws on anything else.
 */
function judge(
  engine: EngineName,
  s: Scenario,
  oracle: Outcome,
  got: Outcome,
  cmp: Comparison,
  repro: string,
): string | undefined {
  const entry = scenarioEntry(engine, s.id);
  const equal = cmp.equal(oracle.tagged, got.tagged);
  const where = `${engine} ${s.id}`;
  const expected = s.throws === undefined ? undefined : `error:${s.throws}`;
  if (oracle.ok) {
    assert.ok(
      expected === undefined,
      `${where}: declares throws "${s.throws}" but Postgres returned a value. Fix the scenario.\n${repro}`,
    );
  } else {
    assert.ok(
      oracle.tagged === expected,
      expected === undefined
        ? `${where}: Postgres itself threw, so the scenario compares nothing. Fix it, or declare the ` +
            `refusal with \`throws: '${errorTag(oracle.error).slice('error:'.length)}'\` if the refusal is the point.\n` +
            `${explain(oracle, got, cmp)}\n${repro}`
        : `${where}: Postgres threw ${errorTag(oracle.error)}, expected ${expected}\n${explain(oracle, got, cmp)}\n${repro}`,
    );
  }
  if (!entry) {
    if (equal) return undefined;
    assert.fail(`${where}: the engine disagrees with Postgres\n${explain(oracle, got, cmp)}\n${repro}`);
  }
  const stale = (why: string): never =>
    assert.fail(
      `${where}: allowlisted as "${entry.kind}" but ${why}. ` +
        `Delete the entry from src/test/oracle/engines/allowlist.ts.\n${repro}`,
    );
  switch (entry.kind) {
    case 'unsupported': {
      assert.ok(
        oracle.ok,
        `${where}: Postgres itself failed, so this entry cannot be checked\n${explain(oracle, got, cmp)}`,
      );
      if (got.ok) stale('the engine now runs the shape');
      assert.ok(
        !got.ok && got.error instanceof UnsupportedFeatureError,
        `${where}: allowlisted as unsupported, so it must throw UnsupportedFeatureError (E017), got ` +
          `${got.ok ? 'a result' : `${errorTag(got.error)}: ${errorText(got.error)}`}\n${repro}`,
      );
      return `unsupported on ${engine}: ${errorText(got.error)}`;
    }
    case 'difference':
    case 'bug': {
      if (equal) stale('the engine now agrees with Postgres');
      if (entry.relax === 'unordered') {
        assert.ok(
          oracle.ok && got.ok && cmp.equalUnordered(oracle.tagged, got.tagged),
          `${where}: only row order may differ here, but the rows differ too\n${explain(oracle, got, cmp)}\n${repro}`,
        );
      }
      return `${entry.kind} on ${engine}: ${entry.note}\n${explain(oracle, got, cmp)}`;
    }
  }
}

export interface BatteryOptions {
  engine: EngineHarness;
  oracle: EngineHarness;
  runners: GatedRunners;
  /** The command that reruns this file. */
  repro: string;
}

export function registerEngineBattery({ engine, oracle, runners, repro }: BatteryOptions): void {
  const { it, before, after } = runners;
  const name = engine.name;
  const rules = representationRules(name);
  const ruleUses = new Map<string, number>();
  let compared = 0;

  describe(`cross-engine oracle: ${name} against postgres`, () => {
    before(async () => {
      await oracle.setup();
      await engine.setup();
      await oracle.reset();
      await engine.reset();
    });
    after(async () => {
      await engine.teardown();
      await oracle.teardown();
    });

    for (const s of SCENARIOS) {
      it(s.id, async (t) => {
        if (s.kind === 'write') {
          await oracle.reset();
          await engine.reset();
        }
        const expected = await outcome(oracle, s);
        const got = await outcome(engine, s);
        compared++;
        const cmp = new Comparison(rules);
        try {
          const note = judge(name, s, expected, got, cmp, `${repro} --test-name-pattern="${s.id}"`);
          if (note) t.diagnostic(note);
        } finally {
          for (const [id, n] of cmp.used) ruleUses.set(id, (ruleUses.get(id) ?? 0) + n);
        }
      });
    }

    it('every scenario ran, and every allowlist entry is real and still needed', (t) => {
      assert.ok(SCENARIOS.length >= 60, `only ${SCENARIOS.length} scenarios are defined`);
      assert.equal(compared, SCENARIOS.length, `compared ${compared} of ${SCENARIOS.length} scenarios`);
      const known = new Set(SCENARIOS.map((s) => s.id));
      assert.equal(known.size, SCENARIOS.length, 'two scenarios share an id');
      const orphans = SCENARIO_ENTRIES.filter((e) => e.engine === name && !known.has(e.scenario)).map(
        (e) => e.scenario,
      );
      assert.deepEqual(orphans, [], `allowlist entries for ${name} name scenarios that do not exist`);
      const unused = REPRESENTATIONS.filter((r) => r.engine === name && !ruleUses.get(r.id)).map((r) => r.id);
      assert.deepEqual(
        unused,
        [],
        `representation entries for ${name} were never needed this run; the engine now matches Postgres there. ` +
          'Delete them from src/test/oracle/engines/allowlist.ts.',
      );
      const uses = [...ruleUses].map(([id, n]) => `${id}: ${n}`).join(', ');
      if (uses) t.diagnostic(`${name} representation entries used: ${uses}`);
    });
  });
}
