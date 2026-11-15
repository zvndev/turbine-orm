# Optional PostgreSQL package build

This optional full-package build installs as `turbine-orm` from a local archive. Its package name is `turbine-orm-pg-compat-stage`, version from the root package.json with the suffix `-pg-compat.0`, and `private` is true. It keeps the complete normal package, all exports, loaders, declarations, assets, licenses and skills. Every emitted byte is identical to the pinned normal archive. There is no runtime loader mutation or driver patch.

The only permitted changes are a fixed package README and manifest transformation: name, version, private flag, description and mandatory exact `pg` pin; development dependencies, scripts, lint-staged configuration and explanatory `//` keys are removed. All other manifest fields, including imports, exports and optional peer contracts, remain identical. The default package retains mandatory `pg:^8.15.0` and its original API and behavior.

The candidate pin is exact `8.22.0`; `8.23.1` is the bounded current control and may replace the candidate only if the candidate actually fails. A passing candidate is a tested compatible pin, not proof of the first upstream fixed version. Historical `8.15.0` raw `__proto__` column loss remains a negative/reference result. A manifest cannot rewrite a caller-supplied legacy pool. Such a pool retains its driver's limitations.

The builder owns a fresh complete normal source build and normal npm pack with existing hooks. It compares the complete normal archive against SHA256 `3e46c6f83a7fd8f1cbb7decc8343131abe282c2f4f6b419d75cbb7e9c11f19ac` (753 members, 749 dist files), snapshots all build/packed inputs and build tools, then packs the stage. A standalone verifier first compares the recorded Node version, npm path and complete executable/compiler hash inventory with its actual toolchain. It repeats the source build/normal pack and requires the fresh tool receipt to match the producer identity, checks source stability, and independently derives the complete permissible staged inventory and bytes from that pinned normal archive plus the fixed templates. Descriptor hashes and inventory are evidence, never authority for payload selection.

This explicit pin includes the local D1 runtime's `cf: false` correction. Compared with the retained historical `bffce314` archive, only the two emitted `cli/d1-local.js` files differ; all declarations and query runtime bytes are identical. Historical archives and proof results remain separate. Future changes require another explicit qualification, not an arbitrary descriptor-supplied normal archive.

Installed proofs use real npm local archive alias installation, physical production locks and trees, exact Node 22.16.0 and 24.10.0, native PostgreSQL 18.6, ESM/CJS, strict consumers (`skipLibCheck:false`), generated factories, complete values and relations, protocol, transactions, timeout recovery and caller pool survival. The stage must physically resolve its pinned pg even beside application pg8.15.0. Present malformed or broken drivers must still refuse.

The build and verification commands operate locally. Their results cover the specified package, driver and runtime versions. They do not establish hosted service support or comparative performance.

## Local use and verification

Use a fresh absolute directory outside the checkout for every output. Retain the pinned normal archive; its SHA is enforced by the builder and verifier. Build dependencies must already be installed. The verifier rebuilds independently even when a refreshed descriptor claims changed source with unchanged dist.

```sh
node scripts/build-pg-compat-stage.mjs --out "$STAGE_OUTPUT" --normal "$PINNED_NORMAL"
node tooling/pg-compat-stage/verify.mjs "$STAGE_OUTPUT/identity.json" "$PINNED_NORMAL" "$VERIFY_OUTPUT"
node tooling/pg-compat-stage/controls.mjs "$STAGE_OUTPUT/identity.json" "$PINNED_NORMAL" "$CONTROLS_OUTPUT"
npm install --save-exact "turbine-orm@file:$STAGE_ARCHIVE"
```

`controls.mjs` retains thirteen truthfully repacked archive faults, two standalone forged/omitted tool-identity refusals and one changed-source fault. They cover arbitrary executable edits/additions, missing loaders/runtime/declarations/license/skills, declaration edits, CJS scope, unsupported exports, unpinned/extra mandatory dependencies, README replacement, tool provenance, and stale source with refreshed descriptor claims. The last control uses an owned source copy with its actual tool identity and executes the standalone rebuilding verifier. Verification requires the recorded toolchain and paths; use a fresh builder identity when changing the toolchain instead of editing provenance claims.

The native runner requires an owned parent `TMPDIR`, an offline npm cache, the exact Node binaries, and local PG18.6 tools (`PG_PREFIX`). Before invoking it, reserve/free-probe and announce its fixed port59851 and `$NATIVE_OUTPUT/pg`. Its existing supervisor owns all child processes and tears down its newly initialized data/socket paths in finally. Run the independent zero-signal audit afterward.

```sh
node tooling/pg-compat-stage/prove.mjs "$STAGE_OUTPUT/identity.json" "$PINNED_NORMAL" "$NATIVE_OUTPUT" "$NODE22" "$NODE24"
python3 tooling/pg-compat-stage/audit.py "$EVIDENCE_ROOT" "$AUDIT_OUTPUT"
```

The production install proofs retain the requested alias, every physical package and payload hash, logical and physical lock, dependency tree, nested driver path and driver bytes before type tooling. Strict compilation uses the already installed build compiler and Node declarations, without installing `@types/pg` into consumers. All published subpaths resolve as actual ESM and CJS on both runtimes and match normal export namespaces. Generated emitted files and compiler invocations are retained per runtime/format cell.

There are16 native cells: stage-owned8.22 beside app8.15, normal8.22, normal8.23.1, and normal8.15, each on both runtimes/formats. The8.15 raw-column assertion remains a recorded failing compatibility result, while its separately named unaffected checks may pass. Twelve real malformed/present-driver controls exercise ESM/CJS refusal on both runtimes. These bounded local proofs do not certify other engines, hosted services, every PG version, caller-owned driver replacement, or libSQL compatibility. The existing25 size budgets and coverage floors remain fixed.
