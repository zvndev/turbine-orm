/**
 * `turbine observe` reads its metrics database from `--metrics-url`, falling
 * back to TURBINE_OBSERVE_URL. The flag used to be accepted and ignored, so the
 * command refused to start with the URL right there on the command line.
 *
 * Both runs point at a port nothing listens on, so neither starts a server:
 * the run that found a URL fails CONNECTING, the run that found none fails
 * before connecting and says what it needs.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { makeProject } from './codegen-cli-fixture.js';

const DEAD_URL = 'postgres://127.0.0.1:1/turbine_observe_test';

describe('turbine observe --metrics-url', () => {
  const project = makeProject('observe-url');
  after(() => project.cleanup());

  it('uses the flag when TURBINE_OBSERVE_URL is unset', () => {
    const run = project.cli(['observe', '--metrics-url', DEAD_URL, '--no-open'], { TURBINE_OBSERVE_URL: '' });
    assert.equal(run.status, 1, run.output);
    assert.doesNotMatch(run.output, /needs the metrics database/, 'the flag was ignored');
    assert.match(run.output, /Failed to start Observe/);
  });

  it('still names both sources when neither is given', () => {
    const run = project.cli(['observe', '--no-open'], { TURBINE_OBSERVE_URL: '' });
    assert.equal(run.status, 1, run.output);
    assert.match(run.output, /pass --metrics-url or set TURBINE_OBSERVE_URL/);
  });
});
