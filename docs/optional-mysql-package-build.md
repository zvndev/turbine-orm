# Optional MySQL runtime package build

Build with `node scripts/build-optional-package.mjs --out /absolute/new/root
--profile mysql` (one command). The existing builder always performs a complete
normal clean build. The resulting optional package is named
`turbine-orm-mysql-runtime-stage` and must be installed under
the alias `turbine-orm`. The default package API and mandatory pg stay intact.

The export map is exactly `.`, `./mysql`, `./sql`. The fixed root facade exposes
MySQL values, schema builders/metadata and public errors; type-only forwarding
retains original generated-client declarations. The profile ships no CLI,
generator, other-engine values or migration lifecycle. Generation uses a
separate full tooling installation.

The driver is mandatory exact `mysql2@3.24.6`, a tested pin. Factory resolution
uses the unchanged package-local helper, so an application's conflicting
legacy driver cannot substitute for the profile dependency. Caller-supplied
pools retain their own independent driver limitations. mysql2 3.0.0 returns a
bound Buffer projection as text; that is an explicit expected negative, with
no first-fixed-release or broad floor-parity claim.

The graph includes every selected runtime and declaration, conditional PG
loader, static/lazy/type edge, CJS marker and URL asset. The old optional pg
peer remains necessary for the retained shared internal loader; physical
production closure must have zero PG-family packages. MySQL-specific external
admission is limited to mysql2 and its known promise/package.json subpaths.
D1/SQLite and global unknown-external refusal are unchanged.

The internal optional-peer helper has opaque dynamic arguments and a caught
missing sibling fallback at the ESM location. MySQL admission pins its exact
bytes, the complete normal emitted inventory and all normal runtime source
and build inputs. The CJS fallback to the ESM helper is retained; the absent
ESM fallback is explicitly recorded. This finite contract refuses changed
source even if an attacker refreshes the descriptor around old emitted bytes.
It does not infer general loader aliasing or allow arbitrary dynamic inputs.
Future source changes require a new explicit qualification of these pins.

The current qualification uses normal archive SHA256
`3e46c6f83a7fd8f1cbb7decc8343131abe282c2f4f6b419d75cbb7e9c11f19ac`.
The local D1 `cf: false` correction changes one source input and two emitted
CLI files outside this profile's closure. The complete source and emitted
inventory pins include those changes; no CLI exclusion is added to either
binding check. The selected MySQL payload remains byte-identical to its
previous archive. Historical source bindings and proofs remain historical.

Verify with `node tooling/optional-package/verify-artifacts.mjs IDENTITY
NORMAL_ARCHIVE NORMAL_SHA256 NEW_OUTPUT` (one command). The original verifier
reconstructs from the normal archive, never from a self-declared member list.
The fixed MySQL contract adds source/emission binding without changing the
existing artifact verifier or loader. All existing 25 budgets and coverage
floors remain fixed. Installed transitive footprint is descriptive; separate
tooling costs and concurrent runs provide no timing or ranking credit.

The tested mysql2 driver refuses a raw result column named `__proto__` with
its private-property error. This existing refusal is retained explicitly; JSON
own keys and ordinary result prototypes are checked separately. No complete
raw reserved-column parity is claimed.

The runtime package version is read from the root package.json and suffixed with `-runtime.0`.

The runtime package version is read from the root package.json and suffixed with `-runtime.0`.
