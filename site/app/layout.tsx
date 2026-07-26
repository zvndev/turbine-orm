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
    'Postgres-native TypeScript ORM built for a database with real rows in it: a read-only-by-default Studio, PII enforced in the emitted SQL, errors that carry keys not values, and destructive migrations that require consent. One dependency, edge-ready, deep type inference.',
  metadataBase: new URL('https://turbineorm.dev'),
  openGraph: {
    title: 'Turbine ORM',
    description:
      'Postgres-native TypeScript ORM: read-only-by-default Studio, PII enforced in the SQL, errors that never carry values, consent-gated destructive migrations, one dependency, deep with-clause type inference.',
    url: 'https://turbineorm.dev',
    siteName: 'Turbine ORM',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Turbine ORM',
    description:
      'Postgres-native TypeScript ORM. Read-only-by-default Studio, PII enforced in the SQL, errors that never carry values. One dependency. Edge-ready.',
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
