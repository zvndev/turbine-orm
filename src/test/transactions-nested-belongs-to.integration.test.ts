/**
 * turbine-orm: nested writes on a belongsTo relation follow the to-one rules.
 *
 * A belongsTo relation is the single row a record points at through its own
 * foreign key. Several operations on it used to be accepted and then quietly
 * not done, or done differently:
 *   - `delete` did nothing at all;
 *   - `set` (a to-many operation) did nothing;
 *   - `connectOrCreate` inside update() did nothing;
 *   - `disconnect: false` and `disconnect: { where }` both disconnected;
 *   - combining create/connect/disconnect, or passing several items, kept one.
 * Now `delete` and `disconnect` behave as in Prisma (clear the foreign key;
 * `delete` also deletes the row pointed at, and both need a nullable key),
 * `connectOrCreate` works, and everything else is refused with E003.
 *
 * Fixture: users.org -> orgs (nullable), posts.author -> users (NOT NULL).
 *
 * Run: DATABASE_URL=postgres://... npx tsx --test src/test/transactions-nested-belongs-to.integration.test.ts
 */

import assert from 'node:assert/strict';
import { describe, beforeEach as eachTest } from 'node:test';
import type { TurbineClient } from '../client.js';
import { ForeignKeyError, NotFoundError, ValidationError } from '../errors.js';
import { skipGate } from './helpers.js';
import { DATABASE_URL, openFixture, type TxFixture } from './transactions-fixture.js';

const { it, before, after } = skipGate(!DATABASE_URL, 'DATABASE_URL not set');
const beforeEach: typeof eachTest = DATABASE_URL ? eachTest : () => {};

function refused(pattern: RegExp) {
  return (err: unknown): boolean => {
    assert.ok(err instanceof ValidationError, `expected ValidationError, got ${String(err)}`);
    assert.equal(err.code, 'TURBINE_E003');
    assert.match(err.message, pattern, err.message);
    return true;
  };
}

describe('transactions: belongsTo nested writes (live Postgres)', () => {
  let fx: TxFixture;
  let db: TurbineClient;
  type Row = Record<string, unknown>;
  const users = () => db.table<Row>(fx.t.users);
  const posts = () => db.table<Row>(fx.t.posts);
  const orgIdOf = async (userId: number) =>
    (await fx.raw.query(`SELECT org_id FROM ${fx.t.users} WHERE id = $1`, [userId])).rows[0]?.org_id as number | null;

  before(async () => {
    fx = await openFixture('tx90n');
    db = fx.client();
  });
  beforeEach(async () => {
    await fx.reset();
  });
  after(async () => {
    await fx?.close();
  });

  describe('delete', () => {
    it('delete: true clears the key and deletes the row pointed at', async () => {
      const result = await users().update({ where: { id: 2 }, data: { org: { delete: true } } });
      assert.equal(result.org, null);
      assert.equal(await orgIdOf(2), null);
      assert.equal(await fx.count(fx.t.orgs, "name = 'globex'"), 0, 'the org was deleted');
    });

    it('delete with a where that the connected row matches', async () => {
      await users().update({ where: { id: 1 }, data: { org: { delete: { name: 'acme' } } } });
      assert.equal(await fx.count(fx.t.orgs, "name = 'acme'"), 0);
    });

    it('delete with a where the connected row does not match is E001, and nothing changes', async () => {
      await assert.rejects(
        users().update({ where: { id: 1 }, data: { org: { delete: { name: 'globex' } } } }),
        NotFoundError,
      );
      assert.equal(await orgIdOf(1), 1);
      assert.equal(await fx.count(fx.t.orgs), 2);
    });

    it('delete when nothing is connected is E001', async () => {
      await assert.rejects(users().update({ where: { id: 3 }, data: { org: { delete: true } } }), NotFoundError);
    });

    it('delete of a row other records still point at is E009, and the key is restored', async () => {
      await fx.raw.query(`UPDATE ${fx.t.users} SET org_id = 1 WHERE id = 3`);
      await assert.rejects(users().update({ where: { id: 1 }, data: { org: { delete: true } } }), ForeignKeyError);
      assert.equal(await orgIdOf(1), 1, 'the whole nested write rolled back');
    });

    it('delete on a NOT NULL key is refused before anything runs', async () => {
      await assert.rejects(
        posts().update({ where: { id: 1 }, data: { author: { delete: true } } }),
        refused(/Cannot delete "author".*NOT NULL.*Connect it to a different/s),
      );
      assert.equal(await fx.count(fx.t.users, 'id = 1'), 1);
    });

    it('delete: false is a no-op', async () => {
      await users().update({ where: { id: 1 }, data: { org: { delete: false } } });
      assert.equal(await orgIdOf(1), 1);
    });
  });

  describe('disconnect', () => {
    it('disconnect: true clears the key and keeps the row', async () => {
      await users().update({ where: { id: 1 }, data: { org: { disconnect: true } } });
      assert.equal(await orgIdOf(1), null);
      assert.equal(await fx.count(fx.t.orgs, "name = 'acme'"), 1);
    });

    it('disconnect: {} is the connected row, as the docs spell it', async () => {
      await users().update({ where: { id: 1 }, data: { org: { disconnect: {} } } });
      assert.equal(await orgIdOf(1), null);
    });

    it('a selector whose fields are all undefined is refused, not read as the connected row', async () => {
      await assert.rejects(
        users().update({ where: { id: 1 }, data: { org: { delete: { id: undefined } } } }),
        refused(/requires a selector with at least one defined value/),
      );
      assert.equal(await orgIdOf(1), 1);
    });

    it('disconnect: false is a no-op', async () => {
      await users().update({ where: { id: 1 }, data: { org: { disconnect: false } } });
      assert.equal(await orgIdOf(1), 1);
    });

    it('disconnect with a where the connected row does not match is E001', async () => {
      await assert.rejects(
        users().update({ where: { id: 1 }, data: { org: { disconnect: { name: 'globex' } } } }),
        NotFoundError,
      );
      assert.equal(await orgIdOf(1), 1);
    });

    it('disconnect on a NOT NULL key names connect, not delete', async () => {
      await assert.rejects(
        posts().update({ where: { id: 1 }, data: { author: { disconnect: true } } }),
        (err: unknown) => {
          refused(/Cannot disconnect "author".*NOT NULL/s)(err);
          assert.doesNotMatch((err as Error).message, /Use delete instead/);
          return true;
        },
      );
    });
  });

  describe('connectOrCreate in update()', () => {
    it('creates the row when missing and points at it', async () => {
      await users().update({
        where: { id: 3 },
        data: { org: { connectOrCreate: { where: { name: 'initech' }, create: { name: 'initech' } } } },
      });
      const r = await fx.raw.query(
        `SELECT o.name FROM ${fx.t.users} u JOIN ${fx.t.orgs} o ON o.id = u.org_id WHERE u.id = 3`,
      );
      assert.equal(r.rows[0]?.name, 'initech');
    });

    it('connects to the existing row', async () => {
      await users().update({
        where: { id: 3 },
        data: { org: { connectOrCreate: { where: { name: 'acme' }, create: { name: 'acme' } } } },
      });
      assert.equal(await orgIdOf(3), 1);
      assert.equal(await fx.count(fx.t.orgs), 2);
    });
  });

  describe('refused shapes', () => {
    it('set on a belongsTo', async () => {
      await assert.rejects(
        users().update({ where: { id: 1 }, data: { org: { set: [{ id: 2 }] } } as never }),
        refused(/Nested set on "org" is not supported.*connect.*disconnect/s),
      );
      assert.equal(await orgIdOf(1), 1);
    });

    it('two pointer operations in one write', async () => {
      await assert.rejects(
        users().update({ where: { id: 1 }, data: { org: { connect: { id: 2 }, disconnect: true } } }),
        refused(/combines connect and disconnect/),
      );
      await assert.rejects(
        posts().create({ data: { title: 'x', author: { create: { email: 'new@x' }, connect: { id: 1 } } } }),
        refused(/combines create and connect/),
      );
      assert.equal(await fx.count(fx.t.users, "email = 'new@x'"), 0);
    });

    it('several items for a single row', async () => {
      await assert.rejects(
        posts().create({ data: { title: 'x', author: { connect: [{ id: 1 }, { id: 2 }] } } as never }),
        refused(/received 2 items.*single/s),
      );
      // One item in an array is still accepted.
      const created = await posts().create({ data: { title: 'one', author: { connect: [{ id: 2 }] } } as never });
      assert.equal((created as { userId: number }).userId, 2);
    });
  });
});
