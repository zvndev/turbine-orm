# Binary scalar inference in generated types

Native SQLite binary inference and PostgreSQL builtin `bytea` inference record
`ColumnMetadata.inferredBinaryType?: 'Uint8Array' | 'Buffer'`. Generation uses
this explicit hint to qualify the corresponding intrinsic as
`globalThis.Uint8Array` or `globalThis.Buffer`. An entity with either name keeps
its public name. Nullable and supported array forms keep their existing shape.

The hint is optional, serializable generation data. It does not convert runtime
values or authenticate a native producer. A caller supplying a valid own data
hint deliberately opts into its inference semantics. Inherited hints are
ignored. Own accessors and unknown hint values are refused without reading a
hint getter or writing partial generated output. Own `undefined` retains legacy
behavior. Arbitrary text in the hint is never emitted as executable type code.

Unmarked metadata keeps its existing TypeScript text verbatim, including
canonical `Buffer` or `Uint8Array` text beside a same-named entity. Generation
does not recover provenance from type spelling, target or default-map equality.
Old unmarked JSON is therefore not repaired automatically. Regenerate from an
admitted native producer, or use the existing `columnTypes` option with an
explicit `globalThis.Buffer` or `globalThis.Uint8Array` type.

`columnTypes` and `declaredTsType` retain their precedence. Enum references and
custom type expressions retain their meaning. A caller taking ownership of a
marked column can set an existing override/declaration or clear its hint.
Supported own-data copies, `withDbFieldNames`, JSON rehydration and generated
metadata retain the hint. A declaration on a marked column is serialized beside
the hint so regeneration retains that ownership. External serializers that
discard the field produce legacy unmarked input.

PostgreSQL eligibility requires the actual builtin type identity in
`pg_catalog`. Table and ordinary-view columns also require explicit catalog
proof that the declaration is not a domain. Missing domain identity is not
proof. Materialized views use their direct catalog type identity. Domains,
enums and custom types are not marked merely because their names or mapped
text resemble binary types. The code-first bridge marks only default BYTEA
mapping with no caller type declaration. Native SQLite marks only its actual
binary mapper result, retaining the mapper's existing precedence.

Runtime values, SQL, parsers and caller handle/pool ownership keep their
existing contracts. Other engines gain no binary support certification from
this hint. PostgreSQL's existing broad filter union already admits native
Buffer values; binary provenance does not narrow that filter union.
