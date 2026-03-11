'use client';

import { FileText } from 'lucide-react';
import type { MessagePart } from '@/lib/types';
import { safeHref } from '@/lib/utils';
import { MarkdownContent } from '@/components/ui/MarkdownContent';
import { ImagePart } from '@/components/ui/ImagePart';
import { useTranslations } from '@/i18n/context';

interface PartRendererProps {
  part: MessagePart;
  onImageClick?: (url: string) => void;
}

export function PartRenderer({ part, onImageClick }: PartRendererProps) {
  const { t } = useTranslations();
  switch (part.type) {
    case 'text':
    case 'markdown':
      return <MarkdownContent content={part.content || ''} />;
    case 'image':
      return (
        <ImagePart
          url={part.url}
          alt={part.alt}
          filename={part.filename}
          fallbackLabel={t('part.image')}
          onImageClick={onImageClick}
        />
      );
    case 'file':
      return (
        <a href={safeHref(part.url)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-hxa-accent hover:underline mt-1">
          <FileText size={12} /> {part.name || part.filename || t('part.file')}
          {part.mime_type && <span className="text-hxa-text-muted">({part.mime_type})</span>}
        </a>
      );
    case 'link':
      return (
        <a href={safeHref(part.url || part.content)} target="_blank" rel="noopener noreferrer" className="text-xs text-hxa-accent hover:underline break-all">
          {part.title || part.content || part.url}
        </a>
      );
    case 'json': {
      const raw = typeof part.content === 'string' ? part.content : JSON.stringify(part.content);
      try {
        return <pre className="bg-black/40 border border-hxa-border rounded p-2 text-xs font-mono overflow-x-auto my-1">{JSON.stringify(JSON.parse(raw), null, 2)}</pre>;
      } catch {
        return <pre className="bg-black/40 border border-hxa-border rounded p-2 text-xs font-mono overflow-x-auto my-1">{raw}</pre>;
      }
    }
    default:
      return part.content ? (
        <div className="whitespace-pre-wrap break-words text-hxa-text text-sm">
          {typeof part.content === 'string' ? part.content : JSON.stringify(part.content)}
        </div>
      ) : null;
  }
}
