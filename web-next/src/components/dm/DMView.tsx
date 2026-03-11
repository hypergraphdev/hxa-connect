'use client';

import { useState, useEffect, useRef, Component, type ReactNode, type ErrorInfo } from 'react';
import { Loader2, ChevronUp, AlertTriangle } from 'lucide-react';
import * as api from '@/lib/api';
import type { DmMessage } from '@/lib/types';
import { cn, formatTime, parseParts } from '@/lib/utils';
import { useSession } from '@/hooks/useSession';
import { PartRenderer } from '@/components/ui/PartRenderer';
import { ImageLightbox } from '@/components/ui/ImageLightbox';
import { useTranslations } from '@/i18n/context';

// Error boundary for DM message parts — prevents malformed data from crashing entire DM view
class DmMessageErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[DmMessageErrorBoundary]', error, info);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-center gap-1 text-xs text-amber-400/70 italic">
          <AlertTriangle size={12} />
          <span>Failed to render message</span>
        </div>
      );
    }
    return this.props.children;
  }
}

interface DMViewProps {
  channelId: string;
  /** New messages from WS */
  wsDmMessages?: DmMessage[];
}

export function DMView({ channelId, wsDmMessages }: DMViewProps) {
  const { session } = useSession();
  const { t } = useTranslations();
  const [messages, setMessages] = useState<DmMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [cursor, setCursor] = useState<string | undefined>();
  const [hasOlder, setHasOlder] = useState(false);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);

  function handleScroll() {
    const el = containerRef.current;
    if (!el) return;
    userScrolledUp.current = el.scrollHeight - el.scrollTop - el.clientHeight > 100;
  }

  function scrollToBottom() {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setMessages([]);
    setCursor(undefined);
    setHasOlder(false);
    userScrolledUp.current = false;

    api.getChannelMessages(channelId, { limit: 50 })
      .then((res) => {
        if (cancelled) return;
        const msgs = res.messages;
        setMessages([...msgs].reverse());
        setCursor(msgs.length > 0 ? msgs[msgs.length - 1].id : undefined);
        setHasOlder(res.has_more);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [channelId]);

  useEffect(() => {
    if (!loading && messages.length > 0) {
      requestAnimationFrame(() => scrollToBottom());
    }
  }, [loading]); // eslint-disable-line react-hooks/exhaustive-deps

  // Merge WS messages
  useEffect(() => {
    if (!wsDmMessages?.length) return;
    setMessages((prev) => {
      const ids = new Set(prev.map((m) => m.id));
      const newMsgs = wsDmMessages.filter((m) => !ids.has(m.id) && m.channel_id === channelId);
      if (!newMsgs.length) return prev;
      return [...prev, ...newMsgs];
    });
    if (!userScrolledUp.current) {
      requestAnimationFrame(() => scrollToBottom());
    }
  }, [wsDmMessages, channelId]);

  async function loadOlder() {
    if (!cursor || loadingOlder) return;
    setLoadingOlder(true);
    const el = containerRef.current;
    const prevHeight = el?.scrollHeight ?? 0;

    try {
      const res = await api.getChannelMessages(channelId, { before: cursor, limit: 50 });
      const older = [...res.messages].reverse();
      setMessages((prev) => {
        const ids = new Set(prev.map((m) => m.id));
        return [...older.filter((m) => !ids.has(m.id)), ...prev];
      });
      setCursor(res.messages.length > 0 ? res.messages[res.messages.length - 1].id : undefined);
      setHasOlder(res.has_more);
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - prevHeight;
      });
    } catch {}
    setLoadingOlder(false);
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 size={24} className="animate-spin text-hxa-accent" />
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="shrink-0 px-4 py-3 border-b border-hxa-border bg-[rgba(10,15,26,0.4)]">
        <h2 className="text-sm font-semibold text-hxa-text">{t('dm.title')}</h2>
        <p className="text-[11px] text-hxa-text-muted mt-0.5">{t('dm.readOnlyNote')}</p>
      </div>

      {/* Messages */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-0"
      >
        {hasOlder && (
          <div className="text-center">
            <button
              onClick={loadOlder}
              disabled={loadingOlder}
              className="text-xs text-hxa-accent hover:text-hxa-accent-hover transition-colors disabled:opacity-50 inline-flex items-center gap-1"
            >
              {loadingOlder ? <Loader2 size={12} className="animate-spin" /> : <ChevronUp size={12} />}
              {t('dm.loadOlder')}
            </button>
          </div>
        )}

        {messages.length === 0 ? (
          <div className="text-center text-hxa-text-muted text-sm py-8">
            {t('dm.noMessages')}
          </div>
        ) : (
          messages.map((msg) => (
            <DmBubble key={msg.id} message={msg} isSelf={msg.sender_id === session?.bot_id} onImageClick={setLightboxSrc} />
          ))
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Read-only banner */}
      <div className="shrink-0 px-4 py-2.5 border-t border-hxa-border bg-hxa-bg-tertiary text-center text-xs text-hxa-text-muted">
        {t('dm.readOnlyBanner')}
      </div>

      {lightboxSrc && <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
    </div>
  );
}

function DmBubble({ message, isSelf, onImageClick }: { message: DmMessage; isSelf: boolean; onImageClick?: (url: string) => void }) {
  const { t } = useTranslations();
  return (
    <div className="group">
      <div className="flex items-center gap-2 mb-0.5">
        <span className={cn(
          'text-xs font-semibold',
          isSelf ? 'text-hxa-accent' : 'text-hxa-text-dim',
        )}>
          {message.sender_name}
        </span>
        <span className="text-[10px] text-hxa-text-muted">
          {formatTime(message.created_at, t)}
        </span>
      </div>
      <div className={cn(
        'rounded-lg px-3 py-2 text-sm leading-relaxed',
        isSelf
          ? 'bg-hxa-accent/10 border border-hxa-accent/15'
          : 'bg-white/[0.03] border border-white/[0.06]',
      )}>
        <DmMessageErrorBoundary>
          {parseParts(message.parts, message.content).map((part, i) => (
            <PartRenderer key={i} part={part} onImageClick={onImageClick} />
          ))}
        </DmMessageErrorBoundary>
      </div>
    </div>
  );
}

