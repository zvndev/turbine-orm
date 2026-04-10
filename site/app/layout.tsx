import type { Metadata } from 'next';
import { Bricolage_Grotesque, DM_Sans, JetBrains_Mono } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';

const bricolage = Bricolage_Grotesque({
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
  weight: ['400', '500', '600', '700', '800'],
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

export const metadata: Metadata = {
  title: {
    default: 'Turbine ORM — Postgres-native TypeScript ORM',
    template: '%s — Turbine ORM',
  },
  description:
    'Postgres-native TypeScript ORM. Single-query nested relations via json_agg. One dependency. Edge-ready. Typed errors. Deep type inference.',
  metadataBase: new URL('https://turbineorm.dev'),
  openGraph: {
    title: 'Turbine ORM',
    description:
      'Postgres-native TypeScript ORM with single-query nested relations, streaming cursors, typed errors, and deep with-clause type inference.',
    url: 'https://turbineorm.dev',
    siteName: 'Turbine ORM',
  },
  icons: {
    icon: '/favicon.svg',
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`dark ${bricolage.variable} ${dmSans.variable} ${jetbrains.variable}`}
    >
      <body className="font-sans">{children}</body>
    </html>
  );
}
