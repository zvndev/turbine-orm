import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Turbine Blog",
    template: "%s | Turbine Blog",
  },
  description:
    "A demo blog powered by turbine-orm — deep nested Postgres queries, single round-trip.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} antialiased`}
    >
      <body className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col">
        <header className="border-b border-zinc-800/60 backdrop-blur-sm sticky top-0 z-50 bg-zinc-950/80">
          <nav className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
            <Link
              href="/"
              className="text-lg font-semibold tracking-tight hover:text-emerald-400 transition-colors flex items-center gap-2"
            >
              <span className="w-6 h-6 rounded bg-emerald-500/15 flex items-center justify-center">
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  className="w-3.5 h-3.5 text-emerald-400"
                >
                  <path
                    d="M8 1L14 5V11L8 15L2 11V5L8 1Z"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M8 5V11M5 7L8 5L11 7"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              turbine<span className="text-emerald-500">/</span>blog
            </Link>
            <div className="flex items-center gap-5 text-sm text-zinc-400">
              <Link
                href="/"
                className="hover:text-zinc-100 transition-colors"
              >
                Articles
              </Link>
              <Link
                href="/authors"
                className="hover:text-zinc-100 transition-colors"
              >
                Authors
              </Link>
              <Link
                href="/api/debug"
                className="hover:text-zinc-100 transition-colors font-mono text-xs bg-zinc-900 px-2.5 py-1 rounded-md border border-zinc-800 hover:border-emerald-500/30"
              >
                /api/debug
              </Link>
            </div>
          </nav>
        </header>

        <main className="flex-1">{children}</main>

        <footer className="border-t border-zinc-800/60 mt-auto">
          <div className="max-w-6xl mx-auto px-6 py-10">
            <div className="flex flex-col sm:flex-row items-center justify-between gap-6">
              <div className="flex flex-col items-center sm:items-start gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-zinc-400">Built with</span>
                  <code className="text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-0.5 rounded-md text-xs font-mono font-medium">
                    turbine-orm
                  </code>
                </div>
                <p className="text-xs text-zinc-600">
                  Deep nested Postgres queries. Single round-trip. Zero N+1.
                </p>
              </div>
              <div className="flex items-center gap-4 text-xs text-zinc-600">
                <Link href="/" className="hover:text-zinc-400 transition-colors">
                  Articles
                </Link>
                <Link href="/authors" className="hover:text-zinc-400 transition-colors">
                  Authors
                </Link>
                <Link href="/api/debug" className="hover:text-zinc-400 transition-colors font-mono">
                  Debug API
                </Link>
                <span className="text-zinc-800">|</span>
                <a
                  href="https://github.com/zvndev/turbine-orm"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-zinc-400 transition-colors"
                >
                  GitHub
                </a>
              </div>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
