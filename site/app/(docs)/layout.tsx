import type { ReactNode } from 'react';
import { Sidebar } from '../../components/Sidebar';

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 min-w-0 md:ml-[260px]">
        <div className="max-w-content mx-auto px-6 md:px-10 py-12 pb-24">
          <div className="mdx-content">{children}</div>
        </div>
      </main>
    </div>
  );
}
