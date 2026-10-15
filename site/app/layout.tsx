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
  'The TypeScript ORM for Postgres that runs within 8% of hand-written SQL. Nested data in one round trip, types down to the last relation, one dependency (pg), and read-only tools for coding agents. MIT.';

export const metadata: Metadata = {
  title: {
    default: 'Turbine ORM, a TypeScript ORM for Postgres',
    template: '%s, Turbine ORM',
  },
  description,
  metadataBase: new URL('https://turbineorm.dev'),
  openGraph: {
    title: 'Turbine ORM: raw SQL speed, zero raw SQL',
    description:
      'The TypeScript ORM for Postgres. Within 8% of hand-written SQL, nested data in one round trip, one dependency. MIT.',
    url: 'https://turbineorm.dev',
    siteName: 'Turbine ORM',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Turbine ORM: raw SQL speed, zero raw SQL',
    description:
      'The TypeScript ORM for Postgres. Within 8% of hand-written SQL, nested data in one round trip, one dependency. MIT.',
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
