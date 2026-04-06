/**
 * Minimal syntax highlighter — no dependencies.
 * Handles TypeScript/SQL keywords, strings, comments, numbers.
 */

function highlightCode(code: string, language: 'typescript' | 'sql' | 'json'): string {
  if (language === 'json') {
    return code
      .replace(/("(?:[^"\\]|\\.)*")(\s*:)/g, '<span class="token-property">$1</span>$2')
      .replace(/:\s*("(?:[^"\\]|\\.)*")/g, ': <span class="token-string">$1</span>')
      .replace(/:\s*(\d+)/g, ': <span class="token-number">$1</span>')
      .replace(/:\s*(true|false|null)/g, ': <span class="token-keyword">$1</span>');
  }

  const tsKeywords =
    /\b(const|let|var|await|async|for|of|import|from|export|type|interface|function|return|if|else|new|true|false|null|undefined|as|with)\b/g;
  const sqlKeywords =
    /\b(SELECT|FROM|WHERE|JOIN|LEFT|LATERAL|ON|AS|ORDER|BY|LIMIT|COALESCE|json_agg|json_build_object|AND|OR|IN|NOT|NULL|ASC|DESC|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|DROP|ALTER)\b/gi;

  let result = code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Comments
  result = result.replace(/(\/\/.*$)/gm, '<span class="token-comment">$1</span>');
  result = result.replace(/(--.*$)/gm, '<span class="token-comment">$1</span>');

  // Strings
  result = result.replace(/('(?:[^'\\]|\\.)*')/g, '<span class="token-string">$1</span>');
  result = result.replace(
    /(?<!class=)("(?:[^"\\]|\\.)*")/g,
    '<span class="token-string">$1</span>',
  );
  result = result.replace(/(`(?:[^`\\]|\\.)*`)/g, '<span class="token-string">$1</span>');

  // Keywords
  if (language === 'typescript') {
    result = result.replace(tsKeywords, '<span class="token-keyword">$1</span>');
    result = result.replace(/\b(\d+)\b/g, '<span class="token-number">$1</span>');
    result = result.replace(
      /\b(db|users|posts|comments|findMany|findUnique|findManyStream|create|update|delete|pipeline|raw|table)\b/g,
      '<span class="token-function">$1</span>',
    );
  } else if (language === 'sql') {
    result = result.replace(sqlKeywords, (m) => `<span class="token-keyword">${m}</span>`);
    result = result.replace(/(\$\d+)/g, '<span class="token-number">$1</span>');
  }

  return result;
}

export function CodeBlock({
  code,
  language = 'typescript',
  title,
}: {
  code: string;
  language?: 'typescript' | 'sql' | 'json';
  title?: string;
}) {
  const highlighted = highlightCode(code.trim(), language);

  return (
    <div className="rounded-xl overflow-hidden border border-zinc-800 bg-zinc-950">
      {title && (
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-zinc-800 bg-zinc-900/50">
          <div className="flex gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full bg-zinc-700" />
            <div className="w-2.5 h-2.5 rounded-full bg-zinc-700" />
            <div className="w-2.5 h-2.5 rounded-full bg-zinc-700" />
          </div>
          <span className="text-xs text-zinc-500 font-mono ml-2">{title}</span>
        </div>
      )}
      <pre className="p-5 overflow-x-auto text-sm leading-relaxed">
        <code
          className="font-mono text-zinc-300"
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      </pre>
    </div>
  );
}
