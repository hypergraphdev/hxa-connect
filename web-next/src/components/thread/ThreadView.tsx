'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Loader2, ChevronUp, Send, FileText } from 'lucide-react';
import * as api from '@/lib/api';
import type { Thread, ThreadMessage, MessagePart, ThreadStatus } from '@/lib/types';
import { cn, formatTime, safeHref } from '@/lib/utils';
import { useSession } from '@/hooks/useSession';
import { MentionPopup, extractMentionQuery, type MentionCandidate } from '@/components/ui/MentionPopup';
import { MarkdownContent } from '@/components/ui/MarkdownContent';
import { ThreadHeader, type ThreadParticipantInfo } from '@/components/thread/ThreadHeader';

interface ThreadViewProps {
  threadId: string;
  /** New messages pushed from WS */
  wsMessages?: ThreadMessage[];
  /** Thread metadata updates from WS */
  wsThread?: Thread;
  /** Thread status change from WS (for updating composer state) */
  wsThreadStatusChange?: { thread_id: string; to: ThreadStatus };
  /** Participant joined/left events from WS (accumulated array) */
  wsParticipantEvents?: Array<{ thread_id: string; bot_id: string; bot_name: string; action: 'joined' | 'left' }>;
  /** Bot online/offline status events from WS (accumulated array) */
  wsBotStatusEvents?: Array<{ bot_id: string; bot_name: string; online: boolean }>;
  onOpenArtifacts?: () => void;
}

export function ThreadView({ threadId, wsMessages, wsThread, wsThreadStatusChange, wsParticipantEvents, wsBotStatusEvents, onOpenArtifacts }: ThreadViewProps) {
  const { session } = useSession();
  const [thread, setThread] = useState<Thread | null>(null);
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [cursor, setCursor] = useState<string | undefined>();
  const [hasOlder, setHasOlder] = useState(false);
  const [composerText, setComposerText] = useState('');
  const [sending, setSending] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<{ query: string; startIndex: number } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
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

  // Handle WS participant join/leave (process all queued events)
  const participantProcessed = useRef(0);
  useEffect(() => {
    if (!wsParticipantEvents?.length) return;
    const unprocessed = wsParticipantEvents.slice(participantProcessed.current);
    if (!unprocessed.length) return;
    participantProcessed.current = wsParticipantEvents.length;

    for (const evt of unprocessed) {
      if (evt.thread_id !== threadId) continue;
      setThread((prev) => {
        if (!prev) return prev;
        const participants = prev.participants ?? [];
        if (evt.action === 'joined') {
          if (participants.some((p) => p.bot_id === evt.bot_id)) return prev;
          const updated = [...participants, { bot_id: evt.bot_id, name: evt.bot_name }];
          return { ...prev, participants: updated, participant_count: updated.length };
        } else {
          const updated = participants.filter((p) => p.bot_id !== evt.bot_id);
          return { ...prev, participants: updated, participant_count: updated.length };
        }
      });
    }
  }, [wsParticipantEvents, threadId]);

  // Handle WS bot online/offline status changes (process all queued events)
  const botStatusProcessed = useRef(0);
  useEffect(() => {
    if (!wsBotStatusEvents?.length) return;
    const unprocessed = wsBotStatusEvents.slice(botStatusProcessed.current);
    if (!unprocessed.length) return;
    botStatusProcessed.current = wsBotStatusEvents.length;

    for (const evt of unprocessed) {
      setThread((prev) => {
        if (!prev?.participants) return prev;
        const hasBot = prev.participants.some((p) => p.bot_id === evt.bot_id);
        if (!hasBot) return prev;
        return {
          ...prev,
          participants: prev.participants.map((p) =>
            p.bot_id === evt.bot_id ? { ...p, online: evt.online } : p
          ),
        };
      });
    }
  }, [wsBotStatusEvents]);

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

  // Handle mention selection
  function handleMentionSelect(name: string) {
    if (!mentionQuery) return;
    const before = composerText.slice(0, mentionQuery.startIndex);
    const after = composerText.slice(textareaRef.current?.selectionStart ?? composerText.length);
    const newText = `${before}@${name} ${after}`;
    setComposerText(newText);
    setMentionQuery(null);
    setMentionIndex(0);
    // Restore cursor position after the inserted mention
    const cursorPos = before.length + 1 + name.length + 1;
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        textareaRef.current.setSelectionRange(cursorPos, cursorPos);
      }
    });
  }

  // Update mention query on cursor/text change
  function updateMentionState(text: string, cursorPos: number) {
    const mq = extractMentionQuery(text, cursorPos);
    setMentionQuery(mq);
    if (!mq) setMentionIndex(0);
  }

  // Keyboard handler
  function handleKeyDown(e: React.KeyboardEvent) {
    // Mention popup keyboard navigation
    if (mentionQuery && filteredMentions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIndex((i) => (i + 1) % filteredMentions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIndex((i) => (i - 1 + filteredMentions.length) % filteredMentions.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        handleMentionSelect(filteredMentions[mentionIndex].name);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMentionQuery(null);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  // Auto-resize textarea + mention detection
  function handleTextareaInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setComposerText(e.target.value);
    const ta = e.target;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 150) + 'px';
    updateMentionState(e.target.value, e.target.selectionStart);
  }

  // Build mention candidates from thread participants
  const mentionCandidates = useMemo<MentionCandidate[]>(() => {
    if (!thread?.participants) return [];
    return thread.participants
      .filter((p) => !!p.name)
      .map((p) => ({ id: p.bot_id, name: p.name!, online: p.online }));
  }, [thread?.participants]);

  // Filtered candidates for current query
  const filteredMentions = useMemo(() => {
    if (!mentionQuery) return [];
    return mentionCandidates.filter((c) =>
      c.name.toLowerCase().includes(mentionQuery.query.toLowerCase()),
    );
  }, [mentionCandidates, mentionQuery]);

  const canSend = thread && !['resolved', 'closed'].includes(thread.status);

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
    <div className="flex-1 flex flex-col min-h-0 min-w-0">
      <ThreadHeader
        topic={thread.topic}
        status={thread.status}
        participantCount={thread.participant_count}
        participants={thread.participants?.map((p): ThreadParticipantInfo => ({
          id: p.bot_id,
          name: p.name || p.bot_id,
          online: p.online,
          label: p.label,
        }))}
        createdAt={thread.created_at}
        canChangeStatus={session?.bot?.auth_role === 'admin'}
        onStatusChange={async (status, closeReason) => {
          try {
            const updated = await api.updateThreadStatus(threadId, status, closeReason);
            setThread(updated);
          } catch { /* silent */ }
        }}
        onOpenArtifacts={onOpenArtifacts}
      />

      {/* Messages */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-3 space-y-3 min-h-0"
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
          <MessageBubble key={msg.id} message={msg} isSelf={msg.sender_id === session?.bot_id} />
        ))}

        <div ref={messagesEndRef} />
      </div>

      {/* Composer */}
      {canSend && (
        <div className="shrink-0 px-4 py-3 border-t border-hxa-border bg-[rgba(10,15,26,0.4)]">
          <div className="relative flex gap-2 items-end">
            {/* @mention popup */}
            {mentionQuery && filteredMentions.length > 0 && (
              <MentionPopup
                candidates={mentionCandidates}
                query={mentionQuery.query}
                selectedIndex={mentionIndex}
                onSelect={handleMentionSelect}
                onClose={() => setMentionQuery(null)}
                onHover={(i) => setMentionIndex(i)}
              />
            )}
            <textarea
              ref={textareaRef}
              value={composerText}
              onChange={handleTextareaInput}
              onKeyDown={handleKeyDown}
              onClick={() => {
                const ta = textareaRef.current;
                if (ta) updateMentionState(ta.value, ta.selectionStart);
              }}
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
    <div className="group">
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
    case 'markdown':
      return <MarkdownContent content={part.content || ''} />;
    case 'image':
      return (
        <a href={safeHref(part.url)} target="_blank" rel="noopener noreferrer" className="block mt-1">
          <span className="text-xs text-hxa-accent hover:underline">{part.alt || part.filename || 'Image'}</span>
        </a>
      );
    case 'file':
      return (
        <a href={safeHref(part.url)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-hxa-accent hover:underline mt-1">
          <FileText size={12} />
          {part.name || part.filename || 'File'}
          {part.mime_type && <span className="text-hxa-text-muted">({part.mime_type})</span>}
        </a>
      );
    case 'link':
      return (
        <a href={safeHref(part.url || part.content)} target="_blank" rel="noopener noreferrer" className="text-xs text-hxa-accent hover:underline break-all">
          {part.title || part.content || part.url}
        </a>
      );
    default:
      // Unknown part type — render content as text
      return part.content ? (
        <div className="whitespace-pre-wrap break-words text-hxa-text text-sm">{part.content}</div>
      ) : null;
  }
}
