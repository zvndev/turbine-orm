# Native lifecycle apps

These small apps use public package imports and the client generated from an
actual database. Copy the files for your engine into an ordinary npm project,
along with `tsconfig.json`. Set `DATABASE_URL` through your environment. The
TypeScript source works in both `"type": "module"` and `"type": "commonjs"`
projects; compile with NodeNext before running `build/app.js`.

Follow the [lifecycle guide](../../docs/example-lifecycle-guide.md) for fresh and
existing databases, explicit migrations, schema previews and recovery. The
[verification runner](../../tooling/lifecycle-examples/README.md) installs a
built tarball in isolated consumers and checks actual effects.

SQLite and MySQL include explicitly invoked seed callbacks, each with its
engine-specific transaction limits. `mysql/partial-ddl.sql` is an
intentional failure demonstration for disposable databases, not an application
migration. No SQL Server live-service result is claimed.
