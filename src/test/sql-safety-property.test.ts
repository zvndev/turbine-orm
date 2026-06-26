/**
 * SQL safety — adversarial injection corpus (table-driven).
 *
 * NOTE: despite the file name, this is NOT a property/fuzz test — there is no
 * random input generation. It is a fixed, hand-curated corpus of known
 * SQL-injection payloads iterated in a loop (a table-driven / parameterized
 * test). Each payload is fed through the query builder and we assert the
 * builder never string-interpolates it: the raw payload must not appear in the
 * generated SQL, and the value must instead show up in the `$N` params array.
 *
 * To strengthen coverage, add more real-world payloads to INJECTION_PAYLOADS —
 * keep it a deterministic, fixed list (do not add random generation, which
 * would make failures non-reproducible). Avoid payloads that are legitimate
 * substrings of the emitted SQL (e.g. a bare `$1` or `"users"`), since the
 * "payload must not appear in SQL" assertion would then false-positive.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

const schema: SchemaMetadata = {
  tables: {
    users: mockTable('users', [
      { name: 'id', field: 'id' },
      { name: 'name', field: 'name', pgType: 'text' },
      { name: 'email', field: 'email', pgType: 'text' },
      { name: 'age', field: 'age' },
      { name: 'bio', field: 'bio', pgType: 'text' },
    ]),
  },
  enums: {},
};

const INJECTION_PAYLOADS = [
  "'; DROP TABLE users; --",
  "1; DELETE FROM users WHERE '1'='1",
  "' OR '1'='1",
  "'; EXEC xp_cmdshell('dir'); --",
  "1' UNION SELECT * FROM information_schema.tables --",
  "Robert'); DROP TABLE students;--",
  "' OR 1=1 --",
  "admin'--",
  '1 OR 1=1',
  "' WAITFOR DELAY '0:0:5' --",
  "'; COPY users TO '/tmp/pwned'; --",
  '$$malicious$$',
  "E'\\x41'",
  'chr(65)||chr(66)',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional template-like string to test SQL injection resistance
  '${process.env.SECRET}',
  '{{7*7}}',
  '`id`',
  '"id"; DROP TABLE users;',
  '\0',
  '\n; DROP TABLE users;',
  "' AND EXTRACTVALUE(1,CONCAT(0x7e,(SELECT version()))) --",
  // Postgres-specific time-based / stacked-query probes
  "'; SELECT pg_sleep(5); --",
  "' OR pg_sleep(5)='",
  "'); SELECT pg_sleep(5)--",
  // Comment-obfuscated boolean bypass
  "'/**/OR/**/1=1--",
  "' OR 'a'='a' /*",
  // Nested-parenthesis bypass
  '1)) OR ((1=1',
  // Backslash-escaped quote attempt
  "\\'; DROP TABLE users; --",
  // URL-encoded ' OR 1=1
  '%27%20OR%201=1',
  // UNION column-count probe
  "' UNION SELECT NULL,NULL,NULL--",
  // Boolean blind injection
  "' AND 1=CAST((SELECT current_user) AS int)--",
  Array(10000).fill('A').join(''),
];

describe('SQL safety — adversarial injection corpus (table-driven)', () => {
  it('user values never appear unparameterized in WHERE SQL', () => {
    const q = makeQuery('users', schema);

    for (const payload of INJECTION_PAYLOADS) {
      const deferred = q.buildFindMany({
        where: { name: payload, email: payload } as never,
      });

      assert.ok(!deferred.sql.includes(payload), `Payload leaked into SQL: ${payload.slice(0, 50)}`);
      assert.ok(deferred.sql.includes('$1'), 'Should use parameterized placeholders');
      assert.ok(deferred.params.includes(payload), 'Payload should be in params array');
    }
  });

  it('user values never appear unparameterized in UPDATE SET SQL', () => {
    const q = makeQuery('users', schema);

    for (const payload of INJECTION_PAYLOADS) {
      const deferred = q.buildUpdate({
        where: { id: 1 } as never,
        data: { name: payload, bio: payload } as never,
      });

      assert.ok(!deferred.sql.includes(payload), `Payload leaked into UPDATE SQL: ${payload.slice(0, 50)}`);
      assert.ok(deferred.params.includes(payload));
    }
  });

  it('user values never appear unparameterized in CREATE SQL', () => {
    const q = makeQuery('users', schema);

    for (const payload of INJECTION_PAYLOADS) {
      const deferred = q.buildCreate({
        data: { name: payload, email: payload } as never,
      });

      assert.ok(!deferred.sql.includes(payload), `Payload leaked into CREATE SQL: ${payload.slice(0, 50)}`);
      assert.ok(deferred.params.includes(payload));
    }
  });

  it('LIKE patterns are properly escaped', () => {
    const q = makeQuery('users', schema);
    const likePayloads = ['%admin%', '_root_', '\\escape', '100% safe', 'test_%_value'];

    for (const payload of likePayloads) {
      const deferred = q.buildFindMany({
        where: { name: { contains: payload } } as never,
      });

      assert.ok(!deferred.sql.includes(payload), `LIKE payload leaked: ${payload}`);
      const paramWithEscape = deferred.params.find(
        (p) => typeof p === 'string' && p.includes(payload.replace(/%/g, '\\%').replace(/_/g, '\\_')),
      );
      assert.ok(paramWithEscape !== undefined, `Escaped payload should be in params for: ${payload}`);
    }
  });

  it('param count matches $N placeholders', () => {
    const q = makeQuery('users', schema);

    const deferred = q.buildFindMany({
      where: {
        name: 'test',
        email: { contains: 'foo' },
        age: { gt: 18 },
      } as never,
    });

    const placeholders = deferred.sql.match(/\$\d+/g) || [];
    const maxPlaceholder = Math.max(...placeholders.map((p) => parseInt(p.slice(1), 10)));
    assert.equal(
      maxPlaceholder,
      deferred.params.length,
      `Max placeholder $${maxPlaceholder} should match params length ${deferred.params.length}`,
    );
  });

  it('identifiers are quoted to prevent injection via field names', () => {
    const q = makeQuery('users', schema);
    const deferred = q.buildFindMany({
      where: { name: 'safe' } as never,
      orderBy: { name: 'asc' } as never,
    });

    assert.ok(deferred.sql.includes('"name"'), 'Column names should be double-quoted');
    assert.ok(deferred.sql.includes('"users"'), 'Table name should be double-quoted');
  });
});
