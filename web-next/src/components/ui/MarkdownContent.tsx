'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';

const components = {
  h1: ({ children, ...props }: React.ComponentProps<'h1'>) => <h1 className="text-lg font-bold text-hxa-text mt-2 mb-1" {...props}>{children}</h1>,
  h2: ({ children, ...props }: React.ComponentProps<'h2'>) => <h2 className="text-base font-bold text-hxa-text mt-2 mb-1" {...props}>{children}</h2>,
  h3: ({ children, ...props }: React.ComponentProps<'h3'>) => <h3 className="text-sm font-bold text-hxa-text mt-1.5 mb-0.5" {...props}>{children}</h3>,
  p: ({ children, ...props }: React.ComponentProps<'p'>) => <p className="mb-1 last:mb-0" {...props}>{children}</p>,
  a: ({ children, ...props }: React.ComponentProps<'a'>) => <a className="text-hxa-accent hover:underline" target="_blank" rel="noopener noreferrer" {...props}>{children}</a>,
  code: ({ children, className, ...props }: React.ComponentProps<'code'> & { className?: string }) => {
    const isBlock = className?.includes('language-');
    if (isBlock) {
      return <code className={cn('text-xs', className)} {...props}>{children}</code>;
    }
    return <code className="bg-black/30 px-1 py-0.5 rounded text-xs font-mono text-hxa-accent" {...props}>{children}</code>;
  },
  pre: ({ children, ...props }: React.ComponentProps<'pre'>) => <pre className="bg-black/40 border border-hxa-border rounded p-2 text-xs font-mono overflow-x-auto my-1" {...props}>{children}</pre>,
  ul: ({ children, ...props }: React.ComponentProps<'ul'>) => <ul className="list-disc list-inside mb-1" {...props}>{children}</ul>,
  ol: ({ children, ...props }: React.ComponentProps<'ol'>) => <ol className="list-decimal list-inside mb-1" {...props}>{children}</ol>,
  li: ({ children, ...props }: React.ComponentProps<'li'>) => <li className="mb-0.5" {...props}>{children}</li>,
  blockquote: ({ children, ...props }: React.ComponentProps<'blockquote'>) => <blockquote className="border-l-2 border-hxa-accent/40 pl-3 my-1 text-hxa-text-dim italic" {...props}>{children}</blockquote>,
  table: ({ children, ...props }: React.ComponentProps<'table'>) => <div className="overflow-x-auto my-1"><table className="text-xs border-collapse" {...props}>{children}</table></div>,
  th: ({ children, ...props }: React.ComponentProps<'th'>) => <th className="border border-hxa-border px-2 py-1 text-left font-semibold bg-black/20" {...props}>{children}</th>,
  td: ({ children, ...props }: React.ComponentProps<'td'>) => <td className="border border-hxa-border px-2 py-1" {...props}>{children}</td>,
  hr: (props: React.ComponentProps<'hr'>) => <hr className="border-hxa-border my-2" {...props} />,
};

export function MarkdownContent({ content }: { content: string }) {
  return (
    <div className="break-words text-hxa-text max-w-none">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
