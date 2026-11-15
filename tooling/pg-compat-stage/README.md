# Optional PostgreSQL package build

Unreleased full Turbine ORM package, installed under the alias `turbine-orm`.
The mandatory driver is pinned to tested compatible pg 8.22.0. This is not a
claim about the first upstream fixed version. Library runtime, declarations,
exports, loaders, assets, license and skills match the normal package exactly.

The default turbine-orm package continues to require pg ^8.15.0. This optional
artifact does not change that contract. pg 8.15.0 can lose a raw `__proto__`
result column. Caller-supplied legacy pools retain that limitation; dependency
resolution cannot rewrite a pool already constructed by the application.

Native evidence is bounded to PostgreSQL 18.6, Node 22.16.0 and 24.10.0, and
the exact tested drivers. No release, hosted certification, support promotion
or performance improvement is claimed. Do not publish this private artifact.
