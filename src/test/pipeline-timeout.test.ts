/**
 * The pipeline timeout path must reject with the same typed error the
 * transaction timeout path does.
 *
 * `pipeline({ timeout })` used to reject with a bare `new Error()`, so it
 * carried no `.code`, no `.docsUrl`, and failed `instanceof TurbineError`,
 * while `$transaction({ timeout })` raised `TimeoutError` (E002) for the same
 * condition. Two timeout paths on one client disagreed about their own
 * contract.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { TimeoutError, TurbineError, TurbineErrorCode } from '../errors.js';

describe('pipeline timeout error shape', () => {
  it('constructs a TimeoutError carrying the E002 contract', () => {
    // Pins the shape the pipeline path must produce, so the assertion below
    // is about the contract rather than about one call site's wording.
    // Deliberately NOT asserting the message text: STABILITY.md declares
    // message text non-contract, the code tag and .docsUrl are the stable parts.
    const err = new TimeoutError(5000, 'Pipeline');
    assert.ok(err instanceof TurbineError, 'must be a TurbineError');
    assert.equal(err.code, TurbineErrorCode.TIMEOUT);
    assert.equal(err.timeoutMs, 5000);
    assert.match(err.docsUrl, /errors#e002$/);
  });

  it('the pipeline module raises TimeoutError, not a bare Error, on timeout', () => {
    // Source assertion because driving a real wire-protocol timeout in a unit
    // test needs a live socket; the integration suite covers the runtime path.
    const sourceUrl = new URL('../pipeline-submittable.ts', import.meta.url);
    const src = readFileSync(sourceUrl, 'utf8');

    // Anti-vacuous: an empty or unresolved read would make doesNotMatch pass
    // while testing nothing. Prove the file was actually found first.
    assert.ok(src.length > 0, `read no content from ${sourceUrl.pathname}`);
    assert.match(src, /runPipelined/, 'read the wrong file; this is not pipeline-submittable.ts');

    assert.doesNotMatch(
      src,
      /pipelineError = new Error\(/,
      'the timeout branch must construct a TimeoutError, not a bare Error',
    );
    assert.match(src, /pipelineError = new TimeoutError\(/, 'the timeout branch must construct a TimeoutError');
  });
});
