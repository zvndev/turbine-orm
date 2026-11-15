import { EventEmitter } from 'node:events';
import type { PgCompatPoolClient } from '../../../pg-types.js';

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

export class FakeClient extends EventEmitter {
  statements: string[] = [];
  releases: (Error | boolean | undefined)[] = [];
  execute: (text: string) => Promise<void> = async () => {};
  async query(text: string) {
    this.statements.push(text);
    await this.execute(text);
    return { rows: [], rowCount: 0 };
  }
  release(error?: Error | boolean) {
    this.releases.push(error);
  }
  notify(channel: string, payload = '') {
    this.emit('notification', { channel, payload });
  }
}

export class FakePool {
  clients: FakeClient[] = [];
  connects = 0;
  ends = 0;
  checkout: () => Promise<FakeClient> = async () => new FakeClient();
  async connect(): Promise<PgCompatPoolClient> {
    this.connects++;
    const client = await this.checkout();
    this.clients.push(client);
    return client;
  }
  async end() {
    this.ends++;
  }
}
