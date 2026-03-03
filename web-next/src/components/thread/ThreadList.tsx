'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useDashNav } from '@/app/dashboard/shell';
import { Search, Loader2 } from 'lucide-react';
import * as api from '@/lib/api';
import type { Thread, ThreadStatus } from '@/lib/types';
import { cn, formatTime, statusColor, THREAD_STATUS_OPTIONS } from '@/lib/utils';
import { FilterSelect } from '@/components/ui/FilterSelect';

interface ThreadListProps {
  /** Externally pushed threads from WS events */
  wsThreads?: Thread[];
}

export function ThreadList({ wsThreads }: ThreadListProps) {
  const { navigate, id: activeId } = useDashNav();
  const [threads, setThreads] = useState<Thread[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [cursor, setCursor] = useState<string | undefined>();
  const [hasMore, setHasMore] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const loadThreads = useCallback(async (reset: boolean) => {
    if (reset) {
      setLoading(true);
      setCursor(undefined);
    } else {
      setLoadingMore(true);
    }

    try {
      const res = await api.getThreads({
        q: search || undefined,
        status: statusFilter || undefined,
        cursor: reset ? undefined : cursor,
        limit: 30,
      });
      if (reset) {
        setThreads(res.items);
      } else {
        setThreads((prev) => {
          const ids = new Set(prev.map((t) => t.id));
          return [...prev, ...res.items.filter((t) => !ids.has(t.id))];
        });
      }
      setCursor(res.next_cursor);
      setHasMore(res.has_more);
    } catch {
      // Silently handle — could show toast in future
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [search, statusFilter, cursor]);

  // Initial load + reload on filter change
  useEffect(() => {
    loadThreads(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  // Debounced search
  function handleSearchInput(value: string) {
    setSearch(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      loadThreads(true);
    }, 300);
  }

  // Merge WS thread updates
  useEffect(() => {
    if (!wsThreads?.length) return;
    setThreads((prev) => {
      const updated = [...prev];
      for (const wt of wsThreads) {
        const idx = updated.findIndex((t) => t.id === wt.id);
        if (idx >= 0) {
          updated[idx] = wt;
        } else {
          updated.unshift(wt);
        }
      }
      return updated;
    });
  }, [wsThreads]);

  function handleClick(threadId: string) {
    navigate(`/dashboard/threads/${threadId}/`);
  }

  return (
    <div className="flex flex-col h-full">
      {/* Search + Filter */}
      <div className="p-2 space-y-2 shrink-0">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-hxa-text-muted" />
          <input
            type="text"
            placeholder="Search threads..."
            value={search}
            onChange={(e) => handleSearchInput(e.target.value)}
            className="w-full bg-black/30 border border-hxa-border rounded-lg pl-9 pr-3 py-2 text-sm text-hxa-text placeholder:text-hxa-text-muted outline-none focus:border-hxa-accent transition-colors"
          />
        </div>
        <FilterSelect
          options={THREAD_STATUS_OPTIONS}
          value={statusFilter}
          onChange={setStatusFilter}
        />
      </div>

      {/* Thread List */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={20} className="animate-spin text-hxa-accent" />
          </div>
        ) : threads.length === 0 ? (
          <div className="text-center text-hxa-text-muted text-sm py-8">
            No threads found
          </div>
        ) : (
          <div className="space-y-0.5 p-1">
            {threads.map((thread) => (
              <button
                key={thread.id}
                onClick={() => handleClick(thread.id)}
                className={cn(
                  'w-full text-left px-3 py-2.5 rounded-lg transition-colors group',
                  activeId === thread.id
                    ? 'bg-hxa-accent/10 border border-hxa-accent/20'
                    : 'hover:bg-white/[0.03] border border-transparent',
                )}
              >
                <div className="text-sm font-medium text-hxa-text truncate group-hover:text-hxa-accent-hover transition-colors">
                  {thread.topic}
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <span className={cn('text-[10px] font-semibold px-1.5 py-0.5 rounded border', statusColor(thread.status))}>
                    {thread.status}
                  </span>
                  <span className="text-[11px] text-hxa-text-muted">
                    {formatTime(thread.updated_at)}
                  </span>
                  {thread.message_count > 0 && (
                    <span className="text-[11px] text-hxa-text-muted ml-auto">
                      {thread.message_count} msg
                    </span>
                  )}
                </div>
              </button>
            ))}

            {/* Load more */}
            {hasMore && (
              <button
                onClick={() => loadThreads(false)}
                disabled={loadingMore}
                className="w-full py-2 text-xs text-hxa-accent hover:text-hxa-accent-hover transition-colors disabled:opacity-50"
              >
                {loadingMore ? (
                  <Loader2 size={14} className="animate-spin mx-auto" />
                ) : (
                  'Load more'
                )}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
