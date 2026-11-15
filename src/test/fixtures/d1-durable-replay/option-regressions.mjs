/** Native-backed option capture and admission regression; also runs inside workerd. */
export async function reviewRegressions(api, binding, label) {
  const check = (value, message) => {
    if (!value) throw new Error(message);
  };
  const input = {
    eventId: 'missing',
    orderId: 'missing',
    quantity: '0',
    amount: '0.000000000000',
    occurredAt: '2026-11-07T00:00:00.000000Z',
    title: null,
    body: new Uint8Array(),
  };
  const results = [];
  for (const key of ['timeoutMs', 'signal']) {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let reads = 0;
    const held = {
      prepare(sql) {
        const wrap = (statement) => ({
          bind(...params) {
            return wrap(statement.bind(...params));
          },
          async all() {
            const result = await statement.all();
            reads++;
            await gate;
            return result;
          },
        });
        return wrap(binding.prepare(sql));
      },
      batch() {
        throw new Error('Read-only regression dispatched a batch');
      },
    };
    const app = new api.ReplayApp(held),
      pending = [];
    let outer,
      refused = false;
    const options = Object.defineProperty({}, key, {
      get() {
        for (let i = 0; i < 8; i++) pending.push(app.reconcile(label, input));
        return key === 'timeoutMs' ? 2000 : undefined;
      },
    });
    try {
      try {
        outer = app.reconcile(label, input, options);
      } catch (error) {
        check(error instanceof api.Stopped, 'Unexpected admission error');
        refused = true;
      }
      check(
        refused && app.status.active === 8 && app.status.unsettled === 8,
        'Option getter bypassed eight-operation admission',
      );
    } finally {
      release();
      await Promise.all([...pending, ...(outer ? [outer] : [])]);
      check((await app.close()).settled, 'Admission regression leaked an operation');
    }
    check(reads === 8, 'Refused outer operation reached native binding');
    results.push({ key, reads, refused });
  }
  for (const cause of [false, 0, '', null, undefined]) {
    const app = new api.ReplayApp(binding);
    let caught = false;
    try {
      app.reconcile(label, input, {
        get timeoutMs() {
          throw cause;
        },
      });
    } catch (error) {
      check(Object.is(error, cause), 'Option getter cause changed');
      caught = true;
    }
    check(caught && app.status.active === 0 && app.status.unsettled === 0, 'Failed capture retained admission');
    check((await app.reconcile(label, input)) === null, 'Failed capture prevented later native work');
    check((await app.close()).settled, 'Failed capture close unsettled');
  }
  return { options: results, captureFailures: 5 };
}
