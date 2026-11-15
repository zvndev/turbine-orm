import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { command } from '../../../tooling/lifecycle-examples/harness.mjs';
import { here, treeDigest } from './verify-pins.mjs';

const source = Object.fromEntries(['src', 'fixture', 'canonical'].map((p) => [p, treeDigest(join(here, p))]));
command({ steps: [] }, here, here, process.execPath, [join(here, 'node_modules/typescript/bin/tsc')], process.env);
const emitted = Object.fromEntries(['src', 'fixture', 'canonical'].map((p) => [p, treeDigest(join(here, 'dist', p))]));
writeFileSync(join(here, 'dist/build.json'), `${JSON.stringify({ source, emitted, compiler: '5.9.3' }, null, 2)}\n`);
console.log('Strict candidate build complete');
