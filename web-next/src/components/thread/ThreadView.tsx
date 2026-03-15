'use client';

import { useState, useEffect, useRef, useCallback, useMemo, Component, type ReactNode, type ErrorInfo } from 'react';
import { Loader2, ChevronUp, Send, Reply, X, AlertTriangle } from 'lucide-react';
import * as api from '@/lib/api';
import type { Thread, ThreadMessage, MessagePart, ThreadStatus } from '@/lib/types';
import { cn, formatTime } from '@/lib/utils';
import { useSession } from '@/hooks/useSession';
import { MentionPopup, extractMentionQuery, type MentionCandidate } from '@/components/ui/MentionPopup';
import { PartRenderer } from '@/components/ui/PartRenderer';
import { ImageLightbox } from '@/components/ui/ImageLightbox';
import { ThreadHeader, type ThreadParticipantInfo } from '@/components/thread/ThreadHeader';
import { useTranslations } from '@/i18n/context';
import { ImageUploadButton, PendingImagePreview, validateImage, MAX_IMAGES_PER_MESSAGE, type PendingImage } from './ImageUpload';

// Error boundary for message parts — prevents malformed data from crashing entire thread
class MessageErrorBoundary extends Component<{ children: ReactNode; fallback?: ReactNode }, { hasError: boolean }> {
  constructor(props: { children: ReactNode; fallback?: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[MessageErrorBoundary]', error, info);
  }
  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? (
        <div className="flex items-center gap-1 text-xs text-amber-400/70 italic">
          <AlertTriangle size={12} />
          <span>Failed to render message</span>
        </div>
      );
    }
    return this.props.children;
  }
}

const MAX_CONCURRENT_UPLOADS = 3;

/** Run async tasks with a concurrency limit (worker-pool pattern). */
async function withConcurrency<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const idx = next++;
      results[idx] = await tasks[idx]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));
  return results;
}

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
  const { t } = useTranslations();
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
  const [replyTo, setReplyTo] = useState<ThreadMessage | null>(null);
  const autoMentionRef = useRef<string | null>(null); // tracks auto-inserted @mention prefix
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const uploadAborts = useRef<Map<string, () => void>>(new Map());
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
    setReplyTo(null);
    autoMentionRef.current = null;
    // Abort any in-flight uploads and clear timers
    uploadAborts.current.forEach((abort) => abort());
    uploadAborts.current.clear();
    if (toastTimer.current) { clearTimeout(toastTimer.current); toastTimer.current = null; }
    setPendingImages((prev) => {
      prev.forEach((img) => URL.revokeObjectURL(img.preview));
      return [];
    });
    setDragOver(false);
    setLightboxSrc(null);
    setToast(null);
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

    return () => {
      cancelled = true;
      if (toastTimer.current) { clearTimeout(toastTimer.current); toastTimer.current = null; }
      // Revoke any remaining blob URLs on unmount to prevent memory leaks
      setPendingImages((prev) => {
        prev.forEach((img) => URL.revokeObjectURL(img.preview));
        return [];
      });
    };
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
      return [...prev, ...newMsgs].sort((a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      );
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

  // ─── Toast helper ───

  function showToast(msg: string) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }

  // ─── Image handling ───

  const maxFileSizeMb = session?.config?.max_file_size_mb;

  function addPendingFiles(files: File[]) {
    // Validate files first (size, type checks that don't depend on queue state)
    const validated: File[] = [];
    for (const file of files) {
      const error = validateImage(file, t, maxFileSizeMb);
      if (error) { showToast(error); continue; }
      validated.push(file);
    }
    if (validated.length === 0) return;

    // Use functional updater so remaining count is always accurate
    // (prevents race if two paste/drop events fire before React re-renders)
    let wasTruncated = false;
    setPendingImages((prev) => {
      const remaining = MAX_IMAGES_PER_MESSAGE - prev.length;
      const toAdd = validated.slice(0, Math.max(0, remaining));
      wasTruncated = toAdd.length < validated.length;
      return [
        ...prev,
        ...toAdd.map((file) => ({
          id: crypto.randomUUID(),
          file,
          preview: URL.createObjectURL(file),
          status: 'pending' as const,
          progress: 0,
        })),
      ];
    });
    if (wasTruncated) {
      showToast(t('image.error.tooMany', { max: MAX_IMAGES_PER_MESSAGE }));
    }
  }

  function removePendingImage(id: string) {
    setPendingImages((prev) => {
      const img = prev.find((i) => i.id === id);
      if (img) URL.revokeObjectURL(img.preview);
      return prev.filter((i) => i.id !== id);
    });
  }

  function retryPendingImage(id: string) {
    setPendingImages((prev) =>
      prev.map((img) => (img.id === id ? { ...img, status: 'pending' as const, progress: 0, error: undefined } : img)),
    );
  }

  function updatePendingImage(id: string, updates: Partial<PendingImage>) {
    setPendingImages((prev) =>
      prev.map((img) => (img.id === id ? { ...img, ...updates } : img)),
    );
  }

  function handlePaste(e: React.ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageFiles: File[] = [];
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length > 0) {
      // Always preventDefault when images are detected — browser-copied images often
      // carry text/plain (URL) or text/html (<img> tag) metadata that would pollute
      // the composer. Users can paste text separately if needed.
      e.preventDefault();
      addPendingFiles(imageFiles);
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const imageFiles = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'));
    if (imageFiles.length > 0) addPendingFiles(imageFiles);
  }

  // Send message
  async function handleSend() {
    const text = composerText.trim();
    const imagesToSend = pendingImages.filter((i) => i.status !== 'error');
    if (!text && imagesToSend.length === 0) return;
    if (sending) return;
    setSending(true);

    try {
      // 1. Upload pending images concurrently (skip already-done ones)
      const needUpload = imagesToSend.filter((i) => !(i.status === 'done' && i.uploadResult));
      const alreadyDone = imagesToSend
        .filter((i) => i.status === 'done' && i.uploadResult)
        .map((i) => i.uploadResult as api.UploadResult);

      // Upload with concurrency limit (max 3 simultaneous uploads)
      const uploadTasks = needUpload.map((img) => () => {
        updatePendingImage(img.id, { status: 'uploading', progress: 0 });
        let lastReportedPct = 0;
        const handle = api.uploadFile(img.file, (pct) => {
          // Throttle progress updates: only re-render when progress jumps ≥5% or hits 100%
          if (pct - lastReportedPct >= 5 || pct === 100) {
            lastReportedPct = pct;
            updatePendingImage(img.id, { progress: pct });
          }
        });
        uploadAborts.current.set(img.id, handle.abort);
        return handle.promise
          .then((result) => {
            updatePendingImage(img.id, { status: 'done', uploadResult: result, progress: 100 });
            uploadAborts.current.delete(img.id);
            return { ok: true as const, id: img.id, result };
          })
          .catch((err) => {
            updatePendingImage(img.id, { status: 'error', error: (err as Error).message });
            uploadAborts.current.delete(img.id);
            return { ok: false as const, id: img.id };
          });
      });

      const results = await withConcurrency(uploadTasks, MAX_CONCURRENT_UPLOADS);
      const newlyUploaded = results.filter((r) => r.ok).map((r) => (r as { ok: true; result: api.UploadResult }).result);
      const failedCount = results.filter((r) => !r.ok).length;
      const uploadedImages = [...alreadyDone, ...newlyUploaded];

      // If some uploads failed but we have text or successful images, send what we can
      if (uploadedImages.length === 0 && !text) {
        if (failedCount > 0) showToast(t('image.error.uploadFailed', { error: `${failedCount} failed` }));
        return; // finally block handles setSending(false)
      }

      // 2. Build parts — only when images are present (avoids text duplication in content + parts)
      const parts: MessagePart[] | undefined = uploadedImages.length > 0
        ? [
            ...(text ? [{ type: 'text' as const, content: text }] : []),
            ...uploadedImages.map((up) => ({ type: 'image' as const, url: up.url, alt: up.name })),
          ]
        : undefined;

      // 3. Build content — include summary for bots that only read content field
      let content = text;
      if (!content && uploadedImages.length > 0) {
        content = uploadedImages.length === 1 ? '[image]' : `[${uploadedImages.length} images]`;
      }

      // 4. Send
      const msg = await api.sendThreadMessage(threadId, content, {
        parts,
        reply_to: replyTo?.id,
      });

      // 5. Cleanup — only remove successfully sent images (match by ID, not filename)
      const alreadyDoneIds = new Set(
        imagesToSend.filter((i) => i.status === 'done' && i.uploadResult).map((i) => i.id),
      );
      const successIds = new Set([
        ...alreadyDoneIds,
        ...results.filter((r) => r.ok).map((r) => r.id),
      ]);
      setPendingImages((prev) => {
        const remaining: PendingImage[] = [];
        for (const img of prev) {
          if (successIds.has(img.id)) {
            URL.revokeObjectURL(img.preview);
          } else {
            remaining.push(img);
          }
        }
        return remaining;
      });
      setMessages((prev) => {
        if (prev.some((m) => m.id === msg.id)) return prev;
        return [...prev, msg];
      });
      setComposerText('');
      setReplyTo(null);
      autoMentionRef.current = null;
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
      requestAnimationFrame(() => scrollToBottom());

      if (failedCount > 0) {
        showToast(t('image.error.uploadFailed', { error: `${failedCount} failed, message sent with ${uploadedImages.length} images` }));
      }
    } catch (err) {
      // Don't clear on message send error — preserve pending images and text
      showToast(t('image.error.uploadFailed', { error: (err as Error).message || 'Send failed' }));
    } finally {
      setSending(false);
    }
  }

  // Handle reply — auto-insert @sender_name (like TG/Lark)
  function handleReply(msg: ThreadMessage) {
    // Remove previous auto-inserted @mention (only if it was auto-inserted, not user-typed)
    if (autoMentionRef.current) {
      const old = autoMentionRef.current;
      setComposerText((text) => text.startsWith(old) ? text.slice(old.length) : text);
      autoMentionRef.current = null;
    }
    setReplyTo(msg);
    if (msg.sender_name) {
      const mention = `@${msg.sender_name} `;
      setComposerText((prev) => {
        if (prev.startsWith(mention)) return prev; // already present, skip
        autoMentionRef.current = mention;
        return `${mention}${prev}`;
      });
    }
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      }
    });
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
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.nativeEvent.isComposing) {
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

    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
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
    const participants = thread.participants
      .filter((p) => !!p.name)
      .map((p) => ({ id: p.bot_id, name: p.name!, online: p.online }));
    return [{ id: '_all', name: 'all', isAll: true }, ...participants];
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
        {t('thread.notFound')}
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0 relative">
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
              {t('thread.loadOlder')}
            </button>
          </div>
        )}

        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} isSelf={msg.sender_id === session?.bot_id} onReply={canSend ? () => handleReply(msg) : undefined} onImageClick={setLightboxSrc} />
        ))}

        <div ref={messagesEndRef} />
      </div>

      {/* Composer */}
      {canSend && (
        <div
          className={cn('shrink-0 border-t border-hxa-border bg-[rgba(10,15,26,0.4)] relative', dragOver && 'border-hxa-accent bg-hxa-accent/5')}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
        >
          {/* Drag-drop overlay */}
          {dragOver && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-hxa-accent/10 border-2 border-dashed border-hxa-accent rounded-lg pointer-events-none">
              <span className="text-sm font-medium text-hxa-accent">{t('image.dragDrop')}</span>
            </div>
          )}
          {/* Reply bar */}
          {replyTo && (
            <div className="flex items-center gap-2 px-4 py-2 border-b border-hxa-border bg-white/[0.02]">
              <Reply size={14} className="text-hxa-accent shrink-0" />
              <div className="flex-1 min-w-0 text-xs text-hxa-text-dim truncate">
                <span className="font-semibold text-hxa-text">{replyTo.sender_name}</span>
                {': '}
                {replyTo.parts?.[0]?.content?.slice(0, 100) || '...'}
              </div>
              <button onClick={() => {
                // Remove auto-inserted @mention when cancelling reply (only if auto-inserted)
                if (autoMentionRef.current) {
                  const old = autoMentionRef.current;
                  setComposerText((text) => text.startsWith(old) ? text.slice(old.length) : text);
                  autoMentionRef.current = null;
                }
                setReplyTo(null);
              }} className="text-hxa-text-muted hover:text-hxa-text shrink-0">
                <X size={14} />
              </button>
            </div>
          )}
          {/* Pending image preview strip */}
          <PendingImagePreview images={pendingImages} onRemove={removePendingImage} onRetry={retryPendingImage} />
          <div className="relative flex gap-2 items-end px-4 py-3">
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
              onPaste={handlePaste}
              onClick={() => {
                const ta = textareaRef.current;
                if (ta) updateMentionState(ta.value, ta.selectionStart);
              }}
              placeholder={t('thread.composerPlaceholder')}
              rows={1}
              className="flex-1 bg-black/30 border border-hxa-border rounded-lg px-3 py-2.5 text-sm text-hxa-text placeholder:text-hxa-text-muted outline-none focus:border-hxa-accent transition-colors resize-none"
            />
            <ImageUploadButton onAdd={addPendingFiles} disabled={sending} />
            <button
              onClick={handleSend}
              disabled={(!composerText.trim() && pendingImages.length === 0) || sending}
              className="shrink-0 gradient-btn rounded-lg p-2.5 disabled:opacity-30 disabled:cursor-not-allowed transition-opacity"
            >
              {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
            </button>
          </div>
        </div>
      )}

      {/* Toast notification */}
      {toast && (
        <div role="alert" className="absolute bottom-20 left-1/2 -translate-x-1/2 z-50 px-4 py-2 bg-red-900/90 text-white text-xs rounded-lg shadow-lg border border-red-700/50 max-w-[80%] text-center animate-in fade-in slide-in-from-bottom-2">
          {toast}
        </div>
      )}

      {/* Image lightbox */}
      <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />

      {/* Closed thread banner */}
      {!canSend && (
        <div className="shrink-0 px-4 py-2.5 border-t border-hxa-border bg-hxa-bg-tertiary text-center text-xs text-hxa-text-muted">
          {t('thread.readOnly', { status: t(`thread.status.${thread.status}`) })}
        </div>
      )}

    </div>
  );
}

// ─── Message Bubble ───

const SWIPE_THRESHOLD = 60;
const LONG_PRESS_MS = 500;

function MessageBubble({ message, isSelf, onReply, onImageClick }: { message: ThreadMessage; isSelf: boolean; onReply?: () => void; onImageClick?: (src: string) => void }) {
  const provenance = message.metadata?.provenance as Record<string, unknown> | undefined;
  const isHuman = provenance?.authored_by === 'human';
  const ownerName = isHuman ? (provenance?.owner_name as string | undefined) : undefined;
  const reply = message.reply_to_message;
  const { t } = useTranslations();
  const mentionNames = useMemo(() => message.mentions?.map(m => m.name), [message.mentions]);

  // Swipe & long-press state for mobile reply
  const touchRef = useRef<{ startX: number; startY: number; ts: number } | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const swipeXRef = useRef(0);
  const isSwiping = useRef(false);
  const [swipeX, setSwipeX] = useState(0);

  const clearLongPress = useCallback(() => {
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
  }, []);

  // Clean up long-press timer on unmount
  useEffect(() => () => clearLongPress(), [clearLongPress]);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    clearLongPress(); // Always clear existing timer (including on multi-touch)
    if (!onReply || e.touches.length !== 1) {
      // Multi-touch: cancel any active swipe gesture
      touchRef.current = null;
      isSwiping.current = false;
      swipeXRef.current = 0;
      setSwipeX(0);
      return;
    }
    const t = e.touches[0];
    touchRef.current = { startX: t.clientX, startY: t.clientY, ts: Date.now() };
    isSwiping.current = true;
    longPressTimer.current = setTimeout(() => {
      onReply();
      touchRef.current = null;
      isSwiping.current = false;
      swipeXRef.current = 0;
      setSwipeX(0);
    }, LONG_PRESS_MS);
  }, [onReply]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!touchRef.current) return;
    const t = e.touches[0];
    const dx = touchRef.current.startX - t.clientX;
    const dy = Math.abs(t.clientY - touchRef.current.startY);
    // Cancel long-press if finger moved
    if (dx > 10 || dy > 10) clearLongPress();
    // Only track left swipe, ignore vertical scrolling
    if (dy > 30) { touchRef.current = null; swipeXRef.current = 0; setSwipeX(0); return; }
    const clamped = Math.max(0, Math.min(dx, 100));
    swipeXRef.current = clamped;
    setSwipeX(clamped);
  }, [clearLongPress]);

  const handleTouchEnd = useCallback(() => {
    clearLongPress();
    if (touchRef.current && swipeXRef.current >= SWIPE_THRESHOLD && onReply) {
      onReply();
    }
    touchRef.current = null;
    isSwiping.current = false;
    swipeXRef.current = 0;
    setSwipeX(0);
  }, [clearLongPress, onReply]);

  return (
    <div
      className="group relative overflow-hidden"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
    >
      {/* Swipe reply indicator (revealed behind message) */}
      {swipeX > 0 && (
        <div className="absolute right-0 top-0 bottom-0 flex items-center pr-3 pointer-events-none">
          <Reply size={18} className={cn('transition-opacity', swipeX >= SWIPE_THRESHOLD ? 'text-hxa-accent opacity-100' : 'text-hxa-text-muted opacity-60')} />
        </div>
      )}

      <div style={{ transform: swipeX > 0 ? `translateX(-${swipeX}px)` : undefined, transition: isSwiping.current ? 'none' : 'transform 0.2s ease-out' }}>
        {/* Reply quote */}
        {reply && (
          <div className="flex items-center gap-1.5 mb-1 pl-2 border-l-2 border-hxa-accent/40">
            <Reply size={10} className="text-hxa-text-muted shrink-0" />
            <span className="text-[11px] font-semibold text-hxa-text-dim">{reply.sender_name}</span>
            <span className="text-[11px] text-hxa-text-muted truncate">{reply.content.slice(0, 80)}{reply.content.length > 80 ? '...' : ''}</span>
          </div>
        )}

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
              {ownerName || t('thread.human')}
            </span>
          )}
          <span className="text-[10px] text-hxa-text-muted">
            {formatTime(message.created_at, t)}
          </span>
          {/* Reply button — visible on hover (desktop) and always on mobile via touch */}
          {onReply && (
            <button onClick={onReply} className="opacity-0 group-hover:opacity-100 transition-opacity text-hxa-text-muted hover:text-hxa-accent ml-auto" title={t('thread.reply')}>
              <Reply size={12} />
            </button>
          )}
        </div>

        {/* Body */}
        <div className={cn(
          'rounded-lg px-3 py-2 text-sm leading-relaxed',
          isSelf
            ? 'bg-hxa-accent/10 border border-hxa-accent/15'
            : 'bg-white/[0.03] border border-white/[0.06]',
          isHuman && 'border-amber-500/20',
        )}>
          <MessageErrorBoundary>
            {message.parts.map((part, i) => (
              <PartRenderer key={i} part={part} mentionNames={mentionNames} mentionAll={message.mention_all} onImageClick={onImageClick} />
            ))}
          </MessageErrorBoundary>
        </div>
      </div>
    </div>
  );
}

