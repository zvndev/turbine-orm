import type { TurbineCliConfig } from 'turbine-orm/cli';

/**
 * A database does not name its relationships, so `turbine generate` composes a
 * name from the target table: the `author_id` foreign key on `stories`,
 * `comments` and `replies` all point at `users`, and all three come out as
 * `user`.
 *
 * This demo is about reading the object graph out loud
 * (`stories[0].comments[0].replies[0].author.handle`), so it renames them.
 * `relationNames` is the supported way to do that, and a name that resolves to
 * nothing is an error rather than a silent no-op, so this file cannot drift
 * away from the schema without `generate` saying so.
 *
 * The `.mts` extension is not a style choice: the repository's `.gitignore`
 * ignores `turbine.config.ts` outright (so a developer's own root config never
 * gets committed), which would leave this file out of a clone and the example
 * broken. `.mts` is the second entry in the CLI's config-file search order and
 * loads identically.
 */
const config: TurbineCliConfig = {
  schemaFile: './schema.ts',
  out: './generated/turbine',
  relationNames: {
    stories: { user: 'author' },
    comments: { user: 'author' },
    replies: { user: 'author' },
  },
};

export default config;
