// Real mssql.Transaction with a modeled wire connection. No server certification.
const { EventEmitter } = require('node:events');
const mssql = require('mssql');
const model = require('./mssql-seed-driver.cjs');

module.exports = function fixture() {
  const events = [];
  let wire;
  let pinned;
  class Pool extends model.ConnectionPool {
    connected = true;
    acquire(transaction, callback) {
      if (pinned) throw new Error('second native checkout while pinned');
      if (!(transaction instanceof mssql.Transaction)) throw new Error('not the real mssql.Transaction');
      pinned = transaction;
      wire = new EventEmitter();
      wire.model = new model.Transaction(this);
      wire.beginTransaction = (done) => {
        events.push('wire.begin');
        wire.model.begin().then(() => done(), done);
      };
      wire.commitTransaction = (done) => {
        events.push('wire.commit');
        wire.model.commit().then(() => done(), done);
      };
      wire.rollbackTransaction = (done) => {
        events.push('wire.rollback');
        wire.model.rollback().then(() => done(), done);
      };
      events.push('pool.acquire');
      callback(null, wire, {});
    }
    release(connection) {
      if (connection !== wire || !pinned) throw new Error('wrong connection released');
      events.push('pool.release');
      pinned = undefined;
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
      if (!(this.parent instanceof mssql.Transaction)) {
        const request = this.parent.request();
        request.params = this.params;
        return request.query(sql);
      }
      const transaction = this.parent;
      // Exercise the real driver's public acquire/release pin, including its
      // _activeRequest guard, rather than reading a private driver field.
      const connection = await new Promise((resolve, reject) =>
        transaction.acquire(this, (error, acquired) => (error ? reject(error) : resolve(acquired))),
      );
      if (transaction !== pinned || connection !== wire) throw new Error('native pin escaped');
      events.push('request.pinned');
      try {
        const request = new model.Request(connection.model);
        request.params = this.params;
        return await request.query(sql);
      } finally {
        transaction.release(connection);
      }
    }
    batch(sql) {
      return this.query(sql);
    }
  }
  return {
    native: new Pool({}),
    driver: { ...mssql, Request },
    events,
    get pinned() {
      return pinned;
    },
  };
};
