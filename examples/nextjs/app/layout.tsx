import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Turbine ORM — Next.js Example',
  description: 'Postgres-native TypeScript ORM with single-query nested relations',
};

function Nav() {
  return (
    <nav className="fixed top-0 left-0 right-0 z-50 backdrop-blur-md bg-white/80 border-b border-zinc-100">
      <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
        <a href="/" className="flex items-center gap-2.5">
          <div className="w-6 h-6 rounded-md bg-zinc-900 flex items-center justify-center">
            <span className="text-white text-xs font-bold">T</span>
          </div>
          <span className="font-semibold text-zinc-900 text-sm tracking-tight">
            Turbine
          </span>
        </a>
        <div className="flex items-center gap-6">
          <a
            href="/users"
            className="text-sm text-zinc-500 hover:text-zinc-900 transition-colors"
          >
            Users
          </a>
          <a
            href="https://github.com/zvndev/turbine-orm"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-zinc-500 hover:text-zinc-900 transition-colors"
          >
            GitHub
          </a>
          <a
            href="https://www.npmjs.com/package/turbine-orm"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-zinc-500 hover:text-zinc-900 transition-colors"
          >
            npm
          </a>
        </div>
      </div>
    </nav>
  );
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-white text-zinc-900 font-sans antialiased">
        <Nav />
        <main className="pt-14">{children}</main>
      </body>
    </html>
  );
}
