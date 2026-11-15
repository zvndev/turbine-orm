// Additional size measurements; the default package budgets remain in .size-limit.js.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import existing from '../../.size-limit.js';
import { optionalPgSizes } from './budgets.mjs';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export default [...existing, ...optionalPgSizes].map((check) => ({ ...check, path: resolve(repo, check.path) }));
