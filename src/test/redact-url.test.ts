/**
 * `redactUrl()`: credential scrubbing for anything the CLI prints.
 *
 * The behavioral cases mirror the ones in cli.test.ts (they must stay true
 * verbatim: this function is the last line of defense before a password reaches
 * a terminal or a log). The timing case is the new one: the previous userinfo
 * pattern nested two lazy quantifiers under a lookahead and backtracked
 * quadratically on input containing no `@` at all (5 KB ~ 111ms, 20 KB ~ 1.7s,
 * 60 KB ~ 16.5s). `redactUrl` is applied to Postgres error text, which echoes
 * the offending value, so a large value stalled the CLI.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { redactUrl } from '../cli/ui.js';

describe('redactUrl(): redaction is unchanged', () => {
  const cases: Array<[string, string]> = [
    ['postgres://user:secret_password@localhost:5432/mydb', 'postgres://user:***@localhost:5432/mydb'],
    ['postgres://localhost:5432/mydb', 'postgres://localhost:5432/mydb'],
    ['', ''],
    [
      'primary=postgres://u1:secret1@a:5432/db replica=postgres://u2:secret2@b:5432/db',
      'primary=postgres://u1:***@a:5432/db replica=postgres://u2:***@b:5432/db',
    ],
    [
      'postgres://host:5432/db?sslmode=require&password=hunter2&application_name=app',
      'postgres://host:5432/db?sslmode=require&password=***&application_name=app',
    ],
    ['postgres://host/db?SSLPassword=abc123&PassWord=def456', 'postgres://host/db?SSLPassword=***&PassWord=***'],
    ['postgres://localhost:5432/mydb?sslmode=require', 'postgres://localhost:5432/mydb?sslmode=require'],
    // Passwords containing /, :, and @ (the shapes a naive character class misses).
    ['postgres://u:pa/ss@host/db', 'postgres://u:***@host/db'],
    ['postgres://u:a@b@host/db', 'postgres://u:***@host/db'],
    ['postgres://u:pa:ss@host/db', 'postgres://u:***@host/db'],
    // Userinfo with no password, and plain non-URL text, are left alone.
    ['postgres://user@host/db', 'postgres://user@host/db'],
    ['error: relation "users" does not exist', 'error: relation "users" does not exist'],
    // A password with a URL-ish tail must not leak through the authority scan.
    ['postgres://admin:p@ssw0rd!@host:5432/db', 'postgres://admin:***@host:5432/db'],
  ];

  for (const [input, expected] of cases) {
    it(`redacts ${JSON.stringify(input).slice(0, 64)}`, () => {
      assert.equal(redactUrl(input), expected);
    });
  }

  it('redacts a credential embedded in a longer error message', () => {
    const msg = 'connection to postgres://u:s3cr3t@db.internal:5432/app failed: timeout';
    assert.equal(redactUrl(msg), 'connection to postgres://u:***@db.internal:5432/app failed: timeout');
  });
});

describe('redactUrl(): runs in linear time', () => {
  // Each of these took seconds under the backtracking pattern; the scan version
  // is a single pass, so a generous ceiling still fails loudly on a regression.
  const pathological: Array<[string, string]> = [
    ['no @ at all', `postgres://u:${'a'.repeat(60_000)}`],
    ['colon-heavy authority', `postgres://${'u:'.repeat(30_000)}`],
    ['many scheme prefixes', 'x://'.repeat(15_000)],
  ];

  for (const [label, input] of pathological) {
    it(`handles a 60KB ${label} input well under a second`, () => {
      const started = process.hrtime.bigint();
      redactUrl(input);
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      assert.ok(elapsedMs < 500, `took ${elapsedMs.toFixed(1)}ms`);
    });
  }
});
