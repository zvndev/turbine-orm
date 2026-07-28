/**
 * turbine-orm, fingerprint of the Prisma schema a `PRISMA_MAP` was generated
 * from.
 *
 * ## The failure this exists for
 *
 * `turbine migrate-from-prisma` reads `prisma/schema.prisma` and emits a
 * `prisma-map.ts` that the `turbine-orm/prisma-compat` adapter is driven by.
 * Nothing re-runs it. Add a model, rename a field, change a `@@unique` name, and
 * the map keeps describing the schema as it was: the adapter goes on translating
 * the names it knows and simply has no entry for the new ones. That surfaces as
 * "this model is not on the compat client" or a field silently absent from a
 * result, which reads like an adapter bug rather than a stale artifact, and
 * which is exactly the failure mode a code generator ought to be able to
 * announce about itself.
 *
 * So the generator records what it read, and the adapter checks that record
 * against what is on disk. This is the same shape as the unknown-config-key
 * check in `client.ts` and the parser-overwrite warning in `query/utils.ts`,
 * with a higher severity than either: those two produce visible breakage on
 * their own, and this one produces none at all.
 *
 * ## Why FNV-1a and not a cryptographic digest
 *
 * The question asked is "is this the same file", not "did an adversary craft a
 * collision". A collision costs one missed warning, so a 64-bit non-crypto hash
 * is the right instrument, and it keeps this module pure: no `node:crypto`, no
 * new dependency, and it is importable from the runtime adapter, from the CLI,
 * and from an edge bundle alike.
 *
 * ## Normalization
 *
 * Deliberately minimal, and only for differences that are not edits:
 *
 *  - a leading UTF-8 BOM, which some editors add and remove without being asked;
 *  - CRLF and lone CR line endings, so a Windows checkout of an unchanged file
 *    is not reported as drift (`core.autocrlf` rewrites on checkout);
 *  - whitespace at the very END of the file, for the same reason.
 *
 * Note the last one is end-of-FILE only, not per line. Trailing whitespace on an
 * individual line is hashed, and changing it is reported as drift. That is the
 * intended reading: nothing in a checkout rewrites it, so it got there because
 * someone edited the line, and the cost of an unnecessary regeneration is lower
 * than the cost of a missed one.
 *
 * Nothing else is normalized. Comments and blank lines are hashed as-is: a
 * "harmless" edit is still an edit, and reporting one costs a regeneration
 * nobody regrets, while normalizing one away risks silence on a real change
 * whose only visible trace happened to be a comment.
 */

import { fnv1a64Hex } from './query/utils.js';

/**
 * Fingerprint the TEXT of a Prisma schema file. Stable across line-ending and
 * BOM differences that a checkout can introduce (see the module doc), sensitive
 * to every other byte.
 *
 * The returned string is opaque and versioned by its `v1:` prefix: if the
 * normalization ever has to change, old maps carry the old prefix and can be
 * recognized rather than reported as drift against a rule they were not
 * generated under.
 */
export function fingerprintPrismaSchema(source: string): string {
  const normalized = source
    // Written as an escape, not the literal character: a bare BOM in source is
    // invisible in a diff and some tools strip it from the file it lives in.
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\s+$/, '');
  return `v1:${fnv1a64Hex(normalized)}`;
}
