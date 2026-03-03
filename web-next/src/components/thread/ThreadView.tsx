'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Loader2, ChevronUp, Send, FileText, User, Clock } from 'lucide-react';
import * as api from '@/lib/api';
import type { Thread, ThreadMessage, MessagePart, ThreadStatus } from '@/lib/types';
import { cn, formatTime, statusColor } from '@/lib/utils';
import { useSession } from '@/hooks/useSession';

interface ThreadViewProps {
  threadId: string;
  /** New messages pushed from WS */
  wsMessages?: ThreadMessage[];
  /** Thread metadata updates from WS */
  wsThread?: Thread;
  /** Thread status change from WS (for updating composer state) */
  wsThreadStatusChange?: { thread_id: string; to: ThreadStatus };
  onOpenArtifacts?: () => void;
}

export function ThreadView({ threadId, wsMessages, wsThread, wsThreadStatusChange, onOpenArtifacts }: ThreadViewProps) {
  const { session } = useSession();
  const [thread, setThread] = useState<Thread | null>(null);
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [cursor, setCursor] = useState<string | undefined>();
  const [hasOlder, setHasOlder] = useState(false);
  const [composerText, setComposerText] = useState('');
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Track scroll position
  function handleScroll() {
    const el = containerRef.current;
    if (!el) return;
    // "Near bottom" = within 100px of bottom
    userScrolledUp.current = el.scrollHeight - el.scrollTop - el.clientHeight > 100;
  }

  function scrollToBottom() {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }

  // Load thread + initial messages
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setMessages([]);
    setCursor(undefined);
    setHasOlder(false);
    userScrolledUp.current = false;

    (async () => {
      try {
        const [threadData, msgData] = await Promise.all([
          api.getThread(threadId),
          api.getThreadMessages(threadId, { limit: 50 }),
        ]);
        if (cancelled) return;
        setThread(threadData);
        // API returns newest-first, reverse for display
        setMessages(msgData.items.reverse());
        setCursor(msgData.next_cursor);
        setHasOlder(msgData.has_more);
      } catch { /* toast in future */ }
      if (!cancelled) setLoading(false);
    })();

    return () => { cancelled = true; };
  }, [threadId]);

  // Scroll to bottom on initial load
  useEffect(() => {
    if (!loading && messages.length > 0) {
      // Use requestAnimationFrame for reliable scroll after render
      requestAnimationFrame(() => scrollToBottom());
    }
  }, [loading]); // eslint-disable-line react-hooks/exhaustive-deps

  // Merge WS messages
  useEffect(() => {
    if (!wsMessages?.length) return;
    setMessages((prev) => {
      const ids = new Set(prev.map((m) => m.id));
      const newMsgs = wsMessages.filter((m) => !ids.has(m.id) && m.thread_id === threadId);
      if (!newMsgs.length) return prev;
      return [...prev, ...newMsgs];
    });
    // Auto-scroll if user is near bottom
    if (!userScrolledUp.current) {
      requestAnimationFrame(() => scrollToBottom());
    }
  }, [wsMessages, threadId]);

  // Merge WS thread updates
  useEffect(() => {
    if (wsThread && wsThread.id === threadId) {
      setThread(wsThread);
    }
  }, [wsThread, threadId]);

  // Handle WS thread status changes (e.g. resolved/closed by another participant)
  useEffect(() => {
    if (wsThreadStatusChange && wsThreadStatusChange.thread_id === threadId) {
      setThread((prev) => prev ? { ...prev, status: wsThreadStatusChange.to } : prev);
    }
  }, [wsThreadStatusChange, threadId]);

  // Load older messages
  async function loadOlder() {
    if (!cursor || loadingOlder) return;
    setLoadingOlder(true);
    const el = containerRef.current;
    const prevHeight = el?.scrollHeight ?? 0;

    try {
      const res = await api.getThreadMessages(threadId, { cursor, limit: 50 });
      const older = res.items.reverse();
      setMessages((prev) => {
        const ids = new Set(prev.map((m) => m.id));
        return [...older.filter((m) => !ids.has(m.id)), ...prev];
      });
      setCursor(res.next_cursor);
      setHasOlder(res.has_more);
      // Preserve scroll position
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - prevHeight;
      });
    } catch { /* toast in future */ }
    setLoadingOlder(false);
  }

  // Send message
  async function handleSend() {
    const text = composerText.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const msg = await api.sendThreadMessage(threadId, text);
      setMessages((prev) => {
        if (prev.some((m) => m.id === msg.id)) return prev;
        return [...prev, msg];
      });
      setComposerText('');
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
      requestAnimationFrame(() => scrollToBottom());
    } catch { /* toast in future */ }
    setSending(false);
  }

  // Keyboard handler
  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  // Auto-resize textarea
  function handleTextareaInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setComposerText(e.target.value);
    const ta = e.target;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 150) + 'px';
  }

  const canSend = thread && !['resolved', 'closed', 'archived'].includes(thread.status);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 size={24} className="animate-spin text-hxa-accent" />
      </div>
    );
  }

  if (!thread) {
    return (
      <div className="flex-1 flex items-center justify-center text-hxa-text-dim text-sm">
        Thread not found
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Thread Header */}
      <div className="shrink-0 px-4 py-3 border-b border-hxa-border bg-[rgba(10,15,26,0.4)] flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold text-hxa-text truncate">{thread.topic}</h2>
          <div className="flex items-center gap-2 mt-0.5">
            <span className={cn('text-[10px] font-semibold px-1.5 py-0.5 rounded border', statusColor(thread.status))}>
              {thread.status}
            </span>
            <span className="text-[11px] text-hxa-text-muted flex items-center gap-1">
              <User size={10} /> {thread.participant_count}
            </span>
            <span className="text-[11px] text-hxa-text-muted flex items-center gap-1">
              <Clock size={10} /> {formatTime(thread.created_at)}
            </span>
          </div>
        </div>
        {onOpenArtifacts && (
          <button
            onClick={onOpenArtifacts}
            className="text-xs text-hxa-accent border border-hxa-accent/30 px-2.5 py-1.5 rounded-md hover:bg-hxa-accent/10 transition-colors flex items-center gap-1"
          >
            <FileText size={12} /> Artifacts
          </button>
        )}
      </div>

      {/* Messages */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-0"
      >
        {/* Load older */}
        {hasOlder && (
          <div className="text-center">
            <button
              onClick={loadOlder}
              disabled={loadingOlder}
              className="text-xs text-hxa-accent hover:text-hxa-accent-hover transition-colors disabled:opacity-50 inline-flex items-center gap-1"
            >
              {loadingOlder ? <Loader2 size={12} className="animate-spin" /> : <ChevronUp size={12} />}
              Load older messages
            </button>
          </div>
        )}

        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} isSelf={msg.sender_id === session?.bot.id} />
        ))}

        <div ref={messagesEndRef} />
      </div>

      {/* Composer */}
      {canSend && (
        <div className="shrink-0 px-4 py-3 border-t border-hxa-border bg-[rgba(10,15,26,0.4)]">
          <div className="flex gap-2 items-end">
            <textarea
              ref={textareaRef}
              value={composerText}
              onChange={handleTextareaInput}
              onKeyDown={handleKeyDown}
              placeholder="Type a message... (Enter to send, Shift+Enter for newline)"
              rows={1}
              className="flex-1 bg-black/30 border border-hxa-border rounded-lg px-3 py-2.5 text-sm text-hxa-text placeholder:text-hxa-text-muted outline-none focus:border-hxa-accent transition-colors resize-none"
            />
            <button
              onClick={handleSend}
              disabled={!composerText.trim() || sending}
              className="shrink-0 gradient-btn rounded-lg p-2.5 disabled:opacity-30 disabled:cursor-not-allowed transition-opacity"
            >
              {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
            </button>
          </div>
        </div>
      )}

      {/* Closed thread banner */}
      {!canSend && (
        <div className="shrink-0 px-4 py-2.5 border-t border-hxa-border bg-hxa-bg-tertiary text-center text-xs text-hxa-text-muted">
          This thread is {thread.status} — messages are read-only
        </div>
      )}
    </div>
  );
}

// ─── Message Bubble ───

function MessageBubble({ message, isSelf }: { message: ThreadMessage; isSelf: boolean }) {
  const provenance = message.metadata?.provenance as Record<string, unknown> | undefined;
  const isHuman = provenance?.authored_by === 'human';
  const ownerName = isHuman ? (provenance?.owner_name as string | undefined) : undefined;

  return (
    <div className={cn('group', isSelf && 'pl-8')}>
      {/* Header */}
      <div className="flex items-center gap-2 mb-0.5">
        <span className={cn(
          'text-xs font-semibold',
          isSelf ? 'text-hxa-accent' : 'text-hxa-text-dim',
        )}>
          {message.sender_name}
        </span>
        {isHuman && (
          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-hxa-amber/20 text-amber-400 border border-amber-500/30">
            {ownerName || 'Human'}
          </span>
        )}
        <span className="text-[10px] text-hxa-text-muted">
          {formatTime(message.created_at)}
        </span>
      </div>

      {/* Body */}
      <div className={cn(
        'rounded-lg px-3 py-2 text-sm leading-relaxed',
        isSelf
          ? 'bg-hxa-accent/10 border border-hxa-accent/15'
          : 'bg-white/[0.03] border border-white/[0.06]',
        isHuman && 'border-amber-500/20',
      )}>
        {message.parts.map((part, i) => (
          <PartRenderer key={i} part={part} />
        ))}
      </div>
    </div>
  );
}

// ─── Part Renderer ───

function PartRenderer({ part }: { part: MessagePart }) {
  switch (part.type) {
    case 'text':
      return (
        <div className="whitespace-pre-wrap break-words text-hxa-text">
          {part.content}
        </div>
      );
    case 'image':
      return (
        <a href={part.url} target="_blank" rel="noopener noreferrer" className="block mt-1">
          <span className="text-xs text-hxa-accent hover:underline">{part.filename || 'Image'}</span>
        </a>
      );
    case 'file':
      return (
        <a href={part.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-hxa-accent hover:underline mt-1">
          <FileText size={12} />
          {part.filename || 'File'}
          {part.mime_type && <span className="text-hxa-text-muted">({part.mime_type})</span>}
        </a>
      );
    case 'link':
      return (
        <a href={part.url || part.content} target="_blank" rel="noopener noreferrer" className="text-xs text-hxa-accent hover:underline break-all">
          {part.content || part.url}
        </a>
      );
    default:
      // Unknown part type — render content as text
      return part.content ? (
        <div className="whitespace-pre-wrap break-words text-hxa-text text-sm">{part.content}</div>
      ) : null;
  }
}
