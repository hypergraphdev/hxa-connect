'use client';

import { useState, useEffect, useCallback } from 'react';
import { useDashNav } from '@/app/dashboard/shell';
import { Loader2 } from 'lucide-react';
import * as api from '@/lib/api';
import type { DmChannelItem, DmMessage, Channel } from '@/lib/types';
import { cn, formatTime, parseParts } from '@/lib/utils';
import { useTranslations } from '@/i18n/context';

interface DMListProps {
  /** New DM messages from WS for sidebar preview update */
  wsDmMessages?: DmMessage[];
  /** New channels from WS */
  wsNewChannels?: Channel[];
}

export function DMList({ wsDmMessages, wsNewChannels }: DMListProps) {
  const { navigate, id: activeId } = useDashNav();
  const { t } = useTranslations();
  const [channels, setChannels] = useState<DmChannelItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [cursor, setCursor] = useState<string | undefined>();
  const [hasMore, setHasMore] = useState(false);

  const loadChannels = useCallback(async (reset: boolean) => {
    if (reset) {
      setLoading(true);
      setCursor(undefined);
    } else {
      setLoadingMore(true);
    }

    try {
      const res = await api.getWorkspace({
        dm_cursor: reset ? undefined : cursor,
        dm_limit: 30,
      });
      const items = res.dms.items;
      if (reset) {
        setChannels(items);
      } else {
        setChannels((prev) => {
          const ids = new Set(prev.map((c) => c.channel.id));
          return [...prev, ...items.filter((c) => !ids.has(c.channel.id))];
        });
      }
      setCursor(res.dms.next_cursor);
      setHasMore(res.dms.has_more);
    } catch {}
    setLoading(false);
    setLoadingMore(false);
  }, [cursor]);

  useEffect(() => {
    loadChannels(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Merge new DM channels from WS
  useEffect(() => {
    if (!wsNewChannels?.length) return;
    setChannels((prev) => {
      const ids = new Set(prev.map((c) => c.channel.id));
      const newItems = wsNewChannels
        .filter((ch) => !ids.has(ch.id))
        .map((ch) => ({
          channel: ch,
          counterpart_bot: { id: '', name: t('dm.newChannel'), online: false, bio: null, role: null },
          last_message_preview: null,
          last_activity_at: new Date(ch.created_at).getTime(),
        }));
      if (!newItems.length) return prev;
      return [...newItems, ...prev];
    });
  }, [wsNewChannels]);

  // Update last message preview from WS
  useEffect(() => {
    if (!wsDmMessages?.length) return;
    setChannels((prev) => {
      const updated = [...prev];
      for (const msg of wsDmMessages) {
        const idx = updated.findIndex((c) => c.channel.id === msg.channel_id);
        if (idx >= 0) {
          updated[idx] = {
            ...updated[idx],
            last_message_preview: {
              content: parseParts(msg.parts, msg.content)?.[0]?.content ?? '',
              sender_id: msg.sender_id,
              sender_name: msg.sender_name,
              created_at: new Date(msg.created_at).getTime(),
            },
            last_activity_at: new Date(msg.created_at).getTime(),
          };
          // Move to top
          const [item] = updated.splice(idx, 1);
          updated.unshift(item);
        }
      }
      return updated;
    });
  }, [wsDmMessages]);

  function handleClick(channelId: string) {
    navigate(`/dashboard/dms/${channelId}/`);
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto min-h-0">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={20} className="animate-spin text-hxa-accent" />
          </div>
        ) : channels.length === 0 ? (
          <div className="text-center text-hxa-text-muted text-sm py-8">
            {t('dm.empty')}
          </div>
        ) : (
          <div className="space-y-0.5 p-1">
            {channels.map((item) => (
              <button
                key={item.channel.id}
                onClick={() => handleClick(item.channel.id)}
                className={cn(
                  'w-full text-left px-3 py-2.5 rounded-lg transition-colors group',
                  activeId === item.channel.id
                    ? 'bg-hxa-accent/10 border border-hxa-accent/20'
                    : 'hover:bg-white/[0.03] border border-transparent',
                )}
              >
                <div className="flex items-center gap-2">
                  <span className={cn(
                    'w-2 h-2 rounded-full shrink-0',
                    item.counterpart_bot.online
                      ? 'bg-hxa-green shadow-[0_0_4px_currentColor] text-hxa-green'
                      : 'bg-hxa-text-muted',
                  )} />
                  <span className="text-sm font-medium text-hxa-text truncate group-hover:text-hxa-accent-hover transition-colors">
                    {item.counterpart_bot.name}
                  </span>
                </div>
                {item.last_message_preview && (
                  <div className="flex items-center gap-2 mt-1 ml-4">
                    <span className="text-[11px] text-hxa-text-muted truncate flex-1">
                      {item.last_message_preview.sender_name}: {item.last_message_preview.content}
                    </span>
                    <span className="text-[10px] text-hxa-text-muted shrink-0">
                      {formatTime(item.last_activity_at, t)}
                    </span>
                  </div>
                )}
              </button>
            ))}

            {hasMore && (
              <button
                onClick={() => loadChannels(false)}
                disabled={loadingMore}
                className="w-full py-2 text-xs text-hxa-accent hover:text-hxa-accent-hover transition-colors disabled:opacity-50"
              >
                {loadingMore ? <Loader2 size={14} className="animate-spin mx-auto" /> : t('dm.loadMore')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
