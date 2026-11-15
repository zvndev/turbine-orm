// Observable native API fault model. Does not certify SQL Server behavior.
const fs = require('node:fs');
const catalog = require('./mssql-cli-driver.cjs');
const log = (event) => {
  if (process.env.MSSQL_FIXTURE_LOG) fs.appendFileSync(process.env.MSSQL_FIXTURE_LOG, `${JSON.stringify(event)}\n`);
};
let nextId = 0;
const events = [];
const record = (event) => {
  events.push(event);
  log(event);
};
class ConnectionPool {
  constructor(config) {
    this.rows = [];
    this.config = config;
    this.closed = false;
    this.id = ++nextId;
    record({ event: 'pool', pool: this.id });
  }
  async connect() {
    record({ event: 'connect', pool: this.id });
    return this;
  }
  async close() {
    this.closed = true;
    record({ event: 'close', pool: this.id });
  }
  request() {
    return new Request(this);
  }
}
class Transaction {
  constructor(pool) {
    this.pool = pool;
    this.id = ++nextId;
    record({ event: 'transaction', pool: pool.id, tx: this.id });
  }
  async begin() {
    record({ event: 'begin', tx: this.id });
    if (process.env.MSSQL_SEED_FAULT === 'begin') throw new Error('begin fault');
    this.rows = structuredClone(this.pool.rows);
    this.active = true;
  }
  async commit() {
    record({ event: 'commit', tx: this.id });
    if (!this.active) throw new Error('not pinned');
    if (process.env.MSSQL_SEED_FAULT === 'commit') throw new Error('commit fault');
    this.pool.rows = this.rows;
    this.active = false;
    if (process.env.MSSQL_FIXTURE_STATE) fs.writeFileSync(process.env.MSSQL_FIXTURE_STATE, JSON.stringify(this.rows));
  }
  async rollback() {
    record({ event: 'rollback', tx: this.id });
    this.active = false;
  }
}
class Request {
  constructor(parent) {
    this.parent = parent;
    this.params = {};
  }
  input(name, ...values) {
    this.params[name] = values.at(-1);
    return this;
  }
  async query(sql) {
    const tx = this.parent instanceof Transaction ? this.parent : null;
    record({ event: 'request', tx: tx?.id ?? null, sql, params: this.params });
    if (sql.includes('ProductMajorVersion')) return { recordset: [{ v: 16 }] };
    if (sql.includes('AS seed_schema')) return { recordset: [{ seed_schema: process.env.MSSQL_SEED_SCHEMA ?? 'app' }] };
    if (/INFORMATION_SCHEMA|sys\./.test(sql)) {
      const req = new catalog.Request();
      req.params = this.params;
      return req.query(sql);
    }
    if (!tx?.active) throw new Error('data request escaped native Transaction pin');
    if (process.env.MSSQL_SEED_FAULT === 'query') throw new Error('DML fault');
    if (tx.pool.pause) await tx.pool.pause;
    if (sql.startsWith('INSERT INTO [users]')) {
      const columns = sql
        .match(/\[users\] \((.*?)\)/)[1]
        .match(/\[([^\]]+)\]/g)
        .map((s) => s.slice(1, -1));
      const tuples = [...sql.matchAll(/\((@p\d+(?:, @p\d+)*)\)/g)];
      const rows = tuples.map((tuple) => {
        const params = tuple[1].match(/@p\d+/g);
        return {
          id: tx.rows.length + 1,
          ...Object.fromEntries(columns.map((c, i) => [c, this.params[params[i].slice(1)]])),
        };
      });
      if (!rows.length) throw new Error('empty model insert');
      tx.rows.push(...rows);
      return { recordset: rows, rowsAffected: [rows.length] };
    }
    if (sql.startsWith('SELECT ') && sql.includes('FROM [users]')) {
      if (sql.includes('COUNT(*)')) return { recordset: [{ count: tx.rows.length }] };
      return { recordset: structuredClone(tx.rows) };
    }
    throw new Error(`Unmodeled seed request: ${sql}`);
  }
  async batch(sql) {
    const tx = this.parent;
    record({ event: 'batch', tx: tx.id, sql });
    if (!tx.active) throw new Error('batch escaped transaction');
    const save = /^SAVE TRANSACTION (\S+)/.exec(sql);
    if (save) {
      tx.savepoints ??= new Map();
      tx.savepoints.set(save[1], structuredClone(tx.rows));
      return {};
    }
    const undo = /^ROLLBACK TRANSACTION (\S+)/.exec(sql);
    if (undo && tx.savepoints?.has(undo[1])) {
      tx.rows = structuredClone(tx.savepoints.get(undo[1]));
      return {};
    }
    throw new Error(`Unmodeled seed batch: ${sql}`);
  }
}
module.exports = { ConnectionPool, Request, Transaction, ISOLATION_LEVEL: {}, events };
