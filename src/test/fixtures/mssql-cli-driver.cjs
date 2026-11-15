// Deterministic native-driver test double. This is not a SQL Server emulator.
const fs = require('node:fs');
const log = (event) => fs.appendFileSync(process.env.MSSQL_FIXTURE_LOG, `${JSON.stringify(event)}\n`);
class Request {
  constructor() {
    this.params = {};
  }
  input(name, ...args) {
    this.params[name] = args.at(-1);
    return this;
  }
  async query(sql) {
    log({ event: 'query', sql, params: this.params });
    if (process.env.MSSQL_FIXTURE_FAIL === '1') throw new Error('catalog fixture failure');
    if (sql.includes('ProductMajorVersion')) return { recordset: [{ v: 16 }] };
    if (sql.includes('INFORMATION_SCHEMA.TABLES')) {
      return {
        recordset:
          this.params.p1 === 'app'
            ? [{ TABLE_NAME: 'users' }, { TABLE_NAME: 'audit_logs' }, { TABLE_NAME: 'profiles' }]
            : [],
      };
    }
    if (sql.includes('sys.identity_columns')) return { recordset: [{ TABLE_NAME: 'users', COLUMN_NAME: 'id' }] };
    if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) {
      return {
        recordset: [
          { TABLE_NAME: 'profiles', COLUMN_NAME: 'id', DATA_TYPE: 'int', IS_NULLABLE: 'NO' },
          { TABLE_NAME: 'profiles', COLUMN_NAME: 'user_id', DATA_TYPE: 'int', IS_NULLABLE: 'YES' },
          { TABLE_NAME: 'users', COLUMN_NAME: 'id', DATA_TYPE: 'int', IS_NULLABLE: 'NO', COLUMN_DEFAULT: null },
          { TABLE_NAME: 'users', COLUMN_NAME: 'email', DATA_TYPE: 'nvarchar', IS_NULLABLE: 'NO', COLUMN_DEFAULT: null },
          {
            TABLE_NAME: 'users',
            COLUMN_NAME: 'display_name',
            DATA_TYPE: 'nvarchar',
            IS_NULLABLE: 'YES',
            COLUMN_DEFAULT: null,
          },
          {
            TABLE_NAME: 'audit_logs',
            COLUMN_NAME: 'body',
            DATA_TYPE: 'nvarchar',
            IS_NULLABLE: 'NO',
            COLUMN_DEFAULT: null,
          },
        ],
      };
    }
    if (sql.includes('INFORMATION_SCHEMA.KEY_COLUMN_USAGE'))
      return { recordset: [{ TABLE_NAME: 'users', COLUMN_NAME: 'id', ORDINAL_POSITION: 1 }] };
    if (sql.includes('sys.foreign_keys'))
      return {
        recordset: [
          {
            CONSTRAINT_NAME: 'profiles_user_fk',
            TABLE_NAME: 'profiles',
            COLUMN_NAME: 'user_id',
            REFERENCED_TABLE_NAME: 'users',
            REFERENCED_COLUMN_NAME: 'id',
            REFERENCED_TABLE_SCHEMA: 'app',
            ORDINAL_POSITION: 1,
          },
        ],
      };
    if (sql.includes('sys.indexes'))
      return {
        recordset: [
          {
            TABLE_NAME: 'profiles',
            INDEX_NAME: 'profiles_one_user',
            COLUMN_NAME: 'user_id',
            SEQ: 1,
            IS_UNIQUE: true,
            IS_INCLUDED: false,
            HAS_FILTER: false,
            IS_DISABLED: false,
            IS_HYPOTHETICAL: false,
          },
        ],
      };
    const statePath = process.env.MSSQL_FIXTURE_STATE;
    const rows = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : [];
    if (sql.startsWith('INSERT INTO [users]')) {
      const columns = sql
        .match(/\[users\] \((.*?)\)/)[1]
        .match(/\[([^\]]+)\]/g)
        .map((s) => s.slice(1, -1));
      const names = sql.match(/VALUES \((.*?)\)/)[1].match(/@p\d+/g);
      const row = Object.fromEntries(columns.map((column, i) => [column, this.params[names[i].slice(1)]]));
      row.id = rows.length + 1;
      rows.push(row);
      fs.writeFileSync(statePath, JSON.stringify(rows));
      return { recordset: [row], rowsAffected: [1] };
    }
    if (sql.startsWith('SELECT ') && sql.includes('FROM [users]')) return { recordset: rows };
    throw new Error(`Unexpected driver fixture query: ${sql}`);
  }
  batch(sql) {
    return this.query(sql);
  }
}
class ConnectionPool {
  constructor(config) {
    log({ event: 'construct', config });
  }
  async connect() {
    log({ event: 'connect' });
    return this;
  }
  request() {
    return new Request();
  }
  async close() {
    log({ event: 'close' });
  }
}
module.exports = { Request, ConnectionPool };
