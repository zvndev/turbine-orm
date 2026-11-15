import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { it } from 'node:test';

for (const required of ['postgres', 'mysql', 'postgres,mysql']) {
  it(`native public cancellation fails when required ${required} is absent`, () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL: '',
      MYSQL_URL: '',
      TURBINE_REQUIRE_ENGINE: required,
    };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--test', 'src/test/public-stream-signal.integration.test.ts'],
      {
        cwd: new URL('../../', import.meta.url),
        encoding: 'utf8',
        timeout: 20_000,
        env,
      },
    );
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /required|prerequisite|TURBINE_REQUIRE_ENGINE/i);
  });
}
