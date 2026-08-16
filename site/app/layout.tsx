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
    default: 'Turbine ORM, Postgres-native TypeScript ORM',
    template: '%s, Turbine ORM',
  },
  description:
    'A Postgres ORM written from scratch, with one runtime dependency (pg). Typed queries compiled straight to SQL, nested relations in one statement, an 11-tool read-only MCP server for coding agents, offline index advice, and migration guards. MIT.',
  metadataBase: new URL('https://turbineorm.dev'),
  openGraph: {
    title: 'Turbine ORM',
    description:
      'A Postgres ORM written from scratch. One dependency, no WASM. Nested relations in one statement, a read-only MCP server for agents, offline index advice, migration guards. MIT.',
    url: 'https://turbineorm.dev',
    siteName: 'Turbine ORM',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Turbine ORM',
    description:
      'A Postgres ORM written from scratch. One dependency, no WASM. Nested relations in one statement, read-only agent tools, offline index advice. MIT.',
  },
  icons: {
    icon: '/favicon.svg',
  },
  alternates: {
    canonical: 'https://turbineorm.dev',
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
