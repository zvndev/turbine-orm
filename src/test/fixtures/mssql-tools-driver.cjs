// Observable driver fixture; no SQL Server service is simulated or certified.
const fs = require('node:fs');
const log = (event) => fs.appendFileSync(process.env.MSSQL_TOOLS_LOG, `${JSON.stringify(event)}\n`);
const wait = () => new Promise((resolve) => setTimeout(resolve, 30));
class ConnectionPool {
  constructor(config) {
    this.config = config;
    log({ event: 'construct', config });
  }
  on(event, listener) {
    this.listener = listener;
    log({ event: 'on', name: event });
    return this;
  }
  async connect() {
    log({ event: 'connect' });
    if (process.env.MSSQL_TOOLS_MODE === 'connect-delay') await wait();
    if (process.env.MSSQL_TOOLS_MODE === 'connect-fail') throw new Error('private password secret');
    if (process.env.MSSQL_TOOLS_MODE === 'pool-error') this.listener(new Error('private server secret'));
    return this;
  }
  async close() {
    log({ event: 'close-start' });
    await wait();
    log({ event: 'close' });
    if (process.env.MSSQL_TOOLS_MODE === 'close-fail') throw new Error('private close secret');
  }
  request() {
    const params = {};
    const schema = this.config.database === 'fixture' ? 'app' : "quoted]' ; DROP TABLE x; --";
    return {
      input(name, value) {
        params[name] = value;
        return this;
      },
      async query(sql) {
        log({ event: 'query', sql, params });
        if (process.env.MSSQL_TOOLS_MODE === 'query-delay') await wait();
        if (process.env.MSSQL_TOOLS_MODE === 'query-fail') throw new Error('private literal secret');
        if (params.p1 !== schema) return { recordset: [] };
        const column = (table, name, type, nullable = 'NO', extra = {}) => ({
          TABLE_NAME: table,
          COLUMN_NAME: name,
          DATA_TYPE: type,
          IS_NULLABLE: nullable,
          COLUMN_DEFAULT: null,
          ...extra,
        });
        if (
          sql.includes('c.is_computed AS IS_COMPUTED') &&
          !sql.includes('sys.indexes') &&
          !sql.includes('INFORMATION_SCHEMA.COLUMNS')
        ) {
          return {
            recordset: [
              { TABLE_NAME: 'users', COLUMN_NAME: 'id', IS_IDENTITY: true, IS_COMPUTED: false },
              { TABLE_NAME: 'users', COLUMN_NAME: 'derived', IS_COMPUTED: true },
              { TABLE_NAME: 'users', COLUMN_NAME: 'row_version', IS_COMPUTED: false },
            ],
          };
        }
        if (sql.includes('i.has_filter AS HAS_FILTER') && sql.includes('ic.key_ordinal AS KEY_ORDINAL'))
          return {
            recordset: [
              {
                TABLE_NAME: 'users',
                INDEX_NAME: "idx'] WHERE (",
                COLUMN_NAME: 'derived',
                IS_COMPUTED: true,
                HAS_FILTER: true,
                IS_DISABLED: false,
                IS_HYPOTHETICAL: true,
                INDEX_TYPE: 'NONCLUSTERED',
                IS_INCLUDED: false,
                KEY_ORDINAL: 1,
              },
              {
                TABLE_NAME: 'users',
                INDEX_NAME: "idx'] WHERE (",
                COLUMN_NAME: 'email',
                IS_COMPUTED: false,
                HAS_FILTER: true,
                IS_DISABLED: false,
                IS_HYPOTHETICAL: true,
                INDEX_TYPE: 'NONCLUSTERED',
                IS_INCLUDED: true,
                KEY_ORDINAL: 0,
              },
            ],
          };
        if (sql.includes('INFORMATION_SCHEMA.TABLES'))
          return { recordset: [{ TABLE_NAME: 'posts' }, { TABLE_NAME: 'users' }] };
        if (sql.includes('sys.identity_columns')) return { recordset: [{ TABLE_NAME: 'users', COLUMN_NAME: 'id' }] };
        if (sql.includes('INFORMATION_SCHEMA.COLUMNS'))
          return {
            recordset: [
              column('users', 'id', 'int'),
              column('users', 'email', 'nvarchar'),
              column('users', 'display_name', 'nvarchar', 'YES', {
                COLUMN_DEFAULT: "('private-default@example.test')",
              }),
              column('users', 'derived', 'nvarchar', 'YES', {
                GENERATION_EXPRESSION: "'private-computed@example.test'",
                IS_COMPUTED: true,
              }),
              column('users', 'row_version', 'timestamp'),
              column('posts', 'id', 'int'),
              column('posts', 'user_id', 'int'),
            ],
          };
        if (sql.includes('INFORMATION_SCHEMA.KEY_COLUMN_USAGE'))
          return {
            recordset: [
              { TABLE_NAME: 'users', COLUMN_NAME: 'id', ORDINAL_POSITION: 1 },
              { TABLE_NAME: 'posts', COLUMN_NAME: 'id', ORDINAL_POSITION: 1 },
            ],
          };
        if (sql.includes('sys.foreign_keys'))
          return {
            recordset: [
              {
                CONSTRAINT_NAME: 'posts_user_fk',
                TABLE_NAME: 'posts',
                COLUMN_NAME: 'user_id',
                REFERENCED_TABLE_NAME: 'users',
                REFERENCED_COLUMN_NAME: 'id',
                ORDINAL_POSITION: 1,
              },
            ],
          };
        if (sql.includes('sys.indexes'))
          return {
            recordset: [
              {
                TABLE_NAME: 'users',
                INDEX_NAME: "idx'] WHERE (",
                IS_UNIQUE: false,
                COLUMN_NAME: 'derived',
                SEQ: 1,
                FILTER_DEFINITION: "email='private-filter@example.test'",
              },
            ],
          };
        throw new Error('Unexpected catalog query');
      },
    };
  }
}
module.exports = { ConnectionPool };
