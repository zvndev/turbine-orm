import { DatabaseSync } from 'node:sqlite';
import { defineSchema, generate, schemaDefToMetadata } from 'turbine-orm';
import { introspectSqliteDatabase } from 'turbine-orm/sqlite';
import { tables } from './schema.js';

// Run from the project root after building the library:
// npx tsx examples/sqlite-generated/generate.ts [existing.sqlite]
// With a path, read an existing database; otherwise use the code-first schema.
const path = process.argv[2];
const handle = path === undefined ? undefined : new DatabaseSync(path, { readOnly: true });
try {
  generate({
    schema: handle ? introspectSqliteDatabase(handle) : schemaDefToMetadata(defineSchema(tables)),
    target: 'sqlite',
    outDir: './examples/sqlite-generated/generated',
    noTimestamp: true,
    importExtension: 'js',
  });
} finally {
  handle?.close();
}
