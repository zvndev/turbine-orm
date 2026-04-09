# Turbine ORM — Agent Playbook

This repo ships a TypeScript Postgres ORM **and** its own marketing/docs site. Every release updates both.

## The two things in this repo

- **Library** — `src/`, `dist/`, `dist-cjs/`, published as `turbine-orm` on npm.
- **Site** — `site/` (Next.js 15 App Router), deployed to `turbineorm.dev` via Vercel project `zvn-dev/turbine-docs`.

## The release flow — do not skip steps

1. Do library work in `src/`, then run `npm run typecheck && npm run lint && npm run test:unit`.
2. Update `site/` content for anything user-facing that changed — new benchmarks, new API, new error codes, new CLI flags, changed defaults.
3. Update `CHANGELOG.md` with the new version section.
4. Bump version in root `package.json` (minor for features, patch for fixes).
5. Commit everything in a single commit: library + site + changelog + version bump.
6. Push to `origin/main`.
7. Publish to npm: `npm publish` (see npm auth note below).
8. Deploy the site: `cd site && vercel --prod` (or `npm run site:deploy` from the root).
9. Verify both:
   - `npm view turbine-orm version` should show the new version.
   - `curl -I https://turbineorm.dev` should return a fresh `Age` header (< 60s).
   - The homepage HTML should contain any new content you added.

**The rule is: no release is complete until both npm and turbineorm.dev reflect the new state.**

## Where the site lives

- Source: `site/` (don't touch `src/` for site changes and vice versa).
- Framework: Next.js 15 App Router, MDX pages, Tailwind, dark theme, Geist Mono.
- Vercel project: `zvn-dev/turbine-docs` (id `prj_mBx7ufQpteoX4m3q4TjEQNvkTvfD`).
- Domain: `turbineorm.dev` (managed via Vercel DNS on the ZVN DEV team).
- `site/` is a standalone Next.js app with its own `package.json` and `node_modules` — not a monorepo workspace. Run its scripts from inside `site/` or via the `site:*` root scripts.

## npm publish auth

This is the painful lesson from the 0.8.0 release. Read this before you publish.

- The project has a `.npmrc` (gitignored) that holds the publish token.
- `turbine-orm` has "Require two-factor authentication or a granular access token with bypass 2fa enabled" as its npm publish policy.
- Classic automation tokens and granular tokens **without** bypass 2FA will fail publish with `E403`.
- To fix: create a granular access token at https://www.npmjs.com/settings/kirby_zvndev/tokens/granular-access-tokens/new — name it something like `turbine-orm-publish`, check **"Bypass two-factor authentication (2FA)"**, scope to the `turbine-orm` package only, `Read and write` permission. Write it to the project `.npmrc` as `//registry.npmjs.org/:_authToken=npm_...`.
- The `prepublishOnly` npm script runs build + typecheck + lint + test, which takes ~25s — longer than the 30s OTP window — so if you're using an OTP-required flow instead of bypass, use `npm publish --ignore-scripts` and run the build separately first.

## Common pitfalls

- Don't skip updating `site/` when library behavior changes — the site will drift and Kirby will catch it.
- Don't put turbine-orm library imports in `site/` — the site is prose + code blocks, not a live demo.
- Don't create a separate repo for the site — that's exactly what caused the 14-day drift incident.
- Don't `git push` without also running `npm publish` + `vercel --prod` — per Kirby's stored preference, "push" = "deploy" for this project (every surface).

## Quick reference — commands you'll run on every release

```bash
# 1. Library checks
npm run typecheck && npm run lint && npm run test:unit

# 2. Version bump + commit + push
npm version <patch|minor|major> --no-git-tag-version
git add -A
git commit -m "release: vX.Y.Z"
git push origin main

# 3. Publish to npm
npm publish --ignore-scripts   # requires .npmrc with bypass-2fa token

# 4. Deploy the site
cd site && vercel --prod

# 5. Verify
npm view turbine-orm version
curl -sI https://turbineorm.dev | grep -i age
```
