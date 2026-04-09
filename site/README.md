# turbineorm.dev

Documentation site for [turbine-orm](https://www.npmjs.com/package/turbine-orm).

This app is a fully independent Next.js 15 project that lives inside the main
`turbine-orm` repository. The library code in `../src` is **not** imported —
all content is static MDX in `app/*/page.mdx`.

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
home of `https://turbineorm.dev`). The main thread handles the deploy — see
`AGENTS.md` at the repo root for the current flow. Typically:

```bash
cd site
vercel link   # first time only
vercel --prod
```

## Editing content

Every page is an MDX file under `app/<slug>/page.mdx`. Add new pages by
creating a new route folder and dropping a `page.mdx` in it, then add a link
to `components/Sidebar.tsx`.

Code blocks are highlighted by [rehype-pretty-code](https://rehype-pretty.pages.dev/)
(Shiki under the hood). The theme is configured in `next.config.mjs`.

## Stack

- Next.js 15 (App Router)
- React 19 RC
- Tailwind CSS 3
- `@next/mdx` + `@mdx-js/react`
- `rehype-pretty-code` + Shiki for syntax highlighting
- `next/font/google` — Geist Mono (headings + code) and Inter (body)
