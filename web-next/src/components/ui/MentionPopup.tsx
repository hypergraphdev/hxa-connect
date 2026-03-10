'use client';

import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { useTranslations } from '@/i18n/context';

export interface MentionCandidate {
  id: string;
  name: string;
  online?: boolean;
  isAll?: boolean;
}

interface MentionPopupProps {
  candidates: MentionCandidate[];
  query: string;
  selectedIndex: number;
  onSelect: (name: string) => void;
  onClose: () => void;
  onHover?: (index: number) => void;
  /** Anchor position (bottom-left of the popup) */
  anchor?: { bottom: number; left: number };
}

export function MentionPopup({ candidates, query, selectedIndex, onSelect, onClose, onHover, anchor }: MentionPopupProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslations();

  const filtered = candidates.filter((c) =>
    c.name.toLowerCase().includes(query.toLowerCase()),
  );

  // Scroll selected item into view
  useEffect(() => {
    const el = listRef.current?.children[selectedIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (filtered.length === 0) return null;

  return (
    <div
      ref={listRef}
      className="absolute z-50 bg-[#0d1a2d] border border-hxa-border rounded-lg shadow-2xl overflow-y-auto max-h-36 sm:max-h-48 min-w-[180px] left-0 right-0 sm:right-auto py-1"
      style={anchor ? { bottom: anchor.bottom, left: anchor.left } : { bottom: '100%', marginBottom: 4 }}
    >
      {filtered.map((c, i) => (
        <button
          key={c.id}
          onPointerDown={(e) => { e.preventDefault(); onSelect(c.name); }}
          onMouseEnter={() => onHover?.(i)}
          className={cn(
            'w-full text-left px-3 py-2.5 sm:py-1.5 text-sm flex items-center gap-2 transition-colors',
            i === selectedIndex ? 'bg-hxa-accent/15 text-hxa-text' : 'text-hxa-text-dim hover:bg-white/[0.04]',
          )}
        >
          {c.isAll ? (
            <span className="w-4 h-4 shrink-0 text-hxa-accent text-xs flex items-center justify-center">@</span>
          ) : (
            <span className={cn(
              'w-2 h-2 rounded-full shrink-0',
              c.online ? 'bg-hxa-green shadow-[0_0_4px] text-hxa-green' : 'bg-hxa-text-muted/40',
            )} />
          )}
          <span className="truncate">{c.isAll ? t('mention.all') : c.name}</span>
        </button>
      ))}
    </div>
  );
}

/** Extract @mention query from text at cursor position.
 *  Returns { query, startIndex } if cursor is inside a @mention, or null. */
export function extractMentionQuery(
  text: string,
  cursorPos: number,
): { query: string; startIndex: number } | null {
  // Walk backwards from cursor to find @
  const before = text.slice(0, cursorPos);
  const atIndex = before.lastIndexOf('@');
  if (atIndex < 0) return null;

  // @ must be at start of text or preceded by whitespace
  if (atIndex > 0 && !/\s/.test(before[atIndex - 1])) return null;

  const query = before.slice(atIndex + 1);

  // No spaces allowed in the query (mention is a single word)
  if (/\s/.test(query)) return null;

  return { query, startIndex: atIndex };
}
