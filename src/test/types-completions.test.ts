/**
 * turbine-orm, editor completions inside an empty `with: {}`, `select: {}`
 * and `omit: {}`
 *
 * Runs the TypeScript language service (what an editor asks) over an
 * in-memory file and checks the property names it offers at each marker. A
 * plain `tsc` pass cannot see this: the args compile either way, and only the
 * completion list shows whether the editor knows the relation and field names
 * before the caller has typed one.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const probeFile = join(repoRoot, 'src', 'test', '__types-completions-probe.ts');

const PROBE = `
import type { QueryInterface, RelationDescriptor } from '../query/index.js';
interface User { id: number; email: string; name: string }
interface Post { id: number; title: string }
interface UserRelations {
  posts: RelationDescriptor<Post, 'many', {}, 'hasMany'>;
  profile: RelationDescriptor<Post, 'one', {}, 'hasOne'>;
}
declare const users: QueryInterface<User, UserRelations>;
users.findMany({ with: { /*withKeys*/ } });
users.findMany({ with: { posts: { /*withOptions*/ } } });
users.findMany({ select: { /*select*/ } });
users.findMany({ omit: { /*omit*/ } });
users.findMany({ with: { posts: { select: { /*nestedSelect*/ } } } });
users.findUnique({ where: { id: 1 }, select: { /*uniqueSelect*/ } });
users.findMany({ where: { /*where*/ } });
`;

function completions(): Map<string, string[]> {
  const configPath = join(repoRoot, 'tsconfig.json');
  const parsed = ts.parseJsonConfigFileContent(ts.readConfigFile(configPath, ts.sys.readFile).config, ts.sys, repoRoot);
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [probeFile],
    getScriptVersion: () => '1',
    getScriptSnapshot: (file) => {
      if (file === probeFile) return ts.ScriptSnapshot.fromString(PROBE);
      try {
        return ts.ScriptSnapshot.fromString(readFileSync(file, 'utf8'));
      } catch {
        return undefined;
      }
    },
    getCurrentDirectory: () => repoRoot,
    getCompilationSettings: () => parsed.options,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: (file) => file === probeFile || ts.sys.fileExists(file),
    readFile: (file) => (file === probeFile ? PROBE : ts.sys.readFile(file)),
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };
  const service = ts.createLanguageService(host);
  const out = new Map<string, string[]>();
  for (const match of PROBE.matchAll(/\/\*(\w+)\*\//g)) {
    const result = service.getCompletionsAtPosition(probeFile, match.index ?? 0, {});
    const names = (result?.entries ?? [])
      .filter((entry) => entry.kind === ts.ScriptElementKind.memberVariableElement)
      .map((entry) => entry.name)
      .sort();
    out.set(match[1] ?? '', names);
  }
  service.dispose();
  return out;
}

describe('types: editor completions', () => {
  const offered = completions();
  const fields = ['email', 'id', 'name'];

  it('offers the relation names inside an empty with', () => {
    assert.deepEqual(offered.get('withKeys'), ['_count', 'posts', 'profile']);
  });

  it('offers the relation options inside a relation entry', () => {
    const options = offered.get('withOptions') ?? [];
    for (const key of ['limit', 'omit', 'orderBy', 'select', 'where', 'with']) {
      assert.ok(options.includes(key), `missing ${key} in ${options.join(',')}`);
    }
  });

  it('offers the fields inside an empty select and omit', () => {
    assert.deepEqual(offered.get('select'), fields);
    assert.deepEqual(offered.get('omit'), fields);
    assert.deepEqual(offered.get('uniqueSelect'), fields);
  });

  it("offers the related table's fields inside a nested select", () => {
    assert.deepEqual(offered.get('nestedSelect'), ['id', 'title']);
  });

  it('still offers where keys', () => {
    const keys = offered.get('where') ?? [];
    for (const key of [...fields, 'AND', 'OR', 'NOT', 'posts']) assert.ok(keys.includes(key), `missing ${key}`);
  });
});
