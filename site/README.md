# turbineorm.dev

Documentation site for [turbine-orm](https://www.npmjs.com/package/turbine-orm).

This app is a fully independent Next.js project (currently on `next@^16`) that
lives inside the main `turbine-orm` repository. The library code in `../src` is
**not** imported. All content is static MDX in `app/(docs)/*/page.mdx`.

## Local development

```bash
cd site
npm install
npm run dev
```

Open http://localhost:3000.

## Build

```bash
npm run build
npm start
```

## Deploy

The site deploys to the Vercel project `zvn-dev/turbine-docs` (the canonical
home of `https://turbineorm.dev`). The main thread handles the deploy, see
`AGENTS.md` at the repo root for the current flow. Typically:

```bash
cd site
vercel link   # first time only
vercel --prod
```

## Editing content

Every docs page is an MDX file under `app/(docs)/<slug>/page.mdx`. Adding a new
page means four edits, not one:

1. Create `app/(docs)/<slug>/page.mdx` with an exported `metadata` object
   including `alternates.canonical`.
2. Add the route to `components/Sidebar.tsx`.
3. Add the route to `app/sitemap.ts`.
4. Add the route to `public/llms.txt`.

Two components are available in every MDX file without an import, because
`mdx-components.tsx` provides them: `<Callout type="note|warning|tip" title="...">`
for boxed asides, and `h2` / `h3` are wrapped to render a hover-revealed anchor
link from the id `rehype-slug` already stamped.

Version and changelog content is generated, never hand-written:
`lib/version.ts` and `lib/changelog.generated.ts` are rebuilt from the root
`package.json` and `CHANGELOG.md` by the `predev` / `prebuild` scripts. Import
`TURBINE_VERSION` rather than typing a version into prose. The landing hero
tagline comes from `lib/tagline.ts`, which derives from the changelog and
allows a per-version manual override.

Code blocks are highlighted by [rehype-pretty-code](https://rehype-pretty.pages.dev/)
(Shiki under the hood). The theme is configured in `next.config.mjs`.

## Stack

- Next.js 16 (App Router); see `package.json` for the exact pin
- React 19
- Tailwind CSS 3
- `@next/mdx` + `@mdx-js/react`
- `rehype-pretty-code` + Shiki for syntax highlighting
- `next/font/google`, Geist Mono (headings + code) and Inter (body)
