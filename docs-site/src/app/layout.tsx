import type { Metadata } from 'next';
import { Sidebar } from '@/components/Sidebar';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Turbine ORM - Documentation',
    template: '%s | Turbine ORM',
  },
  description:
    'The performance-first TypeScript Postgres ORM. Prisma-compatible API, 2-3x faster nested queries via json_agg, zero runtime overhead beyond pg.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="font-sans">
        <div className="flex min-h-screen">
          <Sidebar />
          <main
            className="flex-1 min-w-0 md:ml-[260px]"
          >
            <div className="max-w-content mx-auto px-6 md:px-10 py-12 pb-20">
              <div className="mdx-content">{children}</div>
            </div>
          </main>
        </div>
      </body>
    </html>
  );
}
