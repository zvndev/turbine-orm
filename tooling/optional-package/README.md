# Optional driver package build

This is an optional package build generated from the same source as
`turbine-orm`. The existing package still installs PostgreSQL by default. This
artifact has a distinct name, `turbine-orm-optional-stage`, and cannot be published
with npm while its `private` flag is set.

Build a fresh artifact outside the checkout:

```sh
npm run build:optional-package -- --out /absolute/new/staging-directory
```

Install the tarball under the original import name so existing generated imports
continue to resolve. This chooses a different package deliberately:

```sh
npm install "turbine-orm@file:${OPTIONAL_ARCHIVE:?archive emitted by the optional package builder}"
```

The default install has no mandatory dependencies. Every driver is an optional
peer, including `pg`. `core`, `d1` and SQL helpers need no installed driver.
`sqlite` uses Node's `node:sqlite` builtin. Other engine and transport factories
still require their documented peer and retain their existing refusal behavior.
Importing these entries does not install a driver.

For PostgreSQL, explicitly install `pg@^8.15.0` alongside the alias. The original
root constructor, parsers, protocol, transactions and ownership behavior then use
the real driver object. A missing PostgreSQL driver refuses parser, protocol and
connection operations; it never substitutes identity parsers. A present driver's
load error propagates. Installing a peer after import requires a fresh process.
The edge-light/browser conditions refuse PostgreSQL operations without loading a
Node driver. Hosted-provider certification is separate from this local package.

Exports and ESM/CJS declarations are copied unchanged. The only executable edits
in the staged copy redirect emitted PostgreSQL import specifiers to the optional
loader. The default package, source files, build finisher, coverage floors and
existing size budgets are unchanged. This is an install architecture, not a
bundler externalization result or an accepted performance measurement.

The staging script runs the normal clean build itself, including Studio
generation, even when invoked directly. It refuses inputs that change during
build or packing. `identity.json` version 2 binds all source/type/build inputs,
packed skills and license, the fresh ESM/CJS outputs, every staged payload file,
original exports and the actual archive SHA256. The Git head is context; input
hashes describe the actual working files. Retain the identity and tarball
together. Staging refuses an existing output directory.

Verification requires the matching default archive and exact input snapshot.
It derives every optional payload byte from that default archive plus the four
recorded loaders and README. A changed filename or an edited checksum alone
cannot authorize another executable change, omitted loader or extra file.
Version 1 identities remain historical evidence and do not satisfy this gate.

## Replay contracts

Use a fresh output directory for each command. `OPTIONAL_PACKAGE_NODES` accepts
comma-separated absolute Node binaries; exercise the supported Node versions
separately. Put npm's cache and `TMPDIR` in an owned home-cache directory.

```sh
node tooling/optional-package/prove.mjs STAGE/identity.json NEW_PROOF
node tooling/optional-package/verify-artifacts.mjs STAGE/identity.json ORIGINAL.tgz ORIGINAL_SHA256 NEW_VERIFICATION
node tooling/optional-package/controls.mjs STAGE/identity.json NEW_CONTROLS
node tooling/optional-package/native.mjs STAGE/identity.json ORIGINAL.tgz NEW_NATIVE
```

`prove.mjs` records the untouched fresh production closure before adding Node
declarations for strict compilation. It executes all exports in both formats,
native SQLite semantics, missing-peer refusals, supplied core/D1/HTTP execution,
and generated imports. It never deletes a preinstalled driver to manufacture a
no-driver result. `controls.mjs` deliberately breaks disposable packed copies;
the expected failures remain in their reports.

`native.mjs` requires PostgreSQL 18.6 under `PG_PREFIX` and reserves loopback port
57175. Announce the exact service root/port before invocation. It uses the existing
bounded subreaper and service ownership helper, with the port selection changed
only in a copied helper. It tests the supplied original archive and the separate
staged archive at pg 8.15.0 and 8.23.0, including generated factories, prepared
queries, complete scalar/relation results, transaction rollback/commit, timeout
recovery and caller pool ownership. This is correctness evidence, not timing.

`local-runtime.mjs INSTALLED_CONSUMER NEW_OUTPUT` needs this checkout's Miniflare
and esbuild plus `@libsql/client@0.18.0` installed in a separate staged consumer.
It reserves loopback port 57176 and exercises the installed ESM entry in workerd,
the CJS entry through Miniflare's real Node D1 binding, and native libSQL in both
formats. Directly bundling CJS for a Worker requires a Node-builtin require bridge;
that deployment format is not certified by these checks.

Run service commands under the existing bounded command owner, retain every
report, then independently run `python3 tooling/optional-package/audit.py
EVIDENCE_ROOT NEW_AUDIT.json`. The audit verifies retained PID generations,
process groups, service datadir/socket removal and port reuse without signaling.
No hosted endpoint, server other than the stated PG version, native SQL Server,
PowDB service, or hosted Neon route is certified here. Existing default size and
coverage gates are not replaced by this lane's package proofs.

## Optional runtime subsets

The same stager also accepts `--profile d1` or `--profile sqlite` after `--out`.
These separately named, optional runtime-only packages omit CLI, generation,
migration lifecycle and other engine exports. They require the actual
`turbine-orm@file:...` alias for existing generated factories. SQLite requires
`node:sqlite`; D1 requires a supplied binding. Their root runtime facade contains
only the selected engine, errors and two schema helpers, with type-only root
forwarding for generated imports. The full mode above is unchanged. See
`tooling/optional-package/profiles/contract.mjs` in the source tree for the exact
export, condition, peer, declaration closure and validation contracts. Profiles use version 3
identities and independently reconstructed member/byte verification; no size
budget or hosted/lifecycle support changes are implied.
