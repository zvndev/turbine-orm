# Optional MySQL package build

Unpublished `turbine-orm-mysql-runtime-stage` is a private
runtime subset. Install the actual tarball with the alias
`npm install turbine-orm@file:/absolute/path/ARCHIVE.tgz`.

Exports are exactly `turbine-orm`, `turbine-orm/mysql`, and `turbine-orm/sql`.
Root values are the MySQL engine, public errors, `defineSchema`, and
`schemaDefToMetadata`. Original type-only declarations remain for generated
consumers. There is no CLI, generator, other-engine factory, seed subpath,
or migration lifecycle in this package. Generate in a separate full Turbine
tooling installation, then compile the generated files against this alias.

The mandatory driver is exactly `mysql2@3.24.6`. This is a tested pin, not a
claim about the first upstream release fixing any issue. The existing factory
resolves the driver relative to this package. An application's own
`mysql2@3.0.0` does not replace it. Caller-supplied pools continue to use their
own driver and settings: the legacy driver's Buffer-as-text behavior remains
an expected negative reference and has no broad parity claim.

The optional `pg` peer records the existing internal shared-loader input.
Fresh production installs contain no PG-family packages. It grants no PG
runtime export or support claim. The original default package still installs
mandatory pg and keeps its API. D1, SQLite and full optional stages remain
separate unchanged packages.

Staging performs the complete normal clean build. Verification reconstructs
the graph and exact bytes from the pinned normal archive and fixed templates.
Original emitted runtime and declarations are retained, with only the
existing PG import transformations. The existing internal peer helper and
complete normal source/build and emitted inputs are pinned for this private
profile. Changed inputs refuse until explicitly requalified. No driver loader,
minification, codec removal, timing or package-support promotion is added.

The tested mysql2 driver refuses a raw result column named `__proto__` with
its private-property error. This existing refusal is retained explicitly; JSON
own keys and ordinary result prototypes are checked separately. No complete
raw reserved-column parity is claimed.

The runtime package version is read from the root package.json and suffixed with `-runtime.0`.

The runtime package version is read from the root package.json and suffixed with `-runtime.0`.
