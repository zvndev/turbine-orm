# Turbine ORM — Agent Playbook

This repo ships a TypeScript Postgres ORM **and** its own marketing/docs site. Every release updates both.

## The two things in this repo

- **Library** — `src/`, `dist/` (ESM) + `dist/cjs/` (CJS), published as `turbine-orm` on npm.
- **Site** — `site/` (Next.js 15 App Router), deployed to `turbineorm.dev` via Vercel project `zvn-dev/turbine-docs`.

## The release flow — do not skip steps

1. Do library work in `src/`, then run `npm run typecheck && npm run lint && npm run test:unit`.
2. Update `site/` content for anything user-facing that changed — new benchmarks, new API, new error codes, new CLI flags, changed defaults.
3. **Drift check** — grep README.md, CLAUDE.md, and `site/` for claims the release invalidates (feature descriptions, version strings, security-posture bullets). Three separate stale-docs findings in the v0.19.0 audit traced to skipping this.
4. Update `CHANGELOG.md` with the new version section.
5. Bump version in root `package.json` (minor for features, patch for fixes).
6. **Regenerate site version file** — `node site/scripts/gen-version.mjs` so committed `site/lib/version.ts` matches the bumped version (Vercel prebuild also regenerates it, but the git tree must not lag).
7. **Consumer install smoke (mandatory)** — pack + install into a fresh temp dir and prove a *new user* can typecheck and import:
   ```bash
   npm pack --silent
   SMOKE=$(mktemp -d) && cd "$SMOKE" && npm init -y >/dev/null
   npm install "$OLDPWD"/turbine-orm-*.tgz typescript --no-fund
   # strict tsc WITHOUT skipLibCheck — catches missing @types/* that our .d.ts import
   printf '%s\n' '{"compilerOptions":{"strict":true,"module":"nodenext","moduleResolution":"nodenext","noEmit":true,"skipLibCheck":false}}' > tsconfig.json
   printf '%s\n' "import { TurbineClient, NotFoundError } from 'turbine-orm';" "const _ = TurbineClient;" "const e = new NotFoundError();" > app.ts
   npx tsc -p .
   node --input-type=module -e "import { TurbineClient } from 'turbine-orm'; console.log(typeof TurbineClient)"
   node -e "const m=require('turbine-orm'); if(!m.TurbineClient) process.exit(1)"
   ```
   **Never** move `@types/pg` (or any types package our public `.d.ts` re-exports/`import type`s from) into `devDependencies` only — consumers need them. Runtime deps stay minimal (`pg`); types packages that appear in published `.d.ts` files stay in `dependencies`. The 0.28.1 smoke audit caught this after ship.
8. Commit everything in a single commit: library + site + changelog + version bump + regenerated `site/lib/version.ts`.
9. Push to `origin/main`.
10. Publish to npm: `npm publish` (see npm auth note below).
11. Deploy the site **from the repo root** (Vercel Root Directory is `site` — do **not** `cd site && vercel`, that resolves `site/site`):
    ```bash
    # from repo root, with .vercel/project.json pointing at turbine-docs
    npx vercel --prod --yes
    ```
12. Tag the release: `git tag vX.Y.Z && git push origin vX.Y.Z` and open a GitHub Release.
13. Verify both:
    - `npm view turbine-orm version` should show the new version.
    - Fresh-temp `npm install turbine-orm@X.Y.Z && npx tsc --strict …` still green (post-publish re-check).
    - `curl -I https://turbineorm.dev` and docs chrome show the new version.

**The rule is: no release is complete until both npm and turbineorm.dev reflect the new state, and a stranger can `npm i` + strict-typecheck.**

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
- **Don't ship without a consumer pack-install + strict `tsc` smoke** — the 0.28.1 `@types/pg`→devDependencies move passed all *repo* gates and still broke new users' typecheck. Repo typecheck uses our own `devDependencies`; strangers do not.
- Don't run `vercel --prod` from inside `site/` when the Vercel project Root Directory is already `site` (paths become `site/site`). Deploy from the monorepo root.

## Quick reference — commands you'll run on every release

```bash
# 1. Library checks
npm run typecheck && npm run lint && npm run test:unit

# 2. Version bump + site version file + consumer smoke (see step 7 above)
npm version <patch|minor|major> --no-git-tag-version
node site/scripts/gen-version.mjs
# … pack + temp strict tsc smoke …

# 3. Commit + push
git add -A
git commit -m "release: vX.Y.Z"
git push origin main

# 4. Publish to npm
npm publish   # .npmrc bypass-2fa token; prepublishOnly runs gates

# 5. Deploy the site (from REPO ROOT)
npx vercel --prod --yes

# 6. Tag + GitHub Release
git tag vX.Y.Z && git push origin vX.Y.Z

# 7. Verify
npm view turbine-orm version
curl -sI https://turbineorm.dev | grep -i age
```
