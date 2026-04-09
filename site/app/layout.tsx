import type { Metadata } from 'next';
import { Geist_Mono, Inter } from 'next/font/google';
import type { ReactNode } from 'react';
import { Sidebar } from '../components/Sidebar';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
});

const geistMono = Geist_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    default: 'Turbine ORM — Postgres-native TypeScript ORM',
    template: '%s — Turbine ORM',
  },
  description:
    'Postgres-native TypeScript ORM. Single-query nested relations via json_agg. One dependency. Edge-ready. Typed errors. Streaming cursors.',
  metadataBase: new URL('https://turbineorm.dev'),
  openGraph: {
    title: 'Turbine ORM',
    description:
      'Postgres-native TypeScript ORM with single-query nested relations, streaming cursors, typed errors.',
    url: 'https://turbineorm.dev',
    siteName: 'Turbine ORM',
  },
  icons: {
    icon: '/favicon.svg',
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`dark ${inter.variable} ${geistMono.variable}`}>
      <body className="font-sans">
        <div className="flex min-h-screen">
          <Sidebar />
          <main className="flex-1 min-w-0 md:ml-[260px]">
            <div className="max-w-content mx-auto px-6 md:px-10 py-12 pb-24">
              <div className="mdx-content">{children}</div>
            </div>
          </main>
        </div>
      </body>
    </html>
  );
}
