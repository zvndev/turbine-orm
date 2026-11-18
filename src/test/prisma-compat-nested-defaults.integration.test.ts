/**
 * prisma-compat nested writes on a real Postgres: client defaults (`cuid()`,
 * `@default(now())`, `@updatedAt`) on every nested row, nested `createMany`
 * (with and without `skipDuplicates`), and a to-one nested `upsert` without
 * `where`. Gated on `DATABASE_URL`.
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import { ValidationError } from '../errors.js';
import { createPrismaCompatClient } from '../prisma-compat.js';
import { skipGate } from './helpers.js';
import { type ParityFixture, setupParityFixture } from './prisma-parity-fixture.js';

const url = process.env.DATABASE_URL;
const { it, before, after } = skipGate(!url, 'DATABASE_URL not set');

const CUID = /^c[a-z0-9]{20,}$/;

describe('prisma-compat nested writes (real Postgres)', () => {
  let fx: ParityFixture;
  // biome-ignore lint/suspicious/noExplicitAny: dynamic compat client shape
  let compat: any;
  let n = 0;
  const slug = () => `nested-${++n}-${Date.now()}`;

  before(async () => {
    if (!url) return;
    fx = await setupParityFixture(url, 'nestdef');
    compat = createPrismaCompatClient(fx.db, fx.map);
  });

  after(async () => {
    if (fx) await fx.teardown();
  });

  const labelsOf = async (workspaceId: string) =>
    (await compat.label.findMany({ where: { workspaceId }, orderBy: { name: 'asc' } })).map(
      (l: { name: string }) => l.name,
    );

  it('nested create rows get cuid ids and app-clock timestamps, to-many and to-one', async () => {
    const before = Date.now();
    const w = await compat.workspace.create({
      data: {
        name: 'nested',
        slug: slug(),
        members: { create: [{ role: 'owner' }, { role: 'member' }] },
        profile: { create: { bio: 'hi' } },
      },
    });
    // A write without `include` returns its own row only, as in Prisma.
    assert.equal(w.members, undefined);
    assert.equal(w.profile, undefined);
    const members = await compat.member.findMany({ where: { workspaceId: w.id } });
    assert.equal(members.length, 2);
    for (const m of members) {
      assert.match(m.id, CUID);
      assert.ok(m.createdAt.getTime() >= before - 1 && m.createdAt.getTime() <= Date.now(), 'app clock');
    }
    assert.notEqual(members[0].id, members[1].id);
    assert.match((await compat.profile.findFirstOrThrow({ where: { workspaceId: w.id } })).id, CUID);
  });

  it('nested createMany writes its rows with defaults, in create and in update', async () => {
    const w = await compat.workspace.create({
      data: {
        name: 'cm',
        slug: slug(),
        labels: { createMany: { data: [{ name: 'Bug' }, { name: 'Feature', color: '#fff' }] } },
      },
    });
    assert.deepEqual(await labelsOf(w.id), ['Bug', 'Feature']);
    await compat.workspace.update({
      where: { id: w.id },
      data: { labels: { createMany: { data: { name: 'Docs' } } } },
    });
    assert.deepEqual(await labelsOf(w.id), ['Bug', 'Docs', 'Feature']);
    for (const l of await compat.label.findMany({ where: { workspaceId: w.id } })) assert.match(l.id, CUID);
  });

  it('nested createMany with skipDuplicates skips the colliding rows', async () => {
    const w = await fx.seedWorkspace('skip');
    await compat.workspace.update({
      where: { id: w.id },
      data: { labels: { createMany: { data: [{ id: `dup-${w.id}`, name: 'one' }] } } },
    });
    await compat.workspace.update({
      where: { id: w.id },
      data: {
        labels: {
          createMany: {
            data: [
              { id: `dup-${w.id}`, name: 'two' },
              { id: `new-${w.id}`, name: 'three' },
            ],
            skipDuplicates: true,
          },
        },
      },
    });
    assert.deepEqual(await labelsOf(w.id), ['one', 'three']);
  });

  it('nested createMany refuses a to-one relation and an unknown key', async () => {
    const w = await fx.seedWorkspace('refuse');
    await assert.rejects(
      compat.workspace.update({ where: { id: w.id }, data: { profile: { createMany: { data: [{ bio: 'x' }] } } } }),
      (err: unknown) => err instanceof ValidationError && /one-to-many/.test(err.message),
    );
    await assert.rejects(
      compat.workspace.update({ where: { id: w.id }, data: { labels: { createMany: { rows: [] } } } }),
      /unknown key "rows"/,
    );
  });

  it('connectOrCreate and upsert create branches get defaults; update branches touch @updatedAt', async () => {
    const w = await fx.seedWorkspace('branches');
    await compat.workspace.update({
      where: { id: w.id },
      data: {
        labels: {
          connectOrCreate: { where: { id: 'missing-label' }, create: { name: 'Docs' } },
          upsert: { where: { id: 'also-missing' }, create: { name: 'Ops' }, update: { name: 'Ops' } },
        },
        members: { create: { role: 'owner' } },
      },
    });
    assert.deepEqual(await labelsOf(w.id), ['Docs', 'Ops']);
    const parentBefore = await compat.workspace.findUniqueOrThrow({ where: { id: w.id } });
    await new Promise((r) => setTimeout(r, 5));
    const member = await compat.member.findFirstOrThrow({ where: { workspaceId: w.id } });
    await compat.member.update({
      where: { id: member.id },
      data: { workspace: { update: { name: 'renamed' } } },
    });
    const parentAfter = await compat.workspace.findUniqueOrThrow({ where: { id: w.id } });
    assert.equal(parentAfter.name, 'renamed');
    assert.ok(
      parentAfter.updatedAt.getTime() > parentBefore.updatedAt.getTime(),
      '@updatedAt touched on a nested update',
    );
  });

  it('a to-one nested upsert without where creates, then updates, the related row', async () => {
    const w = await fx.seedWorkspace('upsert');
    await compat.workspace.update({
      where: { id: w.id },
      data: { profile: { upsert: { create: { bio: 'first' }, update: { bio: 'never' } } } },
    });
    assert.equal((await compat.profile.findFirstOrThrow({ where: { workspaceId: w.id } })).bio, 'first');
    await compat.workspace.update({
      where: { id: w.id },
      data: { profile: { upsert: { create: { bio: 'never' }, update: { bio: 'second' } } } },
    });
    const profiles = await compat.profile.findMany({ where: { workspaceId: w.id } });
    assert.deepEqual(
      profiles.map((p: { bio: string }) => p.bio),
      ['second'],
    );
  });

  it('a belongsTo nested upsert without where updates the row the record points at', async () => {
    const w = await fx.seedWorkspace('bt');
    const m = await compat.member.create({ data: { workspaceId: w.id, role: 'owner' } });
    await compat.member.update({
      where: { id: m.id },
      data: { workspace: { upsert: { create: { name: 'never', slug: slug() }, update: { name: 'via-upsert' } } } },
    });
    assert.equal((await compat.workspace.findUniqueOrThrow({ where: { id: w.id } })).name, 'via-upsert');
  });

  it('a to-one nested update takes the data itself, without where', async () => {
    const w = await fx.seedWorkspace('to-one-update');
    await compat.profile.create({ data: { workspaceId: w.id, bio: 'before' } });
    await compat.workspace.update({ where: { id: w.id }, data: { profile: { update: { bio: 'after' } } } });
    assert.equal((await compat.profile.findFirstOrThrow({ where: { workspaceId: w.id } })).bio, 'after');
    await compat.workspace.update({ where: { id: w.id }, data: { profile: { update: { data: { bio: 'again' } } } } });
    assert.equal((await compat.profile.findFirstOrThrow({ where: { workspaceId: w.id } })).bio, 'again');
  });

  it('a to-many nested upsert still needs where', async () => {
    const w = await fx.seedWorkspace('many');
    await assert.rejects(
      compat.workspace.update({
        where: { id: w.id },
        data: { labels: { upsert: { create: { name: 'x' }, update: { name: 'y' } } } },
      }),
      /requires "where"/,
    );
  });

  it('core: nested createMany and the to-one upsert / update without where, on the core client', async () => {
    const w = await fx.seedWorkspace('core');
    const labels = fx.map.models.Workspace!.relations.labels!.name;
    const profile = fx.map.models.Workspace!.relations.profile!.name;
    const table = fx.db.table(fx.tables.workspace);
    await table.update({
      where: { id: w.id },
      data: {
        [labels]: {
          createMany: {
            data: [
              { id: `c1-${w.id}`, name: 'core-a' },
              { id: `c2-${w.id}`, name: 'core-b' },
            ],
          },
        },
        [profile]: { upsert: { create: { id: `p-${w.id}`, bio: 'core' }, update: { bio: 'never' } } },
      },
    });
    assert.deepEqual(await labelsOf(w.id), ['core-a', 'core-b']);
    await table.update({ where: { id: w.id }, data: { [profile]: { update: { data: { bio: 'core-2' } } } } });
    assert.equal((await compat.profile.findFirstOrThrow({ where: { workspaceId: w.id } })).bio, 'core-2');
  });
});
