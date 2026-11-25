/**
 * A self-contained fixture for the prisma-compat parity suites: the shape a
 * typical Prisma schema produces, on a real Postgres.
 *
 * Four tables under a caller-chosen prefix (so suites never share rows):
 * `<p>_workspace` (text cuid id, unique slug, a `timestamp(3)` created/updated
 * pair), `<p>_member` and `<p>_label` (to-many children), and `<p>_profile` (a
 * to-one child on a unique foreign key). The Prisma map names them Workspace /
 * Member / Label / Profile with Prisma's client defaults: `cuid()` ids,
 * `@default(now())` and `@updatedAt`.
 *
 * Not a test file (no `.test.ts`), so the runner never executes it directly.
 */

import { TurbineClient } from '../client.js';
import { introspect } from '../introspect.js';
import type { PrismaCompatMap, RelationDef, SchemaMetadata } from '../schema.js';

export interface ParityFixture {
  db: TurbineClient;
  schema: SchemaMetadata;
  map: PrismaCompatMap;
  tables: { workspace: string; member: string; label: string; profile: string };
  /** Insert a workspace through core, with an explicit id, and return its id. */
  seedWorkspace(name?: string): Promise<{ id: string; name: string; slug: string }>;
  /** Drop the fixture tables and close the client. */
  teardown(): Promise<void>;
}

let seq = 0;

export async function setupParityFixture(url: string, prefix: string): Promise<ParityFixture> {
  const tables = {
    workspace: `${prefix}_workspace`,
    member: `${prefix}_member`,
    label: `${prefix}_label`,
    profile: `${prefix}_profile`,
  };
  const drop = `DROP TABLE IF EXISTS ${tables.profile}, ${tables.label}, ${tables.member}, ${tables.workspace} CASCADE`;
  const admin = new TurbineClient({ connectionString: url }, { enums: {}, tables: {} });
  for (const stmt of [
    drop,
    `CREATE TABLE ${tables.workspace} (
       id         text PRIMARY KEY,
       name       text NOT NULL,
       slug       text NOT NULL UNIQUE,
       created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at timestamp(3) NOT NULL
     )`,
    `CREATE TABLE ${tables.member} (
       id           text PRIMARY KEY,
       workspace_id text NOT NULL REFERENCES ${tables.workspace}(id) ON DELETE CASCADE,
       role         text NOT NULL,
       created_at   timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`,
    `CREATE TABLE ${tables.label} (
       id           text PRIMARY KEY,
       workspace_id text NOT NULL REFERENCES ${tables.workspace}(id) ON DELETE CASCADE,
       name         text NOT NULL,
       color        text
     )`,
    `CREATE TABLE ${tables.profile} (
       id           text PRIMARY KEY,
       workspace_id text NOT NULL UNIQUE REFERENCES ${tables.workspace}(id) ON DELETE CASCADE,
       bio          text
     )`,
  ]) {
    await admin.rawUnsafe(stmt);
  }
  await admin.disconnect();

  const full = await introspect({ connectionString: url });
  // Only this fixture's tables: other suites' tables come and go concurrently.
  const schema: SchemaMetadata = {
    ...full,
    tables: Object.fromEntries(Object.entries(full.tables).filter(([name]) => name.startsWith(`${prefix}_`))),
  };
  const db = new TurbineClient({ connectionString: url }, schema);
  const relTo = (table: string, to: string): string => {
    const found = Object.entries(schema.tables[table]?.relations ?? {}).find(
      ([, r]: [string, RelationDef]) => r.to === to,
    );
    if (!found) throw new Error(`fixture: no relation from ${table} to ${to}`);
    return found[0];
  };
  const accessor = (table: string) => table.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
  const map: PrismaCompatMap = {
    enums: {},
    models: {
      Workspace: {
        table: tables.workspace,
        accessor: accessor(tables.workspace),
        fields: { id: 'id', name: 'name', slug: 'slug', createdAt: 'createdAt', updatedAt: 'updatedAt' },
        relations: {
          members: { name: relTo(tables.workspace, tables.member), cardinality: 'many' },
          labels: { name: relTo(tables.workspace, tables.label), cardinality: 'many' },
          profile: { name: relTo(tables.workspace, tables.profile), cardinality: 'one' },
        },
        compoundUniques: {},
        clientDefaults: { id: 'cuid', createdAt: 'now', updatedAt: 'updatedAt' },
      },
      Member: {
        table: tables.member,
        accessor: accessor(tables.member),
        fields: { id: 'id', workspaceId: 'workspaceId', role: 'role', createdAt: 'createdAt' },
        relations: { workspace: { name: relTo(tables.member, tables.workspace), cardinality: 'one' } },
        compoundUniques: {},
        clientDefaults: { id: 'cuid', createdAt: 'now' },
      },
      Label: {
        table: tables.label,
        accessor: accessor(tables.label),
        fields: { id: 'id', workspaceId: 'workspaceId', name: 'name', color: 'color' },
        relations: { workspace: { name: relTo(tables.label, tables.workspace), cardinality: 'one' } },
        compoundUniques: {},
        clientDefaults: { id: 'cuid' },
      },
      Profile: {
        table: tables.profile,
        accessor: accessor(tables.profile),
        fields: { id: 'id', workspaceId: 'workspaceId', bio: 'bio' },
        relations: { workspace: { name: relTo(tables.profile, tables.workspace), cardinality: 'one' } },
        compoundUniques: {},
        clientDefaults: { id: 'cuid' },
      },
    },
  };

  return {
    db,
    schema,
    map,
    tables,
    async seedWorkspace(name) {
      seq += 1;
      const row = { id: `w${seq}x${Date.now()}`, name: name ?? `W${seq}`, slug: `slug-${seq}-${Date.now()}` };
      await db.rawUnsafe(
        `INSERT INTO ${tables.workspace} (id, name, slug, updated_at) VALUES ($1, $2, $3, now())`,
        row.id,
        row.name,
        row.slug,
      );
      return row;
    },
    async teardown() {
      await db.rawUnsafe(drop);
      await db.disconnect();
    },
  };
}
