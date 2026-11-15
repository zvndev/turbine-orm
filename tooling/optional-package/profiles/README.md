# Optional {{PROFILE}} package build

This unpublished `turbine-orm-{{PROFILE}}-runtime-stage` package is an opt-in
runtime subset built by Turbine's existing optional-package stager. Install its
actual tarball as `turbine-orm@file:/absolute/path/ARCHIVE.tgz`. The alias is
required by existing generated factories. The default `turbine-orm` package
continues to install pg; the full optional stage remains available separately.

The root exports the selected engine, errors, `defineSchema` and
`schemaDefToMetadata`. It forwards the original root's types with `export type *`
so generated factories retain their existing imports. Those type-only names do
not expose PostgreSQL runtime values. There is no PostgreSQL root constructor,
generator, CLI, migration lifecycle, other engine or optional SQLite binding.
Unlisted subpaths and deep imports refuse through the export map.

SQLite exports exactly `.`, `./sqlite`, `./sqlite/seed`, `./sql`. Its default
binding is Node's `node:sqlite` (Node >=22.5, experimental on the tested versions).
D1 exports exactly `.`, `./d1`, `./sql` and requires a caller-supplied D1 binding.
D1 supports native atomic batches and refuses interactive transactions. Neither
profile installs Miniflare, workerd, generators or TypeScript in production.

There are no mandatory dependencies. pg is the sole optional peer because the
unchanged shared runtime still contains its existing conditional/lazy loader.
A missing peer explicitly refuses PostgreSQL parser/connection operations;
installing it does not add PostgreSQL exports or support to this profile.

Generate clients in a separate full Turbine tooling installation. Move the
resulting source into this alias installation, compile with TypeScript >=5.0
and appropriate Node declarations, then execute the emitted ESM or CJS factory.
SQLite generation uses `generate({target:'sqlite', ...})`; D1 uses
`generateD1Files`. Generators are deliberately absent from this runtime package.

The profile retains the exact transitive ESM/CJS runtime and declaration
closure, including conditional PG loaders, the CJS package marker and any
statically identified assets. Its verifier independently derives that inventory
from the matching normal archive and fixed facade templates. Original emitted
bytes are unchanged except the reviewed optional-PG import redirections. A fresh
complete source build precedes selection; an edited identity cannot authorize
missing declarations/loaders, altered code or extra exports. This is private
distribution evidence, with no performance or hosted-provider certification.
