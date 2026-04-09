/**
 * Studio — unit tests for the read-only statement guard.
 *
 * These tests exist to lock down the first line of defense for the
 * `/api/query` endpoint. The second line of defense is the `BEGIN READ ONLY`
 * transaction wrapper at runtime. If either layer regresses, a destructive
 * query could run inside Studio — so both must be tested.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isReadOnlyStatement } from '../cli/studio.js';

describe('Studio — isReadOnlyStatement', () => {
  it('accepts plain SELECT', () => {
    assert.equal(isReadOnlyStatement('SELECT * FROM users'), true);
  });

  it('accepts lowercase SELECT', () => {
    assert.equal(isReadOnlyStatement('select 1'), true);
  });

  it('accepts WITH (CTE) queries', () => {
    assert.equal(isReadOnlyStatement('WITH t AS (SELECT 1) SELECT * FROM t'), true);
  });

  it('accepts SELECT with trailing semicolon', () => {
    assert.equal(isReadOnlyStatement('SELECT 1;'), true);
  });

  it('accepts SELECT with trailing whitespace + semicolon', () => {
    assert.equal(isReadOnlyStatement('SELECT 1 ;  '), true);
  });

  it('rejects empty input', () => {
    assert.equal(isReadOnlyStatement(''), false);
    assert.equal(isReadOnlyStatement('   '), false);
  });

  it('rejects INSERT', () => {
    assert.equal(isReadOnlyStatement('INSERT INTO users VALUES (1)'), false);
  });

  it('rejects UPDATE', () => {
    assert.equal(isReadOnlyStatement('UPDATE users SET name = $1'), false);
  });

  it('rejects DELETE', () => {
    assert.equal(isReadOnlyStatement('DELETE FROM users'), false);
  });

  it('rejects DROP', () => {
    assert.equal(isReadOnlyStatement('DROP TABLE users'), false);
  });

  it('rejects TRUNCATE', () => {
    assert.equal(isReadOnlyStatement('TRUNCATE users'), false);
  });

  it('rejects GRANT', () => {
    assert.equal(isReadOnlyStatement('GRANT ALL ON users TO public'), false);
  });

  it('rejects CREATE TABLE', () => {
    assert.equal(isReadOnlyStatement('CREATE TABLE x (id int)'), false);
  });

  it('rejects statement stacking (SELECT ; DROP)', () => {
    assert.equal(isReadOnlyStatement('SELECT 1; DROP TABLE users'), false);
  });

  it('rejects stacking hidden in line comment bypass', () => {
    // The stripper removes the comment first, so the stacking check still
    // catches the embedded DROP.
    assert.equal(isReadOnlyStatement('SELECT 1 -- harmless\n; DROP TABLE users'), false);
  });

  it('rejects stacking hidden in block comment bypass', () => {
    assert.equal(isReadOnlyStatement('SELECT 1 /* comment */ ; DELETE FROM users'), false);
  });

  it('rejects leading comment followed by DROP', () => {
    assert.equal(isReadOnlyStatement('-- innocent\nDROP TABLE users'), false);
  });

  it('rejects leading block comment followed by INSERT', () => {
    assert.equal(isReadOnlyStatement('/* look harmless */ INSERT INTO users VALUES (1)'), false);
  });

  it('accepts SELECT with inline comment', () => {
    assert.equal(isReadOnlyStatement('SELECT id -- the pk\nFROM users'), true);
  });

  it('accepts SELECT with block comment before it', () => {
    assert.equal(isReadOnlyStatement('/* summary query */ SELECT count(*) FROM users'), true);
  });
});
