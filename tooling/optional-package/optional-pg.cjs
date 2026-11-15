let resolved;
try {
  resolved = require.resolve('pg');
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND' || !/^Cannot find module 'pg'(?:\n|$)/.test(error.message)) throw error;
}
module.exports = resolved ? require(resolved) : require('./unavailable-pg.cjs');
