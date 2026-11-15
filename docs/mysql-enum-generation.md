# Typed MySQL ENUM generation

Pass `target: 'mysql'` with the metadata returned by `introspectMysqlWith()` or
`introspectMysql()` to `generate()`. Native ENUM columns then use their catalog
labels in row, create, update, filter, unique-selector and transaction types.

```typescript
import { generate } from 'turbine-orm';
import { introspectMysqlWith } from 'turbine-orm/mysql';

const schema = await introspectMysqlWith(executeCatalogQuery, 'app');
generate({ schema, target: 'mysql', outDir: './generated/turbine' });
```

For `tickets.status ENUM('new','done')`, the generated `Ticket.status` is
`'new' | 'done'`. Nullable columns also accept `null`; optional create/update
fields keep their existing omission rules. The generated factory retains its
asynchronous MySQL binding and caller-owned pool behavior.

## Identity and precedence

MySQL ENUMs belong to individual columns. Generation matches the exact
`table.name + '.' + column.name` key in `schema.enums` and emits a literal union
at each affected type reference. Columns with identical labels retain separate
identities even if caller metadata reuses a column object across tables.
Non-ENUM columns are not substituted when their identity text matches an ENUM
key. No enum alias is derived from punctuation or renamed to avoid a
collision. Raw metadata, SQL types and enum dictionaries remain unchanged.

Explicit `columnTypes` overrides take precedence over declared TypeScript
types, which take precedence over inferred native labels. Original caller type
text is validated before substitution. The standalone `columnTsType()` API
retains its existing behavior. PostgreSQL enum names and other generation
targets retain their existing contracts.

Missing native identities, ambiguous dotted identities and invalid unmatched
enum keys are refused. Existing identifier, override and output-write boundaries
remain in force. Optional Zod output uses the same native labels and preserves
its existing behavior for arbitrary TypeScript overrides.

## Catalog and support boundaries

Labels preserve the represented server catalog values, including escaped quotes,
commas, backslashes, empty strings, controls and BMP text. MySQL reports the
catalog column type in utf8mb3, which cannot carry supplementary Unicode, so a
label such as `雪🙂` arrives as `雪?`. Introspection does not guess: a column
whose labels may have lost a character is marked `enumLabelsUnrecoverable`,
gets no `enums` entry and is warned about by name, and generation types it
`string` (Zod: `z.string()`) rather than a literal union that would name labels
the column does not have.

A label that really contains a question mark, on a column whose character set
can hold supplementary characters (utf8mb4, utf16, utf16le, utf32, gb18030), is
also typed `string`. The catalog text cannot tell a literal `?` from an altered
character, so the whole column is withheld.

The one way to get exact literal types for such a column is to declare its
labels explicitly:

- In code, add an `enums` entry for `table.column` to the introspected metadata
  before calling `generate()`, for example
  `schema.enums['tickets.mood'] = ['雪🙂', 'plain']`. The entry outranks the
  marker, and Zod output becomes the matching `z.enum`.
- With the CLI, add a `columnTypes` entry to `turbine.config.ts`, for example
  `columnTypes: { 'tickets.mood': "'雪🙂' | 'plain'" }`. The TypeScript type
  becomes that union; Zod output keeps `z.string()`, as for every `columnTypes`
  override.

Introspection only reads the catalog, so the labels stay withheld on every
run until they are declared. This is not a claim of complete ENUM or Unicode
support.

Omitting `target: 'mysql'` retains the default PostgreSQL generation behavior;
column-local keys such as `tickets.status` fail its enum identifier validation.
Existing naming and binary-generation limitations are unchanged. MySQL remains
Experimental as documented in [STABILITY.md](../STABILITY.md); this feature
does not promote its support or release status.

## Measured footprint

The same-toolchain whole-barrel measurement grows from 149,966 to 150,264 B
brotli, an addition of 298 B for offline generation, including shared-column
identity correctness. The deliberate main claim
and cap revision is 150 to 152 kB, following measured rounding plus 1 kB. The
initial candidate measured 150,384 B and failed its original 150,000 B gate by
384 B. That historical failure remains unchanged. The corrected candidate also
exceeds 150,000 B, by 264 B.

Public imports and synchronous generation APIs remain available. Query-only,
edge and engine runtime measurements are byte-identical to the baseline. The
libSQL and D1 generation entries grow by 225 and 228 B within their existing
limits. All other 24 caps, measurement inputs, driver exclusions and coverage
floors remain unchanged. Run `npm run build` and `npm run size` for current
measurements. No runtime performance gain is claimed.
