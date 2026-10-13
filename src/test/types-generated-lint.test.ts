/**
 * turbine-orm, generated client passes strict lint configs: no class and
 * interface share a name
 *
 * A class plus a same-named interface is declaration merging, and
 * `@typescript-eslint/no-unsafe-declaration-merging` (in typescript-eslint's
 * recommended config) rejects it: the interface can declare members the class
 * never implements, and the compiler takes them on trust. Generated code is
 * linted by the project that owns it, so it has to pass that project's rules.
 *
 * typescript-eslint is not a dependency here, so this asserts the structure
 * the rule checks, through the TypeScript parser: in each generated file, no
 * class shares its name with an interface (or a type alias, which would be a
 * duplicate identifier). Checked against the real rule: the generator before
 * this change produced its four reports, at exactly the declarations this test
 * names.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import ts from 'typescript';
import { generateIndex, generateMetadata, generateTypes } from '../generate.js';
import { blogSchema } from './types-fixture-schema.js';

interface Declarations {
  classes: string[];
  interfaces: string[];
  aliases: string[];
}

/** Top-level class, interface and type alias names in one source file. */
function declarations(fileName: string, source: string): Declarations {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const out: Declarations = { classes: [], interfaces: [], aliases: [] };
  for (const statement of file.statements) {
    if (ts.isClassDeclaration(statement) && statement.name) out.classes.push(statement.name.text);
    else if (ts.isInterfaceDeclaration(statement)) out.interfaces.push(statement.name.text);
    else if (ts.isTypeAliasDeclaration(statement)) out.aliases.push(statement.name.text);
  }
  return out;
}

function generatedFiles(): Record<string, string> {
  const schema = blogSchema();
  return {
    'index.ts': generateIndex(schema, { noTimestamp: true }),
    'types.ts': generateTypes(schema, { noTimestamp: true }),
    'metadata.ts': generateMetadata(schema, { noTimestamp: true }),
  };
}

describe('types: generated files pass no-unsafe-declaration-merging', () => {
  const files = generatedFiles();

  for (const [name, source] of Object.entries(files)) {
    it(`${name}: no class shares a name with an interface or type alias`, () => {
      const found = declarations(name, source);
      const typeNames = new Set([...found.interfaces, ...found.aliases]);
      const merged = found.classes.filter((cls) => typeNames.has(cls));
      assert.deepEqual(merged, [], `class and interface/type share a name in ${name}`);
    });
  }

  it('the generated client still declares its classes (the check is not vacuous)', () => {
    const index = declarations('index.ts', files['index.ts'] ?? '');
    assert.deepEqual(index.classes.sort(), ['TurbineClient', 'TypedTransactionClient']);
    // And it still types the transaction callbacks, now as overriding methods.
    assert.match(files['index.ts'] ?? '', /override \$transaction<R>\(\s*fn: \(tx: TypedTransactionClient\)/);
    assert.match(files['index.ts'] ?? '', /override \$withSession<R>\(/);
  });
});
