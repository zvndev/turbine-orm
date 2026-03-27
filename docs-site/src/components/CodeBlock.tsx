'use client';

import { useRef, type ReactNode } from 'react';
import { CopyButton } from './CopyButton';

interface CodeBlockProps {
  children: ReactNode;
  className?: string;
}

export function CodeBlock({ children, className }: CodeBlockProps) {
  const preRef = useRef<HTMLPreElement>(null);

  const getTextContent = (): string => {
    if (preRef.current) {
      return preRef.current.textContent || '';
    }
    return '';
  };

  // Extract language from className like "language-typescript"
  const lang = className?.replace('language-', '') || '';

  const langLabel: Record<string, string> = {
    typescript: 'TypeScript',
    ts: 'TypeScript',
    javascript: 'JavaScript',
    js: 'JavaScript',
    bash: 'Terminal',
    sh: 'Terminal',
    shell: 'Terminal',
    sql: 'SQL',
    json: 'JSON',
    tsx: 'TSX',
    jsx: 'JSX',
  };

  return (
    <div className="relative group mb-4">
      {lang && langLabel[lang] && (
        <div
          className="absolute top-0 left-0 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider rounded-br-md rounded-tl-lg"
          style={{
            color: 'var(--text-muted)',
            background: 'rgba(255,255,255,0.03)',
            borderRight: '1px solid var(--border)',
            borderBottom: '1px solid var(--border)',
          }}
        >
          {langLabel[lang]}
        </div>
      )}
      <pre ref={preRef} className={className} style={{ paddingTop: lang && langLabel[lang] ? '32px' : undefined }}>
        {children}
      </pre>
      <div className="opacity-0 group-hover:opacity-100 transition-opacity">
        <CopyButton text={getTextContent()} />
      </div>
    </div>
  );
}
