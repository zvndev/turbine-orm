/**
 * turbine-orm, process-wide once-per-key dev-warning registry (finding 8)
 *
 * The registry hangs off globalThis under a Symbol.for key so every dual-package
 * / HMR-reevaluated module copy shares ONE dedupe store. These tests drive the
 * public primitives directly (and simulate a "second module copy" by keeping the
 * globalThis registry while re-reading through it).
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { hasWarnedOnce, resetWarnOnce, shouldWarnOnce, WARN_NS, WARN_ONCE_CAP } from '../query/warn-registry.js';

const NS = 'test.warnRegistry';

afterEach(() => resetWarnOnce());

describe('warn-registry', () => {
  it('shouldWarnOnce returns true exactly once per key', () => {
    assert.equal(shouldWarnOnce(NS, 'a'), true);
    assert.equal(shouldWarnOnce(NS, 'a'), false);
    assert.equal(shouldWarnOnce(NS, 'a'), false);
  });

  it('different keys each warn once', () => {
    assert.equal(shouldWarnOnce(NS, 'a'), true);
    assert.equal(shouldWarnOnce(NS, 'b'), true);
    assert.equal(shouldWarnOnce(NS, 'a'), false);
    assert.equal(shouldWarnOnce(NS, 'b'), false);
  });

  it('hasWarnedOnce reports membership without recording', () => {
    assert.equal(hasWarnedOnce(NS, 'x'), false);
    assert.equal(hasWarnedOnce(NS, 'x'), false, 'has* must not record');
    assert.equal(shouldWarnOnce(NS, 'x'), true);
    assert.equal(hasWarnedOnce(NS, 'x'), true);
  });

  it('a "second module copy" sees the same registry (globalThis identity)', () => {
    // The whole point: the store lives on globalThis under Symbol.for, so a fresh
    // read through the same primitives (what a second CJS/ESM copy would do)
    // observes the already-recorded key.
    assert.equal(shouldWarnOnce(WARN_NS.unindexedRelation, 'users.posts'), true);
    const g = globalThis as Record<symbol, unknown>;
    const store = g[Symbol.for('turbine.warnOnce.registry')] as Record<string, Set<string>>;
    assert.ok(store[WARN_NS.unindexedRelation]?.has('users.posts'), 'key lives on the shared globalThis store');
    assert.equal(shouldWarnOnce(WARN_NS.unindexedRelation, 'users.posts'), false, 'second copy must not re-warn');
  });

  it('bounded at WARN_ONCE_CAP, stops recording and warning past the cap', () => {
    for (let i = 0; i < WARN_ONCE_CAP; i++) {
      assert.equal(shouldWarnOnce(NS, `k${i}`), true);
    }
    // Cap reached: a brand-new key no longer warns (bounded growth, no re-warn).
    assert.equal(shouldWarnOnce(NS, 'overflow'), false);
    assert.equal(hasWarnedOnce(NS, 'overflow'), false);
  });

  it('resetWarnOnce(ns) re-enables just that namespace', () => {
    assert.equal(shouldWarnOnce(NS, 'a'), true);
    assert.equal(shouldWarnOnce('other', 'a'), true);
    resetWarnOnce(NS);
    assert.equal(shouldWarnOnce(NS, 'a'), true, 'reset ns re-enables it');
    assert.equal(shouldWarnOnce('other', 'a'), false, 'other ns untouched');
  });
});
