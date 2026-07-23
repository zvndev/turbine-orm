/**
 * turbine-orm: Unique-FK → one-to-one (hasOne) introspection flip (F2)
 *
 * Unit tests for the pure detection + naming core: a child relation whose FK
 * column set is EXACTLY covered by a unique constraint or a plain (non-partial,
 * non-expression) unique index is emitted on the parent side as `hasOne`
 * (to-one) instead of `hasMany`, and named with the SINGULAR of the child table.
 *
 * Run: npx tsx --test src/test/introspect-has-one.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildRelationsFromForeignKeys,
  detectUniqueForeignKeySets,
  type ForeignKeyEntry,
  parsePlainUniqueIndexColumns,
} from '../introspect.js';
import type { IndexMetadata } from '../schema.js';

function fk(
  sourceTable: string,
  sourceColumns: string[],
  targetTable: string,
  targetColumns: string[],
  constraintName: string,
): ForeignKeyEntry {
  return { sourceTable, sourceColumns, targetTable, targetColumns, constraintName };
}

function idx(name: string, columns: string[], definition: string): IndexMetadata {
  return { name, columns, unique: true, definition };
}

/** camelCase column fields per table (relations must never shadow these). */
function fields(map: Record<string, string[]>): Map<string, Set<string>> {
  return new Map(Object.entries(map).map(([t, cols]) => [t, new Set(cols)]));
}

describe('parsePlainUniqueIndexColumns', () => {
  it('extracts columns from a plain unique index', () => {
    assert.deepEqual(
      parsePlainUniqueIndexColumns('CREATE UNIQUE INDEX profiles_user_id_key ON public.profiles USING btree (user_id)'),
      ['user_id'],
    );
  });

  it('unquotes quoted identifiers', () => {
    assert.deepEqual(parsePlainUniqueIndexColumns('CREATE UNIQUE INDEX x ON t USING btree ("userId", "orgId")'), [
      'userId',
      'orgId',
    ]);
  });

  it('strips ASC/DESC and NULLS ordering', () => {
    assert.deepEqual(
      parsePlainUniqueIndexColumns('CREATE UNIQUE INDEX x ON t USING btree (a ASC, b DESC NULLS LAST)'),
      ['a', 'b'],
    );
  });

  it('rejects a partial index (WHERE clause)', () => {
    assert.equal(
      parsePlainUniqueIndexColumns('CREATE UNIQUE INDEX x ON t USING btree (user_id) WHERE (deleted_at IS NULL)'),
      null,
    );
  });

  it('rejects an expression index (function call)', () => {
    assert.equal(parsePlainUniqueIndexColumns('CREATE UNIQUE INDEX x ON t USING btree (lower(email))'), null);
  });

  it('does not mistake a partial index WHERE parens for the column list', () => {
    // The greedy /\((.+)\)/ regex would grab "user_id) WHERE (deleted_at IS NULL";
    // the USING-anchored parser rejects it as partial.
    assert.equal(
      parsePlainUniqueIndexColumns('CREATE UNIQUE INDEX x ON t USING btree (user_id) WHERE (deleted_at IS NULL)'),
      null,
    );
  });
});

describe('detectUniqueForeignKeySets', () => {
  it('assembles PK, unique constraints, and plain unique indexes', () => {
    const sets = detectUniqueForeignKeySets(
      new Map([['profiles', ['id']]]),
      new Map([['profiles', [['org_id']]]]),
      new Map([
        [
          'profiles',
          [
            idx(
              'profiles_user_id_key',
              ['user_id'],
              'CREATE UNIQUE INDEX profiles_user_id_key ON t USING btree (user_id)',
            ),
          ],
        ],
      ]),
    );
    const profileSets = sets.get('profiles') ?? [];
    assert.ok(profileSets.some((s) => s.length === 1 && s[0] === 'id'));
    assert.ok(profileSets.some((s) => s.length === 1 && s[0] === 'org_id'));
    assert.ok(profileSets.some((s) => s.length === 1 && s[0] === 'user_id'));
  });

  it('skips a non-unique index', () => {
    const sets = detectUniqueForeignKeySets(
      new Map(),
      new Map(),
      new Map([
        ['t', [{ name: 'i', columns: ['a'], unique: false, definition: 'CREATE INDEX i ON t USING btree (a)' }]],
      ]),
    );
    assert.equal(sets.get('t'), undefined);
  });
});

describe('buildRelationsFromForeignKeys: hasOne flip', () => {
  it('flips a single-column unique FK to hasOne, singular-named', () => {
    const fks = [fk('profiles', ['user_id'], 'users', ['id'], 'profiles_user_id_fkey')];
    const uniqueSets = new Map([['profiles', [['user_id']]]]);
    const rel = buildRelationsFromForeignKeys(
      fks,
      fields({ profiles: ['id', 'userId'], users: ['id'] }),
      undefined,
      undefined,
      uniqueSets,
    );
    // parent side: users.profile (hasOne, singular of "profiles")
    const users = rel.get('users') ?? {};
    assert.equal(users.profile?.type, 'hasOne');
    assert.equal(users.profile?.to, 'profiles');
    assert.equal(users.profile?.foreignKey, 'user_id');
    // child side unchanged: profiles.user (belongsTo)
    assert.equal(rel.get('profiles')?.user?.type, 'belongsTo');
  });

  it('keeps hasMany when no unique set is passed (opt-out / legacy)', () => {
    const fks = [fk('profiles', ['user_id'], 'users', ['id'], 'profiles_user_id_fkey')];
    const rel = buildRelationsFromForeignKeys(fks, fields({ profiles: ['id', 'userId'], users: ['id'] }));
    const users = rel.get('users') ?? {};
    assert.equal(users.profiles?.type, 'hasMany');
    assert.equal(users.profile, undefined);
  });

  it('flips a composite FK only on an exact composite unique match', () => {
    const fks = [fk('memberships', ['org_id', 'user_id'], 'orgs', ['org_id', 'user_id'], 'memberships_fk')];
    const uniqueSets = new Map([['memberships', [['user_id', 'org_id']]]]); // order-insensitive
    const rel = buildRelationsFromForeignKeys(
      fks,
      fields({ memberships: ['id', 'orgId', 'userId'], orgs: ['orgId', 'userId'] }),
      undefined,
      undefined,
      uniqueSets,
    );
    const orgs = rel.get('orgs') ?? {};
    const reverse = Object.values(orgs)[0];
    assert.equal(reverse?.type, 'hasOne');
  });

  it('does NOT flip when the unique set is a superset of the FK columns', () => {
    const fks = [fk('profiles', ['user_id'], 'users', ['id'], 'profiles_user_id_fkey')];
    // unique on (user_id, tenant_id) does not guarantee one row per user_id.
    const uniqueSets = new Map([['profiles', [['user_id', 'tenant_id']]]]);
    const rel = buildRelationsFromForeignKeys(
      fks,
      fields({ profiles: ['id', 'userId', 'tenantId'], users: ['id'] }),
      undefined,
      undefined,
      uniqueSets,
    );
    const users = rel.get('users') ?? {};
    assert.equal(users.profiles?.type, 'hasMany');
  });

  it('falls back to the legacy plural name when the singular collides with a column', () => {
    // users already has a scalar column field "profile" → singular candidate is
    // taken, so the flip keeps the legacy plural relation name "profiles".
    const fks = [fk('profiles', ['user_id'], 'users', ['id'], 'profiles_user_id_fkey')];
    const uniqueSets = new Map([['profiles', [['user_id']]]]);
    const rel = buildRelationsFromForeignKeys(
      fks,
      fields({ profiles: ['id', 'userId'], users: ['id', 'profile'] }),
      undefined,
      undefined,
      uniqueSets,
    );
    const users = rel.get('users') ?? {};
    assert.equal(users.profiles?.type, 'hasOne'); // legacy plural kept, still flipped to hasOne
    assert.equal(users.profile, undefined); // the scalar column "profile" was never shadowed
  });
});
