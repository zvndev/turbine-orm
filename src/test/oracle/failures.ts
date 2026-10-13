/**
 * Collects mismatches across a whole random run and reports them once, grouped,
 * with the seed. A differential that stops at its first failure hides whether one
 * bug or six produced it; a differential that prints 4,000 lines hides all of
 * them. Grouping by "kind" gives one line per distinct symptom.
 */

import assert from 'node:assert/strict';
import { reproLine } from './env.js';

export interface FailureSample {
  readonly detail: string;
}

export class Failures {
  private readonly byKind = new Map<string, { count: number; samples: string[] }>();
  private readonly tallies = new Map<string, number>();
  private checks = 0;

  constructor(
    private readonly file: string,
    private readonly maxSamples = 3,
  ) {}

  /** Count a comparison that was made, so a run that compared nothing is itself a failure. */
  checked(n = 1): void {
    this.checks += n;
  }

  get checkCount(): number {
    return this.checks;
  }

  get failureCount(): number {
    let total = 0;
    for (const entry of this.byKind.values()) total += entry.count;
    return total;
  }

  add(kind: string, detail: string): void {
    const entry = this.byKind.get(kind) ?? { count: 0, samples: [] };
    entry.count++;
    if (entry.samples.length < this.maxSamples) entry.samples.push(detail);
    this.byKind.set(kind, entry);
  }

  /** Count one failing case against a label, for an attribution table (no samples kept). */
  tally(label: string): void {
    this.tallies.set(label, (this.tallies.get(label) ?? 0) + 1);
  }

  /** Fail with a grouped report if anything was recorded, or if nothing was compared. */
  assertClean(title: string, minChecks = 1, maxKinds = 12, maxTallies = 16): void {
    assert.ok(
      this.checks >= minChecks,
      `${title}: only ${this.checks} comparisons ran (expected at least ${minChecks}); the test compared nothing`,
    );
    if (this.byKind.size === 0) return;
    const lines: string[] = [
      `${title}: ${this.failureCount} of ${this.checks} comparisons disagreed with the oracle (${this.byKind.size} distinct kinds)`,
      reproLine(this.file),
    ];
    const sorted = [...this.byKind.entries()].sort((a, b) => b[1].count - a[1].count);
    for (const [kind, entry] of sorted.slice(0, maxKinds)) {
      lines.push('', `  [${entry.count}x] ${kind}`);
      for (const sample of entry.samples) {
        for (const line of sample.split('\n')) lines.push(`      ${line}`);
        lines.push('      ---');
      }
    }
    if (sorted.length > maxKinds) {
      lines.push(
        '',
        `  ... and ${sorted.length - maxKinds} more kinds: ${sorted
          .slice(maxKinds)
          .map(([k, e]) => `${k} (${e.count}x)`)
          .join('; ')}`,
      );
    }
    if (this.tallies.size > 0) {
      lines.push('', '  attribution (failing cases per label):');
      const tallies = [...this.tallies.entries()].sort((a, b) => b[1] - a[1]);
      for (const [label, n] of tallies.slice(0, maxTallies)) lines.push(`    ${String(n).padStart(5)}  ${label}`);
      if (tallies.length > maxTallies) lines.push(`    ... and ${tallies.length - maxTallies} more labels`);
    }
    assert.fail(lines.join('\n'));
  }
}
