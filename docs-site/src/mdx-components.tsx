import type { MDXComponents } from 'mdx/types';
import { CodeBlock } from '@/components/CodeBlock';

export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    ...components,
    pre: ({ children, ...props }: React.ComponentProps<'pre'>) => {
      // Extract the code element's className for language detection
      const codeChild = children as React.ReactElement<{ className?: string; children?: React.ReactNode }>;
      const className = codeChild?.props?.className || '';
      return (
        <CodeBlock className={className}>
          <code className={className}>{codeChild?.props?.children ?? children}</code>
        </CodeBlock>
      );
    },
  };
}
