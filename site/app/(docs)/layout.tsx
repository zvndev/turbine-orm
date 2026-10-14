import type { ReactNode } from 'react';
import { Sidebar } from '../../components/Sidebar';

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <Sidebar />
      <main id="main" className="docs-main">
        <article className="docs-article">
          <div className="mdx-content">{children}</div>
        </article>
      </main>
    </div>
  );
}
