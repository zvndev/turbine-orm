import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { build } from 'esbuild';

const constructorMessage = 'expr.case() takes an array of 1 to';

async function bundle(entry: string, retainConstructors = false): Promise<string> {
  const result = await build({
    absWorkingDir: process.cwd(),
    entryPoints: [entry],
    bundle: true,
    write: false,
    platform: 'node',
    external: ['pg', '#pg'],
    plugins: retainConstructors
      ? [
          {
            name: 'retain-expression-constructors',
            setup(builder) {
              builder.onLoad({ filter: /[/\\]query[/\\]expr\.ts$/ }, async ({ path }) => {
                const source = await readFile(path, 'utf8');
                const anchor = '/* @__PURE__ */ Object.freeze({';
                assert.equal(source.split(anchor).length - 1, 1);
                return { contents: source.replace(anchor, 'Object.freeze({'), loader: 'ts' };
              });
            },
          },
        ]
      : [],
  });
  assert.equal(result.outputFiles.length, 1);
  const output = result.outputFiles[0]!.text;
  assert.ok(output.length > 1000);
  return output;
}

describe('expression constructor reachability', () => {
  it('query-only entry retains expression execution without retaining the constructor table', async () => {
    const output = await bundle('src/serverless.ts');
    assert.ok(output.includes('expr.excluded() takes the name of a field'));
    assert.ok(output.includes('expr.secondsBetween() in'));
    assert.ok(!output.includes(constructorMessage));
  });

  it('the public barrel retains every expression constructor', async () => {
    const output = await bundle('src/index.ts');
    assert.ok(output.includes(constructorMessage));
    assert.ok(output.includes('Both operands are col()'));
  });

  it('the query-only assertion detects losing constructor isolation', async () => {
    const output = await bundle('src/serverless.ts', true);
    assert.ok(output.includes(constructorMessage));
  });
});
