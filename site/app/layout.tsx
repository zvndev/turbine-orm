import type { Metadata, Viewport } from 'next';
import { DM_Sans, JetBrains_Mono, Saira } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';
import { SPEED_CLAIM } from '../lib/bench';

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
  `The TypeScript ORM for Postgres, ${SPEED_CLAIM}. Nested data in one round trip, types down to the last relation, one dependency (pg), and read-only tools for coding agents. MIT.`;

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
      `The TypeScript ORM for Postgres. ${SPEED_CLAIM[0].toUpperCase()}${SPEED_CLAIM.slice(1)}, nested data in one round trip, one dependency. MIT.`,
    url: 'https://turbineorm.dev',
    siteName: 'Turbine ORM',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Turbine ORM: raw SQL speed, zero raw SQL',
    description:
      `The TypeScript ORM for Postgres. ${SPEED_CLAIM[0].toUpperCase()}${SPEED_CLAIM.slice(1)}, nested data in one round trip, one dependency. MIT.`,
  },
  // The ?v= suffix makes browsers drop a cached icon when the mark changes.
  icons: {
    icon: [
      { url: '/favicon.ico?v=2', sizes: '16x16 32x32 48x48' },
      { url: '/favicon.svg?v=2', type: 'image/svg+xml' },
    ],
    apple: '/apple-touch-icon.png?v=2',
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
