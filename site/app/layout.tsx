import type { Metadata, Viewport } from 'next';
import { DM_Sans, JetBrains_Mono, Saira } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';

// Display face: Saira with its width axis, set wide for headings.
const saira = Saira({
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
  axes: ['wdth'],
});

const dmSans = DM_Sans({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
});

const jetbrains = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
  weight: ['400', '500', '600'],
});

const description =
  'A TypeScript ORM for Postgres. Nested reads compile to one SQL statement you can read, with one runtime dependency (pg): no query engine, no WASM. Read-only MCP tools for coding agents, offline index advice, migration guards. MIT.';

export const metadata: Metadata = {
  title: {
    default: 'Turbine ORM, a TypeScript ORM for Postgres',
    template: '%s, Turbine ORM',
  },
  description,
  metadataBase: new URL('https://turbineorm.dev'),
  openGraph: {
    title: 'Turbine ORM: one query, any depth',
    description:
      'Nested reads in one SQL statement. One runtime dependency, no query engine, no WASM. A TypeScript ORM for Postgres, MIT.',
    url: 'https://turbineorm.dev',
    siteName: 'Turbine ORM',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Turbine ORM: one query, any depth',
    description:
      'Nested reads in one SQL statement. One runtime dependency, no query engine, no WASM. A TypeScript ORM for Postgres, MIT.',
  },
  icons: {
    icon: '/favicon.svg',
  },
  alternates: {
    canonical: 'https://turbineorm.dev',
  },
};

export const viewport: Viewport = {
  themeColor: '#05070b',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`dark ${saira.variable} ${dmSans.variable} ${jetbrains.variable}`}>
      <head>
        {/* Little Friend analytics. It tracks client-side navigations itself, so it loads once here. */}
        <script defer src="https://cdn.littlefriend.io/lf.js" data-site="lf_lPpOvu9zeRrHMLiQjS8IwAyp" data-mode="journey" />
      </head>
      <body className="font-sans">{children}</body>
    </html>
  );
}
