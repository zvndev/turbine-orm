# SQLite fixture lifetimes

Test fixtures must close caller-owned native SQLite databases. Disconnecting a
client constructed with a borrowed `DatabaseSync` intentionally leaves that
handle open. Demo contexts instead expose a pool whose `end()` owns cleanup.
Production ownership is unchanged.

Run without coverage or external database services, from the repository root:

```sh
node --test tooling/sqlite-fixture-lifetimes/harness.test.mjs
node tooling/sqlite-fixture-lifetimes/run.mjs --out /tmp/sqlite-lifetime-audit
node tooling/sqlite-fixture-lifetimes/run.mjs --out /tmp/sqlite-lifetime-focused -- src/test/create-many-uniform-rows.test.ts
```

The output directory must be new. The selected Node executable runs both the
controller and tests; select an exact executable to test a particular runtime.
Use `--experimental-sqlite` on Node 22.5. Node 20 imports remain supported:
`--allow-unsupported` permits an explicitly `unsupported` report there, never a
native pass. On a supported runtime, exercising zero native lifetimes still
fails, even with this option. The default gate requires native SQLite.

`run.mjs` selects every current `src/test/*.test.ts`, clears network-engine URL
variables and requires a complete argv-matched report from every direct source
test child. Test output stays in `tests.log`; failures also print a tail. It
records the controller and test-runner identities, exact argv, runtime, paths,
exit status, signal and SHA256s of the tool and selected test files. A ten-minute timeout kills the owned test process group.
The controller forwards SIGINT/SIGTERM to that group. Additional inherited
subprocess reports are retained separately, outside the source-process totals.
It does not instrument every subprocess launched by the tests, nor certify
cleanup of every operating-system resource.

`observe.mjs` preloads before application imports, instruments CommonJS and named
ESM native constructors, and captures native operations before fixture fault
injection. It counts constructed handles, opened lifetimes (including delayed
opens/reopens), independently observed closed lifetimes, pre-cleanup survivors,
emergency cleanup successes/errors and remaining open handles. Each process
record includes PID, parent PID, executable, Node version, cwd, argv, execArgv,
timestamps and survivor construction stacks. Closed-state probing works without
the newer `isOpen` getter and does not reject an open malformed/busy database.

The synchronous exit observation fails on any survivor **before** attempting
emergency native cleanup. Cleanup cannot turn a leak into success. A nonzero
primary exit code stays nonzero and unchanged, and cleanup errors retain their
native code/message/stack. Missing or incomplete reports also fail the controller. Failed TAP is checked
independently because older Node runners can exit zero after a failed suite hook.
Abrupt termination cannot produce a final report. This is a fixture omission
guard, not a native-memory bound, statement audit, coverage collector, or
protection against code deliberately disabling the observer. Resources created
by later process-exit listeners are outside the snapshot.

`src/test/sqlite-fixture-lifetime.ts` provides explicit fixture hooks:

- In test bodies and their helpers, wrap construction in `closeSqliteAfter(db)`
  before setup. Its test hook closes even after setup/assertion failure.
- In `beforeEach`, pass the actual test context's `t.after.bind(t)`. A bare
  `after()` inside a hook belongs to that hook and closes too early.
- For `before` fixtures, define a `sqliteFixtureScope(teardown?)` at the owning
  describe/module scope and pass its registrar to `closeSqliteAfter`. Put client
  teardown in the same scope callback, so its failure cannot skip native cleanup.
  The scope attempts every registered cleanup and preserves primary and secondary
  failures. Suite-definition callbacks finish before their before hooks execute.
- Wrap test-owned demo contexts in `closeSqliteContextAfter(context)` to end
  their owning pool. Do not change production borrowed-handle semantics.

The tests prove explicit close versus a copied omission, preservation of a
primary failure, native callback cleanup against an independent native oracle (including actual
close errors on runtimes that refuse callback close),
delayed/reopened handles, malformed databases, unsupported imports, fixture
setup/assertion/teardown failures, omitted reports and zero-native execution.
Capability prerequisites are explicit skips, not native passes. No dependency,
coverage/size floor, assertion relaxation, package script or CI job is added.
