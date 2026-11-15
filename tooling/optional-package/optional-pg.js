import { createRequire } from 'node:module';
import unavailable from './unavailable-pg.js';

const require = createRequire(import.meta.url);
let resolved;
try {
  resolved = require.resolve('pg');
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND' || !/^Cannot find module 'pg'(?:\n|$)/.test(error.message)) throw error;
}
// A present but broken driver must fail visibly. Never swallow its load error.
export default resolved ? require(resolved) : unavailable;
