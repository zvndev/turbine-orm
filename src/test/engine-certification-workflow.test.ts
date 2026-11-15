import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const workflow = readFileSync(new URL('../../.github/workflows/nightly.yml', import.meta.url), 'utf8');

function candidateJob(source: string) {
  const body = /^ {2}yugabytedb-integration:\n([\s\S]*?)(?=^ {2}[a-z][\w-]*:|$(?![\s\S]))/m.exec(source)?.[1];
  assert.ok(body, 'missing candidate job');
  return body;
}

function assertCandidateWorkflow(source: string) {
  const body = candidateJob(source);
  assert.match(body, /if: github.event_name == 'schedule'/);
  assert.doesNotMatch(body, /continue-on-error:|^ {4}services:/m);
  for (const command of ['init', 'run', 'finalize']) {
    assert.ok(body.includes(`run: node scripts/yugabyte-readiness.mjs ${command}\n`), `missing evidence ${command}`);
  }
  assert.match(body, /TURBINE_REQUIRE_ENGINE: postgres/);
  assert.match(body, /TURBINE_TEST_ENGINE: yugabytedb/);
  assert.match(body, /if: always\(\)\n {8}run: node scripts\/yugabyte-readiness.mjs finalize/);
  assert.match(body, /if: always\(\)\n {8}uses: actions\/upload-artifact@/);
  assert.match(body, /path: artifacts\/yugabytedb\//);
  assert.match(body, /if-no-files-found: error/);
}

describe('nightly candidate workflow evidence survives ordinary failure', () => {
  it('launches after checkout and preserves validated evidence without advisory suppression', () => {
    assertCandidateWorkflow(workflow);
    const body = candidateJob(workflow);
    assert.ok(body.indexOf('actions/checkout@') < body.indexOf('yugabyte-readiness.mjs run'));
    assert.ok(body.indexOf('yugabyte-readiness.mjs init') < body.indexOf('run: npm ci'));
  });

  it('rejects weakened finalization, artifact persistence and required-engine controls', () => {
    assert.throws(() => assertCandidateWorkflow(workflow.replaceAll('if: always()', 'if: success()')), /always/);
    assert.throws(
      () => assertCandidateWorkflow(workflow.replace('TURBINE_REQUIRE_ENGINE: postgres', '')),
      /REQUIRE_ENGINE/,
    );
    assert.throws(() => assertCandidateWorkflow(workflow.replace('if-no-files-found: error', '')), /files-found/);
    assert.throws(
      () => assertCandidateWorkflow(workflow.replace('  yugabytedb-integration:', '  wrong-job:')),
      /missing/,
    );
    assert.throws(
      () =>
        assertCandidateWorkflow(workflow.replace('    name: yugabytedb-integration', '    continue-on-error: true')),
      /continue-on-error/,
    );
  });
});
