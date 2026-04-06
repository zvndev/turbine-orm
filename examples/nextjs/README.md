# Turbine ORM — Next.js Example

A minimal Next.js app demonstrating Turbine ORM with server-rendered pages, nested relations, and streaming.

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Create a Postgres database
createdb turbine_demo

# 3. Configure connection
cp .env.example .env.local
# Edit .env.local with your DATABASE_URL

# 4. Push schema + seed data
npm run setup

# 5. Start dev server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## What it demonstrates

- **Server Components** fetching data with Turbine (zero client JS for data)
- **Single-query nested relations** — users with posts with comments in one SQL statement
- **4-level deep object graph** on the user detail page (user → org + posts → comments)
- **Live code examples** showing the TypeScript query alongside the generated SQL
- **Graceful fallback** when no database is connected

## Pages

| Route | What it shows |
|---|---|
| `/` | Hero + live query demo with code blocks |
| `/users` | User grid with nested post previews |
| `/users/[id]` | Full user profile with posts and comments |

## Project structure

```
app/
  layout.tsx          — Nav + global layout
  page.tsx            — Home page with code demos + live data
  lib/db.ts           — Turbine client singleton + types
  components/
    code-block.tsx    — Zero-dependency syntax highlighter
  users/
    page.tsx          — User list (findMany + nested posts)
    [id]/page.tsx     — User detail (findUnique + org + posts + comments)
turbine/
  schema.ts           — Turbine schema definition
  seed.ts             — Seed script with demo data
```
