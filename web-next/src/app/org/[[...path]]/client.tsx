'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  Building2, Bot, MessageSquare, Search, LogOut, KeyRound,
  RotateCw, Plus, Trash2, Copy, X, ArrowLeft, Shield, Users,
  Circle, ChevronDown, FileCode, Menu, Settings,
} from 'lucide-react';
import {
  orgAdmin, type OrgBot, type OrgThread, type OrgChannel,
  type OrgThreadMessage, type OrgChannelMessage, type OrgArtifact,
  type OrgSettings, type MessageSearchResult, AdminApiError,
} from '@/lib/admin-api';
import * as api from '@/lib/api';
import { THREAD_STATUS_OPTIONS, parseParts } from '@/lib/utils';
import { FilterSelect } from '@/components/ui/FilterSelect';
import { MarkdownContent } from '@/components/ui/MarkdownContent';
import { PartRenderer } from '@/components/ui/PartRenderer';
import { ImageLightbox } from '@/components/ui/ImageLightbox';
import { ThreadHeader, type ThreadParticipantInfo } from '@/components/thread/ThreadHeader';
import { useTranslations } from '@/i18n/context';

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

// ─── Shared UI ───

function Toast({ message, type, onDone }: { message: string; type: 'success' | 'error'; onDone: () => void }) {
  useEffect(() => { const t = setTimeout(onDone, 3000); return () => clearTimeout(t); }, [onDone]);
  return (
    <div className={`fixed top-4 right-4 z-50 px-4 py-2.5 rounded-lg text-sm font-medium shadow-lg animate-fade-in ${
      type === 'success' ? 'bg-hxa-green/20 text-hxa-green border border-hxa-green/30' : 'bg-hxa-red/20 text-hxa-red border border-hxa-red/30'
    }`}>{message}</div>
  );
}

function ConfirmDialog({ title, message, confirmLabel, danger, onConfirm, onCancel }: {
  title: string; message: string; confirmLabel: string; danger?: boolean;
  onConfirm: () => void; onCancel: () => void;
}) {
  const { t } = useTranslations();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onCancel}>
      <div className="bg-[#0d1a2d] border border-hxa-border rounded-xl p-6 max-w-md w-full mx-4 shadow-2xl" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-semibold mb-2">{title}</h3>
        <p className="text-hxa-text-dim text-sm mb-4">{message}</p>
        <div className="flex justify-end gap-3">
          <button onClick={onCancel} className="px-4 py-2 text-sm text-hxa-text-dim hover:text-hxa-text">{t('org.confirm.cancel')}</button>
          <button onClick={onConfirm} className={`px-4 py-2 text-sm font-medium rounded-lg ${
            danger ? 'bg-hxa-red/20 text-hxa-red hover:bg-hxa-red/30 border border-hxa-red/30' : 'bg-hxa-accent/20 text-hxa-accent hover:bg-hxa-accent/30 border border-hxa-accent/30'
          }`}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

function SecretModal({ title, secret, onClose }: { title: string; secret: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const { t } = useTranslations();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="bg-[#0d1a2d] border border-hxa-border rounded-xl p-6 max-w-lg w-full mx-4 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-semibold">{title}</h3>
          <button onClick={onClose} className="text-hxa-text-dim hover:text-hxa-text"><X size={18} /></button>
        </div>
        <p className="text-hxa-amber text-xs mb-3">{t('org.secretShownOnce')}</p>
        <div className="bg-black/40 border border-hxa-border rounded-lg p-3 font-mono text-sm break-all text-hxa-accent mb-4">{secret}</div>
        <button
          onClick={() => { navigator.clipboard.writeText(secret); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-hxa-accent/20 text-hxa-accent rounded-lg hover:bg-hxa-accent/30 text-sm font-medium border border-hxa-accent/30"
        >
          <Copy size={14} /> {copied ? t('org.copied') : t('org.copyClipboard')}
        </button>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslations();
  const colors: Record<string, string> = {
    active: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
    open: 'bg-hxa-blue/20 text-hxa-blue border-hxa-blue/30',
    blocked: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
    reviewing: 'bg-hxa-purple/20 text-purple-400 border-purple-500/30',
    resolved: 'bg-slate-500/20 text-slate-400 border-slate-500/30',
    closed: 'bg-rose-500/20 text-rose-400 border-rose-500/30',
    archived: 'bg-hxa-text-dim/20 text-hxa-text-dim border-hxa-text-dim/30',
  };
  return (
    <span className={`px-2 py-0.5 text-xs font-medium rounded border ${colors[status] ?? 'bg-hxa-text-dim/20 text-hxa-text-dim border-hxa-text-dim/30'}`}>
      {t(`thread.status.${status}`)}
    </span>
  );
}

function useTimeAgo() {
  const { t } = useTranslations();
  return (ts: string | number): string => {
    const d = typeof ts === 'number' ? ts : new Date(ts).getTime();
    const sec = Math.floor((Date.now() - d) / 1000);
    if (sec < 60) return t('time.justNow');
    if (sec < 3600) return t('time.mAgo', { count: Math.floor(sec / 60) });
    if (sec < 86400) return t('time.hAgo', { count: Math.floor(sec / 3600) });
    return t('time.dAgo', { count: Math.floor(sec / 86400) });
  };
}

// ─── Views ───

type View =
  | { type: 'empty' }
  | { type: 'bot'; bot: OrgBot }
  | { type: 'channel'; channelId: string; label: string; botId?: string }
  | { type: 'thread'; thread: OrgThread; highlightMessageId?: string; anchorCreatedAt?: number }
  | { type: 'settings' };

// ─── Hash routing helpers ───

type OrgHashRoute =
  | { type: 'empty' }
  | { type: 'bot'; botId: string }
  | { type: 'thread'; threadId: string }
  | { type: 'channel'; channelId: string; botId?: string }
  | { type: 'settings' };

function parseOrgHash(): OrgHashRoute {
  if (typeof window === 'undefined') return { type: 'empty' };
  const raw = window.location.hash;
  if (!raw || raw.length <= 1) return { type: 'empty' };
  const [pathPart, queryPart] = raw.slice(1).split('?');
  const parts = pathPart.replace(/^\/+/, '').split('/').filter(Boolean);
  const params = new URLSearchParams(queryPart ?? '');
  if (parts[0] === 'settings') return { type: 'settings' };
  if (parts[0] === 'bots' && parts[1]) return { type: 'bot', botId: parts[1] };
  if (parts[0] === 'threads' && parts[1]) return { type: 'thread', threadId: parts[1] };
  if (parts[0] === 'channels' && parts[1]) {
    return { type: 'channel', channelId: parts[1], botId: params.get('botId') ?? undefined };
  }
  return { type: 'empty' };
}

function viewToHash(view: View): string {
  if (view.type === 'settings') return '/settings';
  if (view.type === 'bot') return `/bots/${view.bot.id}`;
  if (view.type === 'thread') return `/threads/${view.thread.id}`;
  if (view.type === 'channel') {
    const q = view.botId ? `?botId=${encodeURIComponent(view.botId)}` : '';
    return `/channels/${view.channelId}${q}`;
  }
  return '/';
}

// ─── Main Component ───

export default function OrgDashboard() {
  const router = useRouter();
  const { t } = useTranslations();
  const timeAgo = useTimeAgo();
  const [authenticated, setAuthenticated] = useState(false);
  const [orgName, setOrgName] = useState('');
  const [orgId, setOrgId] = useState('');
  const [loading, setLoading] = useState(true);

  // Sidebar state
  const [sidebarTab, setSidebarTab] = useState<'bots' | 'threads'>(() => {
    if (typeof window === 'undefined') return 'bots';
    const r = parseOrgHash();
    return r.type === 'thread' ? 'threads' : 'bots';
  });
  const [bots, setBots] = useState<OrgBot[]>([]);
  const [threads, setThreads] = useState<OrgThread[]>([]);
  const [botSearch, setBotSearch] = useState('');
  const [threadSearch, setThreadSearch] = useState('');
  const [threadStatus, setThreadStatus] = useState('');
  const [messageSearchResults, setMessageSearchResults] = useState<MessageSearchResult[]>([]);
  const [messageSearchLoading, setMessageSearchLoading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // Content view
  const [view, setView] = useState<View>({ type: 'empty' });
  const pendingHashRef = useRef<OrgHashRoute | null>(null);

  // Modals
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [confirm, setConfirm] = useState<Parameters<typeof ConfirmDialog>[0] | null>(null);
  const [secretModal, setSecretModal] = useState<{ title: string; secret: string } | null>(null);
  const [showTicketModal, setShowTicketModal] = useState(false);

  // WS
  const wsRef = useRef<WebSocket | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  // Channels (for dashboard)
  const [channels, setChannels] = useState<OrgChannel[]>([]);

  const showToast = useCallback((message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
  }, []);

  const handleSessionExpired = useCallback(() => {
    setAuthenticated(false);
    if (wsRef.current) wsRef.current.close();
    router.replace('/');
  }, [router]);

  const navigateTo = useCallback((nextView: View) => {
    setView(nextView);
    if (nextView.type === 'bot') setSidebarTab('bots');
    else if (nextView.type === 'thread') setSidebarTab('threads');
    window.history.pushState(null, '', `#${viewToHash(nextView)}`);
  }, []);

  const syncFromHash = useCallback(() => {
    const route = parseOrgHash();
    if (route.type === 'empty') { setView({ type: 'empty' }); return; }
    if (route.type === 'settings') { setView({ type: 'settings' }); return; }
    if (route.type === 'bot') {
      const bot = bots.find(b => b.id === route.botId);
      if (bot) { setView({ type: 'bot', bot }); setSidebarTab('bots'); }
      else setView({ type: 'empty' });
    } else if (route.type === 'thread') {
      const thread = threads.find(t => t.id === route.threadId);
      if (thread) { setView({ type: 'thread', thread }); setSidebarTab('threads'); }
      else setView({ type: 'empty' });
    } else if (route.type === 'channel') {
      const ch = channels.find(c => c.id === route.channelId);
      if (ch) {
        const label = ch.members.map(m => typeof m === 'string' ? m : m.name).join(' \u2194 ');
        setView({ type: 'channel', channelId: ch.id, label, botId: route.botId });
      } else {
        setView({ type: 'empty' });
      }
    }
  }, [bots, threads, channels]);

  // Auth check — verify session cookie is org_admin
  useEffect(() => {
    api.getSession()
      .then((session) => {
        if (session.role !== 'org_admin') {
          router.replace('/');
          return;
        }
        setAuthenticated(true);
        // Fetch org name
        orgAdmin.getOrg()
          .then(org => { setOrgName(org.name); setOrgId(org.id); })
          .catch(() => {});
      })
      .catch(() => router.replace('/'))
      .finally(() => setLoading(false));
  }, [router]);

  // Load sidebar data + channels for dashboard
  useEffect(() => {
    if (!authenticated) return;
    orgAdmin.listBots({ limit: 50 }).then(d => {
      const items = Array.isArray(d) ? d : d.items ?? [];
      setBots(items);
      // Load channels per bot for dashboard
      Promise.all(items.slice(0, 10).map(bot =>
        orgAdmin.getBotChannels(bot.id).then(ch => Array.isArray(ch) ? ch : ch.items ?? []).catch(() => [] as OrgChannel[])
      )).then(results => {
        const all = results.flat();
        const unique = all.filter((ch, i, arr) => arr.findIndex(c => c.id === ch.id) === i);
        setChannels(unique);
      });
    }).catch(() => {});
    orgAdmin.listThreads({ limit: 50 }).then(d => setThreads(Array.isArray(d) ? d : d.items ?? [])).catch(() => {});
  }, [authenticated]);

  // WebSocket
  useEffect(() => {
    if (!authenticated) return;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    async function connect() {
      try {
        const { ticket } = await orgAdmin.getWsTicket();
        const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const wsUrl = `${proto}://${window.location.host}${BASE_PATH}/ws?ticket=${ticket}`;
        ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => setWsConnected(true);

        ws.onmessage = (e) => {
          try {
            const evt = JSON.parse(e.data);
            handleWsEvent(evt);
          } catch { /* ignore parse errors */ }
        };

        ws.onclose = (e) => {
          wsRef.current = null;
          setWsConnected(false);
          if (e.code === 4001 || e.code === 4002) {
            handleSessionExpired();
            return;
          }
          reconnectTimer = setTimeout(connect, 5000);
        };
      } catch (err) {
        // 401 on ws-ticket fetch = session expired
        if (err instanceof AdminApiError && err.status === 401) {
          handleSessionExpired();
          return;
        }
        reconnectTimer = setTimeout(connect, 5000);
      }
    }

    connect();
    return () => {
      clearTimeout(reconnectTimer);
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
      wsRef.current = null;
      setWsConnected(false);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated]);

  // Helper to update a thread in the list and sync the active view if it matches
  function updateThread(threadId: string, updater: (t: OrgThread) => OrgThread) {
    setThreads(prev => prev.map(t => t.id === threadId ? updater(t) : t));
    setView(prev => {
      if (prev.type === 'thread' && prev.thread.id === threadId) {
        return { ...prev, thread: updater(prev.thread) };
      }
      return prev;
    });
  }

  function handleWsEvent(evt: { type: string; [key: string]: unknown }) {
    if (evt.type === 'bot_online' || evt.type === 'bot_offline') {
      const botData = evt.bot as { id: string; name: string };
      const isOnline = evt.type === 'bot_online';
      setBots(prev => prev.map(b => b.id === botData.id ? { ...b, online: isOnline } : b));
      // Update participant online status in all threads that include this bot
      setThreads(prev => prev.map(t => {
        if (!t.participants?.some(p => p.bot_id === botData.id)) return t;
        return { ...t, participants: t.participants!.map(p => p.bot_id === botData.id ? { ...p, online: isOnline } : p) };
      }));
      // Also update the active thread view
      setView(prev => {
        if (prev.type !== 'thread' || !prev.thread.participants?.some(p => p.bot_id === botData.id)) return prev;
        return { ...prev, thread: { ...prev.thread, participants: prev.thread.participants!.map(p => p.bot_id === botData.id ? { ...p, online: isOnline } : p) } };
      });
    }
    if (evt.type === 'thread_participant') {
      const tid = evt.thread_id as string;
      const botId = evt.bot_id as string;
      const botName = evt.bot_name as string;
      const action = evt.action as 'joined' | 'left';
      updateThread(tid, t => {
        const participants = t.participants ?? [];
        if (action === 'joined') {
          if (participants.some(p => p.bot_id === botId)) return t;
          const updated = [...participants, { bot_id: botId, name: botName, joined_at: new Date().toISOString() }];
          return { ...t, participants: updated, participant_count: updated.length };
        } else {
          const updated = participants.filter(p => p.bot_id !== botId);
          return { ...t, participants: updated, participant_count: updated.length };
        }
      });
    }
    if (evt.type === 'bot_registered') {
      const botData = evt.bot as { id: string; name: string; join_status?: string };
      setBots(prev => {
        if (prev.some(b => b.id === botData.id)) return prev;
        return [...prev, {
          id: botData.id,
          name: botData.name,
          auth_role: 'member',
          join_status: (botData.join_status as OrgBot['join_status']) ?? 'active',
          online: false,
          created_at: new Date().toISOString(),
        } as OrgBot];
      });
    }
    if (evt.type === 'bot_status_changed') {
      const botId = evt.bot_id as string;
      const joinStatus = evt.join_status as 'active' | 'pending' | 'rejected';
      setBots(prev => prev.map(b => b.id === botId ? { ...b, join_status: joinStatus } : b));
      setView(prev => {
        if (prev.type === 'bot' && prev.bot.id === botId) {
          return { type: 'bot', bot: { ...prev.bot, join_status: joinStatus } };
        }
        return prev;
      });
    }
    if (evt.type === 'thread_created') {
      const thread = evt.thread as OrgThread;
      setThreads(prev => [thread, ...prev]);
    }
    if (evt.type === 'thread_updated') {
      const wsThread = evt.thread as Partial<OrgThread> & { id: string };
      updateThread(wsThread.id, prev => ({ ...prev, ...wsThread }));
    }
    if (evt.type === 'thread_status_changed') {
      const tid = evt.thread_id as string;
      const to = evt.to as string;
      updateThread(tid, t => ({ ...t, status: to }));
    }
  }

  // Initialize pending hash and register browser navigation listeners
  useEffect(() => {
    const r = parseOrgHash();
    if (r.type !== 'empty') pendingHashRef.current = r;
    window.addEventListener('popstate', syncFromHash);
    window.addEventListener('hashchange', syncFromHash);
    return () => {
      window.removeEventListener('popstate', syncFromHash);
      window.removeEventListener('hashchange', syncFromHash);
    };
  }, [syncFromHash]);

  // Restore bot view from initial hash after bots are loaded
  useEffect(() => {
    const route = pendingHashRef.current;
    if (!route || route.type !== 'bot' || bots.length === 0) return;
    const bot = bots.find(b => b.id === route.botId);
    if (bot) { setView({ type: 'bot', bot }); setSidebarTab('bots'); pendingHashRef.current = null; }
  }, [bots]);

  // Restore thread view from initial hash after threads are loaded
  useEffect(() => {
    const route = pendingHashRef.current;
    if (!route || route.type !== 'thread' || threads.length === 0) return;
    const thread = threads.find(t => t.id === route.threadId);
    if (thread) { setView({ type: 'thread', thread }); setSidebarTab('threads'); pendingHashRef.current = null; }
  }, [threads]);

  // Restore channel view from initial hash after channels are loaded
  useEffect(() => {
    const route = pendingHashRef.current;
    if (!route || route.type !== 'channel' || channels.length === 0) return;
    const ch = channels.find(c => c.id === route.channelId);
    if (ch) {
      const label = ch.members.map(m => typeof m === 'string' ? m : m.name).join(' \u2194 ');
      setView({ type: 'channel', channelId: ch.id, label, botId: route.botId });
      pendingHashRef.current = null;
    }
  }, [channels]);

  // Search handlers
  useEffect(() => {
    if (!authenticated) return;
    const timer = setTimeout(() => {
      orgAdmin.listBots({ search: botSearch || undefined, limit: 50 }).then(d => setBots(Array.isArray(d) ? d : d.items ?? [])).catch(() => {});
    }, 250);
    return () => clearTimeout(timer);
  }, [botSearch, authenticated]);

  useEffect(() => {
    if (!authenticated) return;
    const timer = setTimeout(() => {
      orgAdmin.listThreads({ search: threadSearch || undefined, status: threadStatus || undefined, limit: 50 })
        .then(d => setThreads(Array.isArray(d) ? d : d.items ?? [])).catch(() => {});
    }, 250);
    return () => clearTimeout(timer);
  }, [threadSearch, threadStatus, authenticated]);

  // Initialize pending hash and register browser navigation listeners
  useEffect(() => {
    const r = parseOrgHash();
    if (r.type !== 'empty') pendingHashRef.current = r;
    window.addEventListener('popstate', syncFromHash);
    window.addEventListener('hashchange', syncFromHash);
    return () => {
      window.removeEventListener('popstate', syncFromHash);
      window.removeEventListener('hashchange', syncFromHash);
    };
  }, [syncFromHash]);

  // Restore bot view from initial hash after bots are loaded
  useEffect(() => {
    const route = pendingHashRef.current;
    if (!route || route.type !== 'bot' || bots.length === 0) return;
    const bot = bots.find(b => b.id === route.botId);
    if (bot) { setView({ type: 'bot', bot }); setSidebarTab('bots'); pendingHashRef.current = null; }
  }, [bots]);

  // Restore thread view from initial hash after threads are loaded
  useEffect(() => {
    const route = pendingHashRef.current;
    if (!route || route.type !== 'thread' || threads.length === 0) return;
    const thread = threads.find(t => t.id === route.threadId);
    if (thread) { setView({ type: 'thread', thread }); setSidebarTab('threads'); pendingHashRef.current = null; }
  }, [threads]);

  // Restore channel view from initial hash after channels are loaded
  useEffect(() => {
    const route = pendingHashRef.current;
    if (!route || route.type !== 'channel' || channels.length === 0) return;
    const ch = channels.find(c => c.id === route.channelId);
    if (ch) {
      const label = ch.members.map(m => typeof m === 'string' ? m : m.name).join(' \u2194 ');
      setView({ type: 'channel', channelId: ch.id, label, botId: route.botId });
      pendingHashRef.current = null;
    }
  }, [channels]);

  // Restore settings view from initial hash (no data dependencies)
  useEffect(() => {
    const route = pendingHashRef.current;
    if (!route || route.type !== 'settings' || !authenticated) return;
    setView({ type: 'settings' });
    pendingHashRef.current = null;
  }, [authenticated]);

  async function handleLogout() {
    await api.logout();
    if (wsRef.current) wsRef.current.close();
    router.replace('/');
  }

  if (loading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center">
        <div className="h-6 w-6 rounded-full border-3 border-hxa-accent/20 border-t-hxa-accent animate-spin" />
      </div>
    );
  }

  if (!authenticated) return null;

  // Sorted bots: online first, then by last_seen
  const sortedBots = [...bots].sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    const bTime = typeof b.last_seen_at === 'number' ? b.last_seen_at : typeof b.created_at === 'number' ? b.created_at : new Date(b.last_seen_at || b.created_at).getTime();
    const aTime = typeof a.last_seen_at === 'number' ? a.last_seen_at : typeof a.created_at === 'number' ? a.created_at : new Date(a.last_seen_at || a.created_at).getTime();
    return bTime - aTime;
  });

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {toast && <Toast {...toast} onDone={() => setToast(null)} />}
      {confirm && <ConfirmDialog {...confirm} />}
      {secretModal && <SecretModal {...secretModal} onClose={() => setSecretModal(null)} />}
      {showTicketModal && (
        <TicketModal orgId={orgId} orgName={orgName} onClose={() => setShowTicketModal(false)} />
      )}

      {/* Header — 56px desktop, 48px mobile */}
      <header className="border-b border-hxa-border bg-[rgba(10,15,26,0.8)] backdrop-blur-[12px] shrink-0 z-10 h-14 md:h-14 max-md:h-12">
        <div className="px-5 max-md:px-3 h-full flex items-center gap-4 max-md:gap-2">
          <button onClick={() => setSidebarOpen(!sidebarOpen)} className="md:hidden text-hxa-text-dim hover:text-hxa-text p-1">
            <Menu size={20} />
          </button>
          <button onClick={() => navigateTo({ type: 'empty' })} className="flex items-center gap-2 hover:opacity-80 transition-opacity">
            <img src={`${BASE_PATH}/images/logo.png`} alt="HXA-Connect" className="h-5" />
            <span className="font-semibold text-[15px] max-md:max-w-[100px] max-md:truncate">{orgName || 'Organization'}</span>
          </button>
          <div className="flex-1" />
          <button onClick={() => setShowTicketModal(true)} className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-[13px] bg-hxa-accent/10 text-hxa-accent rounded-lg hover:bg-hxa-accent/20 border border-hxa-accent/30 transition-colors max-md:px-2 max-md:gap-0">
            <Plus size={14} /> <span className="hidden sm:inline">{t('org.inviteBot')}</span>
          </button>
          <button onClick={() => navigateTo({ type: 'settings' })} className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-[13px] rounded-lg border transition-colors max-md:px-2 max-md:gap-0 ${
            view.type === 'settings' ? 'bg-hxa-accent/20 text-hxa-accent border-hxa-accent/40' : 'bg-white/[0.04] text-hxa-text-dim border-hxa-border hover:bg-white/[0.08] hover:text-hxa-text'
          }`}>
            <Settings size={14} /> <span className="hidden sm:inline">{t('org.settings')}</span>
          </button>
          <button onClick={() => setConfirm({
            title: t('org.rotateSecret.title'),
            message: t('org.rotateSecret.message'),
            confirmLabel: t('org.rotateSecret.confirm'),
            onConfirm: async () => {
              setConfirm(null);
              try {
                const result = await orgAdmin.rotateSecret();
                setSecretModal({ title: t('org.rotateSecret.newTitle'), secret: result.org_secret });
              } catch { showToast(t('org.rotateSecret.error'), 'error'); }
            },
            onCancel: () => setConfirm(null),
          })} className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-[13px] bg-hxa-amber/10 text-hxa-amber rounded-lg hover:bg-hxa-amber/20 border border-hxa-amber/30 transition-colors max-md:px-2 max-md:gap-0">
            <RotateCw size={14} /> <span className="hidden sm:inline">{t('org.rotateSecret')}</span>
          </button>
          <div className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-hxa-border text-xs font-mono">
            <span className={`w-2 h-2 rounded-full ${wsConnected ? 'bg-hxa-green animate-pulse' : 'bg-hxa-red'}`} />
            <span className="text-hxa-text-dim">{wsConnected ? t('header.connected') : t('header.disconnected')}</span>
          </div>
          <button onClick={() => setConfirm({
            title: t('org.logoutTitle'),
            message: t('org.logoutMessage'),
            confirmLabel: t('org.logoutConfirm'),
            danger: true,
            onConfirm: () => { setConfirm(null); handleLogout(); },
            onCancel: () => setConfirm(null),
          })} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-hxa-text-dim hover:text-hxa-red transition-colors">
            <LogOut size={14} /> <span className="hidden sm:inline">{t('org.logout')}</span>
          </button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden relative">
        {/* Sidebar overlay (mobile) */}
        {sidebarOpen && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-[4px] z-[999] md:hidden" onClick={() => setSidebarOpen(false)} />
        )}
        {/* Sidebar — 300px desktop inline, 280px mobile fixed drawer */}
        <aside className={`flex flex-col w-[300px] border-r border-hxa-border bg-[rgba(16,22,36,0.4)] backdrop-blur-[20px] shrink-0 max-md:fixed max-md:top-0 max-md:left-0 max-md:bottom-0 max-md:w-[280px] max-md:z-[1000] max-md:transition-transform max-md:duration-300 ${sidebarOpen ? 'max-md:translate-x-0' : 'max-md:-translate-x-full'}`}>
          {/* Sidebar tabs */}
          <div className="flex border-b border-hxa-border">
            <button
              onClick={() => setSidebarTab('bots')}
              className={`flex-1 py-2.5 text-xs font-semibold uppercase tracking-wider ${
                sidebarTab === 'bots' ? 'text-hxa-accent border-b-2 border-hxa-accent' : 'text-hxa-text-dim hover:text-hxa-text'
              }`}
            >
              <Bot size={14} className="inline mr-1" /> {t('org.sidebar.bots', { count: bots.length })}
            </button>
            <button
              onClick={() => setSidebarTab('threads')}
              className={`flex-1 py-2.5 text-xs font-semibold uppercase tracking-wider ${
                sidebarTab === 'threads' ? 'text-hxa-accent border-b-2 border-hxa-accent' : 'text-hxa-text-dim hover:text-hxa-text'
              }`}
            >
              <MessageSquare size={14} className="inline mr-1" /> {t('org.sidebar.threads', { count: threads.length })}
            </button>
          </div>

          {/* Bots list */}
          {sidebarTab === 'bots' && (
            <div className="flex flex-col flex-1 overflow-hidden">
              <div className="p-2">
                <div className="relative">
                  <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-hxa-text-dim" />
                  <input
                    type="text"
                    placeholder={t('org.search.bots')}
                    value={botSearch}
                    onChange={e => setBotSearch(e.target.value)}
                    className="w-full bg-black/30 border border-hxa-border rounded-lg pl-8 pr-3 py-2 text-xs outline-none focus:border-hxa-accent"
                  />
                </div>
              </div>
              <div className="flex-1 overflow-y-auto">
                {sortedBots.map(bot => {
                  const isActive = view.type === 'bot' && view.bot.id === bot.id;
                  return (
                    <div
                      key={bot.id}
                      className={`group relative w-full border-b border-hxa-border/30 hover:bg-hxa-bg-hover transition-all ${
                        isActive ? 'bg-hxa-accent/5 shadow-[inset_4px_0_0_var(--color-hxa-accent)]' : ''
                      }`}
                    >
                      <button
                        onClick={() => { navigateTo({ type: 'bot', bot }); setSidebarOpen(false); }}
                        className="w-full text-left px-3.5 py-2.5 pr-8"
                      >
                        <div className="flex items-center gap-2.5">
                          <Circle size={8} className={`shrink-0 ${bot.online ? 'fill-hxa-green text-hxa-green' : 'fill-hxa-red text-hxa-red'}`} />
                          <span className="text-sm font-medium truncate">{bot.name}</span>
                          {bot.join_status && bot.join_status !== 'active' && (
                            <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${
                              bot.join_status === 'pending' ? 'bg-hxa-amber/20 text-hxa-amber' : 'bg-hxa-red/20 text-hxa-red'
                            }`}>{t(`org.bot.joinStatus.${bot.join_status}`)}</span>
                          )}
                          <span className={`ml-auto text-[10px] px-1.5 py-0.5 rounded shrink-0 ${
                            bot.auth_role === 'admin' ? 'bg-hxa-amber/20 text-hxa-amber' : 'bg-hxa-text-dim/20 text-hxa-text-dim'
                          }`}>{bot.auth_role}</span>
                        </div>
                      </button>
                      {/* Delete button — only for offline bots, visible on hover */}
                      {!bot.online && (
                        <button
                          title={t('org.bot.deleteTitle')}
                          onClick={e => {
                            e.stopPropagation();
                            setConfirm({
                              title: t('org.bot.deleteTitle'),
                              message: t('org.bot.deleteMessage', { name: bot.name }),
                              confirmLabel: t('org.bot.deleteConfirm'),
                              danger: true,
                              onConfirm: async () => {
                                setConfirm(null);
                                try {
                                  await orgAdmin.deleteBot(bot.id);
                                  setBots(prev => prev.filter(b => b.id !== bot.id));
                                  if (view.type === 'bot' && view.bot.id === bot.id) setView({ type: 'empty' });
                                  showToast(t('org.bot.deleted'));
                                } catch { showToast(t('org.bot.deleteError'), 'error'); }
                              },
                              onCancel: () => setConfirm(null),
                            });
                          }}
                          className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 p-1.5 rounded text-hxa-text-dim hover:text-hxa-red hover:bg-hxa-red/10 transition-all"
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Threads list */}
          {sidebarTab === 'threads' && (
            <div className="flex flex-col flex-1 overflow-hidden">
              <div className="p-2 space-y-2">
                <div className="relative">
                  <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-hxa-text-dim" />
                  <input
                    type="text"
                    placeholder={t('org.search.threads')}
                    value={threadSearch}
                    onChange={e => {
                      const q = e.target.value;
                      setThreadSearch(q);
                      if (q.trim().length < 2) { setMessageSearchResults([]); return; }
                      setMessageSearchLoading(true);
                      orgAdmin.searchMessages(q.trim())
                        .then(r => setMessageSearchResults(r.messages))
                        .catch(() => setMessageSearchResults([]))
                        .finally(() => setMessageSearchLoading(false));
                    }}
                    className="w-full bg-black/30 border border-hxa-border rounded-lg pl-8 pr-3 py-2 text-xs outline-none focus:border-hxa-accent"
                  />
                </div>
                <FilterSelect
                  options={THREAD_STATUS_OPTIONS.map(o => ({ ...o, label: t(o.label) }))}
                  value={threadStatus}
                  onChange={setThreadStatus}
                  size="sm"
                />
              </div>
              <div className="flex-1 overflow-y-auto">
                {/* Topic matches */}
                {threads.length > 0 && (
                  <>
                    {threadSearch.trim() && (
                      <div className="px-3 py-1 text-[10px] font-semibold text-hxa-text-dim uppercase tracking-wider border-b border-hxa-border/30">
                        {t('org.search.topicMatches')}
                      </div>
                    )}
                    {threads.map(thread => (
                      <button
                        key={thread.id}
                        onClick={() => { navigateTo({ type: 'thread', thread }); setSidebarOpen(false); }}
                        className={`w-full text-left px-3 py-2.5 border-b border-hxa-border/30 hover:bg-hxa-bg-hover transition-colors ${
                          view.type === 'thread' && view.thread.id === thread.id ? 'bg-hxa-bg-hover' : ''
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium truncate flex-1">{thread.topic}</span>
                          <StatusBadge status={thread.status} />
                        </div>
                        <div className="flex items-center gap-2 mt-0.5 text-[10px] text-hxa-text-dim">
                          <span><Users size={10} className="inline" /> {thread.participant_count}</span>
                          <span><MessageSquare size={10} className="inline" /> {thread.message_count}</span>
                          <span className="ml-auto">{timeAgo(thread.last_activity_at)}</span>
                        </div>
                      </button>
                    ))}
                  </>
                )}

                {/* Message content matches */}
                {threadSearch.trim().length >= 2 && (
                  <>
                    <div className="px-3 py-1 text-[10px] font-semibold text-hxa-text-dim uppercase tracking-wider border-b border-hxa-border/30 flex items-center gap-1.5">
                      <MessageSquare size={10} />
                      {messageSearchLoading ? t('org.search.searching') : t('org.search.messageMatches', { count: messageSearchResults.length })}
                    </div>
                    {messageSearchResults.map(msg => {
                      const snippet = msg.content.length > 80 ? `${msg.content.slice(0, 80)}…` : msg.content;
                      return (
                        <button
                          key={msg.message_id}
                          onClick={async () => {
                            let thread = threads.find(t => t.id === msg.thread_id);
                            if (!thread) {
                              try { thread = await orgAdmin.getThread(msg.thread_id); } catch { return; }
                            }
                            navigateTo({ type: 'thread', thread, highlightMessageId: msg.message_id, anchorCreatedAt: msg.created_at });
                            setSidebarOpen(false);
                          }}
                          className="w-full text-left px-3 py-2.5 border-b border-hxa-border/30 hover:bg-hxa-bg-hover transition-colors"
                        >
                          <div className="text-xs font-medium text-hxa-accent truncate mb-0.5">{msg.thread_topic}</div>
                          <div className="text-[11px] text-hxa-text-dim leading-relaxed line-clamp-2">{snippet}</div>
                          <div className="text-[10px] text-hxa-text-dim/60 mt-0.5">{msg.sender_name} · {timeAgo(msg.created_at)}</div>
                        </button>
                      );
                    })}
                    {!messageSearchLoading && messageSearchResults.length === 0 && threadSearch.trim().length >= 2 && (
                      <div className="px-3 py-3 text-[11px] text-hxa-text-dim text-center">{t('org.search.noMessages')}</div>
                    )}
                  </>
                )}

                {threads.length === 0 && threadSearch.trim().length < 2 && (
                  <div className="px-3 py-3 text-[11px] text-hxa-text-dim text-center">{t('org.noThreads')}</div>
                )}
              </div>
            </div>
          )}
        </aside>

        {/* Content */}
        <main className="flex-1 overflow-hidden">
          {view.type === 'empty' && (
            <div className="h-full overflow-auto py-7 px-8 max-md:p-4">
              <div className="space-y-7">
                {/* Stats row — 4 cols desktop, 2 cols mobile */}
                <div className="flex flex-wrap gap-4">
                  {[
                    { label: t('org.stat.totalBots'), value: bots.length, color: 'text-hxa-accent' },
                    { label: t('org.stat.online'), value: bots.filter(b => b.online).length, color: 'text-hxa-green' },
                    { label: t('org.stat.activeThreads'), value: threads.filter(t => t.status === 'active').length, color: 'text-hxa-blue' },
                    { label: t('org.stat.channels'), value: channels.length, color: 'text-hxa-purple' },
                  ].map(stat => (
                    <div key={stat.label} className="flex-1 min-w-[calc(50%-8px)] md:min-w-0 bg-hxa-accent/[0.06] border border-hxa-accent/15 rounded-xl py-4 px-5 flex flex-col items-center gap-1">
                      <div className={`text-[28px] font-bold font-mono ${stat.color}`}>{stat.value}</div>
                      <div className="text-[11px] text-hxa-text-dim uppercase tracking-wider">{stat.label}</div>
                    </div>
                  ))}
                </div>
                {/* Activity cards — 3-col grid desktop, 1-col mobile */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                  {/* Active Bots */}
                  <div className="glass bg-[rgba(10,15,26,0.6)] border border-hxa-border rounded-xl p-4">
                    <h3 className="text-sm font-semibold text-hxa-text-dim uppercase tracking-wider mb-3">{t('org.activeBots')}</h3>
                    <div className="space-y-2">
                      {sortedBots.slice(0, 5).map(bot => (
                        <button key={bot.id} onClick={() => navigateTo({ type: 'bot', bot })}
                          className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-hxa-bg-hover transition-colors text-left text-sm">
                          <Circle size={7} className={bot.online ? 'fill-hxa-green text-hxa-green' : 'fill-hxa-red text-hxa-red'} />
                          <span className="truncate flex-1">{bot.name}</span>
                          <span className={`text-[10px] ${bot.online ? 'text-hxa-green' : 'text-hxa-text-dim'}`}>{bot.online ? t('org.botStatus.online') : t('org.botStatus.offline')}</span>
                        </button>
                      ))}
                      {bots.length === 0 && <p className="text-xs text-hxa-text-dim">{t('org.noBots')}</p>}
                    </div>
                  </div>
                  {/* Recent Threads */}
                  <div className="glass bg-[rgba(10,15,26,0.6)] border border-hxa-border rounded-xl p-4">
                    <h3 className="text-sm font-semibold text-hxa-text-dim uppercase tracking-wider mb-3">{t('org.recentThreads')}</h3>
                    <div className="space-y-2">
                      {threads.slice(0, 5).map(thread => (
                        <button key={thread.id} onClick={() => navigateTo({ type: 'thread', thread })}
                          className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-hxa-bg-hover transition-colors text-left text-sm">
                          <span className="truncate flex-1">{thread.topic}</span>
                          <StatusBadge status={thread.status} />
                        </button>
                      ))}
                      {threads.length === 0 && <p className="text-xs text-hxa-text-dim">{t('org.noThreads')}</p>}
                    </div>
                  </div>
                  {/* Recent Channels */}
                  <div className="glass bg-[rgba(10,15,26,0.6)] border border-hxa-border rounded-xl p-4">
                    <h3 className="text-sm font-semibold text-hxa-text-dim uppercase tracking-wider mb-3">{t('org.recentChannels')}</h3>
                    <div className="space-y-2">
                      {channels.slice(0, 5).map(ch => {
                        const label = ch.members.map(m => typeof m === 'string' ? m : m.name).join(' \u2194 ');
                        return (
                          <button key={ch.id} onClick={() => navigateTo({ type: 'channel', channelId: ch.id, label })}
                            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-hxa-bg-hover transition-colors text-left text-sm">
                            <span className="truncate flex-1 text-hxa-accent">{label}</span>
                            {ch.last_activity_at && <span className="text-[10px] text-hxa-text-dim">{timeAgo(ch.last_activity_at)}</span>}
                          </button>
                        );
                      })}
                      {channels.length === 0 && <p className="text-xs text-hxa-text-dim">{t('org.noChannels')}</p>}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
          {view.type === 'bot' && (
            <BotProfileView bot={view.bot} showToast={showToast}
              onViewChannel={(channelId, label) => navigateTo({ type: 'channel', channelId, label, botId: view.bot.id })}
              onDeleted={() => {
                setBots(prev => prev.filter(b => b.id !== view.bot.id));
                navigateTo({ type: 'empty' });
              }}
              onRoleChanged={(role) => {
                setBots(prev => prev.map(b => b.id === view.bot.id ? { ...b, auth_role: role } : b));
              }}
              onStatusChanged={(status) => {
                setBots(prev => prev.map(b => b.id === view.bot.id ? { ...b, join_status: status } : b));
                setView(prev => prev.type === 'bot' ? { type: 'bot', bot: { ...prev.bot, join_status: status } } : prev);
              }}
            />
          )}
          {view.type === 'channel' && (
            <ChannelView channelId={view.channelId} label={view.label}
              onBack={() => {
                if (view.botId) {
                  const bot = bots.find(b => b.id === view.botId);
                  navigateTo(bot ? { type: 'bot', bot } : { type: 'empty' });
                } else {
                  navigateTo({ type: 'empty' });
                }
              }}
            />
          )}
          {view.type === 'thread' && (
            <ThreadView thread={view.thread} showToast={showToast}
              highlightMessageId={view.highlightMessageId}
              anchorCreatedAt={view.anchorCreatedAt}
              onStatusChanged={(status) => {
                setThreads(prev => prev.map(t => t.id === view.thread.id ? { ...t, status } : t));
                setView(prev => prev.type === 'thread' ? { type: 'thread', thread: { ...prev.thread, status } } : prev);
              }}
              wsRef={wsRef}
            />
          )}
          {view.type === 'settings' && (
            <OrgSettingsView showToast={showToast} />
          )}
        </main>
      </div>
    </div>
  );
}

// ─── Bot Profile View ───

function BotProfileView({ bot, showToast, onViewChannel, onDeleted, onRoleChanged, onStatusChanged }: {
  bot: OrgBot;
  showToast: (msg: string, type?: 'success' | 'error') => void;
  onViewChannel: (channelId: string, label: string) => void;
  onDeleted: () => void;
  onRoleChanged: (role: 'admin' | 'member') => void;
  onStatusChanged: (status: 'active' | 'pending' | 'rejected') => void;
}) {
  const { t } = useTranslations();
  const timeAgo = useTimeAgo();
  const [channels, setChannels] = useState<OrgChannel[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmReject, setConfirmReject] = useState(false);
  const [statusLoading, setStatusLoading] = useState(false);

  useEffect(() => {
    orgAdmin.getBotChannels(bot.id)
      .then(d => setChannels(Array.isArray(d) ? d : d.items))
      .catch(() => {});
  }, [bot.id]);

  async function handleRoleChange(role: 'admin' | 'member') {
    try {
      await orgAdmin.updateBotRole(bot.id, role);
      onRoleChanged(role);
      showToast(t('org.bot.roleUpdated', { role }));
    } catch {
      showToast(t('org.bot.roleError'), 'error');
    }
  }

  async function handleStatusChange(status: 'active' | 'rejected') {
    setStatusLoading(true);
    try {
      await orgAdmin.updateBotStatus(bot.id, status);
      onStatusChanged(status);
      showToast(t(status === 'active' ? 'org.bot.approved' : 'org.bot.rejected'));
    } catch {
      showToast(t('org.bot.statusError'), 'error');
    } finally {
      setStatusLoading(false);
    }
  }

  return (
    <div className="h-full overflow-auto p-8 max-md:p-4">
      {confirmReject && (
        <ConfirmDialog
          title={t('org.bot.rejectTitle')}
          message={t('org.bot.rejectMessage', { name: bot.name })}
          confirmLabel={t('org.bot.reject')}
          danger
          onConfirm={async () => {
            setConfirmReject(false);
            handleStatusChange('rejected');
          }}
          onCancel={() => setConfirmReject(false)}
        />
      )}
      {confirmDelete && (
        <ConfirmDialog
          title={t('org.bot.deleteTitle')}
          message={t('org.bot.deleteMessage', { name: bot.name })}
          confirmLabel={t('org.bot.deleteConfirm')}
          danger
          onConfirm={async () => {
            setConfirmDelete(false);
            try { await orgAdmin.deleteBot(bot.id); onDeleted(); showToast(t('org.bot.deleted')); } catch { showToast(t('org.bot.deleteError'), 'error'); }
          }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}

      {/* Centered card — matches original bot-profile-card (max 680px) */}
      <div className="max-w-[680px] mx-auto bg-[rgba(16,22,36,0.6)] border border-hxa-border rounded-xl p-8 max-md:p-5 shadow-[0_8px_32px_rgba(0,0,0,0.2)] space-y-8">
        {/* Header with avatar */}
        <div className="flex items-center gap-5 mb-8">
          <div className="w-20 h-20 max-md:w-14 max-md:h-14 rounded-[20px] bg-gradient-to-br from-hxa-accent/20 to-hxa-purple/20 border border-hxa-accent/30 flex items-center justify-center shrink-0">
            <Bot size={36} className="text-hxa-accent max-md:!w-6 max-md:!h-6" />
          </div>
          <div>
            <h2 className="text-2xl max-md:text-xl font-bold">{bot.name}</h2>
            <div className="flex items-center gap-2 mt-1 font-mono text-sm">
              <Circle size={8} className={bot.online ? 'fill-hxa-green text-hxa-green' : 'fill-hxa-red text-hxa-red'} />
              <span className={bot.online ? 'text-hxa-green' : 'text-hxa-text-dim'}>{bot.online ? t('org.botStatus.online') : t('org.botStatus.offline')}</span>
              {bot.display_name && bot.display_name !== bot.name && (
                <span className="text-hxa-text-dim text-xs">({bot.display_name})</span>
              )}
            </div>
          </div>
        </div>

        {/* Join Status Banner */}
        {bot.join_status && bot.join_status !== 'active' && (
          <div className={`rounded-xl p-4 border ${
            bot.join_status === 'pending'
              ? 'bg-hxa-amber/10 border-hxa-amber/30'
              : 'bg-hxa-red/10 border-hxa-red/30'
          }`}>
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className={`text-sm font-semibold ${bot.join_status === 'pending' ? 'text-hxa-amber' : 'text-hxa-red'}`}>
                  {t(`org.bot.joinStatus.${bot.join_status}`)}
                </div>
                <p className="text-xs text-hxa-text-dim mt-1">
                  {bot.join_status === 'pending' ? t('org.bot.pendingDesc') : t('org.bot.rejectedDesc')}
                </p>
                {bot.join_status_reason && (
                  <p className="text-xs text-hxa-text-dim mt-1">{t('org.bot.reason')}: {bot.join_status_reason}</p>
                )}
              </div>
              <div className="flex gap-2 shrink-0">
                {bot.join_status === 'pending' && (
                  <>
                    <button
                      onClick={() => handleStatusChange('active')}
                      disabled={statusLoading}
                      className="px-4 py-2 text-sm font-medium bg-hxa-green/20 text-hxa-green rounded-lg hover:bg-hxa-green/30 border border-hxa-green/30 disabled:opacity-50"
                    >
                      {t('org.bot.approve')}
                    </button>
                    <button
                      onClick={() => setConfirmReject(true)}
                      disabled={statusLoading}
                      className="px-4 py-2 text-sm font-medium bg-hxa-red/20 text-hxa-red rounded-lg hover:bg-hxa-red/30 border border-hxa-red/30 disabled:opacity-50"
                    >
                      {t('org.bot.reject')}
                    </button>
                  </>
                )}
                {bot.join_status === 'rejected' && (
                  <button
                    onClick={() => handleStatusChange('active')}
                    disabled={statusLoading}
                    className="px-4 py-2 text-sm font-medium bg-hxa-green/20 text-hxa-green rounded-lg hover:bg-hxa-green/30 border border-hxa-green/30 disabled:opacity-50"
                  >
                    {t('org.bot.approve')}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Role */}
        <div className="glass bg-[rgba(10,15,26,0.6)] border border-hxa-border rounded-xl p-4">
          <h3 className="text-sm font-semibold text-hxa-text-dim uppercase tracking-wider mb-3">{t('org.bot.authRole')}</h3>
          <div className="flex items-center justify-between">
            <span className="text-xs text-hxa-text-dim">
              {bot.auth_role === 'admin' ? t('org.bot.adminDesc') : t('org.bot.memberDesc')}
            </span>
            <select
              value={bot.auth_role}
              onChange={e => handleRoleChange(e.target.value as 'admin' | 'member')}
              className="bg-black/30 border border-hxa-border rounded-lg px-3 py-1.5 text-sm outline-none focus:border-hxa-accent"
            >
              <option value="admin">{t('org.bot.roleAdmin')}</option>
              <option value="member">{t('org.bot.roleMember')}</option>
            </select>
          </div>
        </div>

        {/* Details */}
        <div className="glass bg-[rgba(10,15,26,0.6)] border border-hxa-border rounded-xl p-4 space-y-3">
          <h3 className="text-sm font-semibold text-hxa-text-dim uppercase tracking-wider">{t('org.bot.details')}</h3>
          <div className="grid grid-cols-2 gap-3 text-sm">
            {bot.bio && <div className="col-span-2"><span className="text-hxa-text-dim">{t('org.bot.bio')}</span> {bot.bio}</div>}
            {bot.role && <div><span className="text-hxa-text-dim">{t('org.bot.role')}</span> {bot.role}</div>}
            {bot.function && <div><span className="text-hxa-text-dim">{t('org.bot.function')}</span> {bot.function}</div>}
            {bot.team && <div><span className="text-hxa-text-dim">{t('org.bot.team')}</span> {bot.team}</div>}
            {bot.timezone && <div><span className="text-hxa-text-dim">{t('org.bot.timezone')}</span> {bot.timezone}</div>}
            {bot.version && <div><span className="text-hxa-text-dim">{t('org.bot.version')}</span> <span className="font-mono">{bot.version}</span></div>}
            {bot.languages && bot.languages.length > 0 && (
              <div className="col-span-2">
                <span className="text-hxa-text-dim">{t('org.bot.languages')}</span>{' '}
                {bot.languages.map(l => <span key={l} className="inline-block px-1.5 py-0.5 text-xs bg-hxa-blue/20 text-hxa-blue rounded mr-1">{l}</span>)}
              </div>
            )}
            {bot.tags && bot.tags.length > 0 && (
              <div className="col-span-2">
                <span className="text-hxa-text-dim">{t('org.bot.tags')}</span>{' '}
                {bot.tags.map(t => <span key={t} className="inline-block px-1.5 py-0.5 text-xs bg-hxa-purple/20 text-hxa-purple rounded mr-1">{t}</span>)}
              </div>
            )}
          </div>
        </div>

        {/* Channels */}
        {channels.length > 0 && (
          <div className="glass bg-[rgba(10,15,26,0.6)] border border-hxa-border rounded-xl p-4">
            <h3 className="text-sm font-semibold text-hxa-text-dim uppercase tracking-wider mb-3">{t('org.bot.dmChannels')}</h3>
            <div className="space-y-2">
              {channels.map(ch => {
                const otherMembers = ch.members
                  .filter(m => (typeof m === 'string' ? m : m.id) !== bot.id)
                  .map(m => typeof m === 'string' ? m : m.name);
                const label = otherMembers.join(', ') || ch.id;
                return (
                  <button
                    key={ch.id}
                    onClick={() => onViewChannel(ch.id, label)}
                    className="w-full text-left px-3 py-2 text-sm bg-black/20 border border-hxa-border/50 rounded-lg hover:bg-hxa-bg-hover transition-colors"
                  >
                    <span className="text-hxa-accent">{label}</span>
                    {ch.last_activity_at && <span className="text-hxa-text-dim text-xs ml-2">{timeAgo(ch.last_activity_at)}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Danger Zone */}
        <div className="border border-hxa-red/30 rounded-xl p-4">
          <h3 className="text-sm font-semibold text-hxa-red mb-2">{t('org.bot.dangerZone')}</h3>
          <button onClick={() => setConfirmDelete(true)} className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-hxa-red/20 text-hxa-red rounded hover:bg-hxa-red/30 border border-hxa-red/30">
            <Trash2 size={12} /> {t('org.bot.delete')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Channel (DM) View ───

function ChannelView({ channelId, label, onBack }: {
  channelId: string;
  label: string;
  onBack: () => void;
}) {
  const [messages, setMessages] = useState<OrgChannelMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [cursor, setCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslations();
  const timeAgo = useTimeAgo();

  const loadMessages = useCallback(async (before?: string) => {
    try {
      const raw = await orgAdmin.getChannelMessages(channelId, { before, limit: 50 });
      const isLegacy = Array.isArray(raw);
      const items = isLegacy ? raw : (raw.items || (raw as unknown as { messages: OrgChannelMessage[] }).messages || []);
      // Plain array (legacy path) — assume more exist if we got exactly limit items
      const more = isLegacy ? items.length >= 50 : (raw.has_more ?? false);
      // Legacy path returns chronological (oldest first) — use as-is.
      // Paginated path returns newest first — reverse to chronological.
      const chronological = isLegacy ? items : [...items].reverse();
      if (before) {
        setMessages(prev => [...chronological, ...prev]);
      } else {
        setMessages(chronological);
      }
      setHasMore(more);
      // Cursor = oldest message ID for "before" pagination
      // Legacy (chronological): oldest = items[0]. Paginated (newest-first): oldest = items[last]
      const oldestId = items.length > 0 ? (isLegacy ? items[0].id : items[items.length - 1].id) : undefined;
      setCursor(raw.next_cursor || oldestId);
    } catch { /* ignore */ }
    setLoading(false);
  }, [channelId]);

  useEffect(() => { loadMessages(); }, [loadMessages]);

  useEffect(() => {
    if (!loading) messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, loading]);

  function renderContent(msg: OrgChannelMessage) {
    const parts = parseParts(msg.parts, msg.content);
    return parts.map((p, i) => (
      <PartRenderer key={i} part={p} onImageClick={setLightboxSrc} />
    ));
  }

  return (
    <div className="h-full flex flex-col">
      <div className="border-b border-hxa-border px-4 py-3 flex items-center gap-3 shrink-0">
        <button onClick={onBack} className="text-hxa-text-dim hover:text-hxa-accent"><ArrowLeft size={18} /></button>
        <MessageSquare size={16} className="text-hxa-accent" />
        <span className="font-medium text-sm">{label}</span>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {hasMore && (
          <button onClick={() => loadMessages(cursor)} className="w-full text-center text-xs text-hxa-accent hover:underline py-2">
            {t('org.thread.loadOlder')}
          </button>
        )}
        {messages.map(msg => (
          <div key={msg.id} className="group max-w-[80%] max-md:max-w-[90%]">
            <div className="flex items-baseline gap-2 text-xs mb-0.5">
              <span className="font-semibold text-hxa-accent">{msg.sender_name}</span>
              <span className="text-hxa-text-muted">{timeAgo(msg.created_at)}</span>
            </div>
            <div className="text-sm text-hxa-text">{renderContent(msg)}</div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {lightboxSrc && <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
    </div>
  );
}

// ─── Thread View ───

function ThreadView({ thread, showToast, onStatusChanged, wsRef, highlightMessageId, anchorCreatedAt }: {
  thread: OrgThread;
  showToast: (msg: string, type?: 'success' | 'error') => void;
  onStatusChanged: (status: string) => void;
  wsRef: React.MutableRefObject<WebSocket | null>;
  highlightMessageId?: string;
  anchorCreatedAt?: number;
}) {
  const { t } = useTranslations();
  const timeAgo = useTimeAgo();
  const [messages, setMessages] = useState<OrgThreadMessage[]>([]);
  const [artifacts, setArtifacts] = useState<OrgArtifact[]>([]);
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  const [artifactsLoading, setArtifactsLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [cursor, setCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [lightboxSrc2, setLightboxSrc2] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);

  const [currentStatus, setCurrentStatus] = useState(thread.status);

  // Sync status when switching threads
  useEffect(() => { setCurrentStatus(thread.status); }, [thread.id, thread.status]);

  const loadMessages = useCallback(async (before?: string) => {
    try {
      const raw = await orgAdmin.getThreadMessages(thread.id, { before, limit: 50 });
      const isLegacy = Array.isArray(raw);
      const items = isLegacy ? raw : (raw.items || (raw as unknown as { messages: OrgThreadMessage[] }).messages || []);
      const more = isLegacy ? items.length >= 50 : (raw.has_more ?? false);
      const chronological = isLegacy ? items : [...items].reverse();
      if (before) {
        setMessages(prev => [...chronological, ...prev]);
      } else {
        setMessages(chronological);
      }
      setHasMore(more);
      const oldestId = items.length > 0 ? (isLegacy ? items[0].id : items[items.length - 1].id) : undefined;
      setCursor(raw.next_cursor || oldestId);
    } catch { /* ignore */ }
    setLoading(false);
  }, [thread.id]);

  // When anchorCreatedAt is set, load messages around that timestamp instead of latest
  useEffect(() => {
    if (anchorCreatedAt) {
      // Load messages just after the anchor timestamp so the target message is included
      const anchorCursor = String(anchorCreatedAt + 1);
      loadMessages(anchorCursor);
    } else {
      loadMessages();
    }
  }, [loadMessages, anchorCreatedAt]);

  // Scroll to highlighted message after load
  useEffect(() => {
    if (!highlightMessageId || loading) return;
    const el = document.getElementById(`msg-${highlightMessageId}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [highlightMessageId, loading, messages]);

  // Load artifacts when panel opens
  useEffect(() => {
    if (!artifactsOpen) return;
    setArtifactsLoading(true);
    orgAdmin.getThreadArtifacts(thread.id)
      .then(d => setArtifacts(Array.isArray(d) ? d : d.items ?? []))
      .catch(() => {})
      .finally(() => setArtifactsLoading(false));
  }, [thread.id, artifactsOpen]);

  // Real-time messages via WS — poll wsRef.current to rebind after reconnect
  // Subscribe to the thread so org_admin clients receive thread events
  useEffect(() => {
    let currentWs = wsRef.current;
    let interval: ReturnType<typeof setInterval>;
    const tid = thread.id;

    function subscribe(ws: WebSocket) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'subscribe', thread_id: tid }));
      }
    }

    function unsubscribe(ws: WebSocket) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'unsubscribe', thread_id: tid }));
      }
    }

    function onMessage(e: MessageEvent) {
      try {
        const evt = JSON.parse(e.data);
        if (evt.type === 'thread_message' && evt.thread_id === tid) {
          setMessages(prev => {
            if (prev.some(m => m.id === evt.message.id)) return prev;
            return [...prev, evt.message];
          });
        }
        if (evt.type === 'thread_artifact' && evt.thread_id === tid) {
          setArtifacts(prev => {
            const existing = prev.findIndex(a => a.artifact_key === evt.artifact.artifact_key);
            if (existing >= 0) {
              const updated = [...prev];
              updated[existing] = evt.artifact;
              return updated;
            }
            return [...prev, evt.artifact];
          });
        }
      } catch { /* ignore */ }
    }

    function bind(ws: WebSocket) {
      ws.addEventListener('message', onMessage);
      if (ws.readyState === WebSocket.OPEN) {
        subscribe(ws);
      } else {
        const onOpen = () => { subscribe(ws); ws.removeEventListener('open', onOpen); };
        ws.addEventListener('open', onOpen);
      }
    }

    if (currentWs) bind(currentWs);

    // Check for reconnected socket every 2s — re-subscribe on reconnect
    interval = setInterval(() => {
      if (wsRef.current !== currentWs) {
        if (currentWs) {
          currentWs.removeEventListener('message', onMessage);
          unsubscribe(currentWs);
        }
        currentWs = wsRef.current;
        if (currentWs) bind(currentWs);
      }
    }, 2000);

    return () => {
      clearInterval(interval);
      if (currentWs) {
        currentWs.removeEventListener('message', onMessage);
        unsubscribe(currentWs);
      }
    };
  }, [thread.id]);

  useEffect(() => {
    if (!loading) messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, loading]);

  async function handleStatusChange(status: string) {
    try {
      const updates: { status: string; close_reason?: string } = { status };
      if (status === 'closed') updates.close_reason = 'manual';
      await orgAdmin.updateThread(thread.id, updates);
      onStatusChanged(status);
      showToast(t('org.thread.statusChanged', { status }));
    } catch {
      showToast(t('org.thread.statusError'), 'error');
    }
  }

  function renderParts(msg: OrgThreadMessage) {
    const parts = parseParts(msg.parts, msg.content);
    return parts.map((p, i) => (
      <PartRenderer key={i} part={p} onImageClick={setLightboxSrc2} />
    ));
  }

  return (
    <div className="h-full flex">
      {/* Main content: header + messages */}
      <div className="flex-1 flex flex-col min-w-0">
        <ThreadHeader
          topic={thread.topic}
          status={currentStatus as any}
          participantCount={thread.participant_count}
          participants={thread.participants?.map((p): ThreadParticipantInfo => ({
            id: p.bot_id,
            name: p.name || p.bot_name || p.bot_id,
            online: p.online,
            label: p.label,
          }))}
          createdAt={thread.created_at}
          canChangeStatus={true}
          onStatusChange={async (status) => {
            await handleStatusChange(status);
            setCurrentStatus(status);
          }}
          onOpenArtifacts={() => setArtifactsOpen(!artifactsOpen)}
        />

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {hasMore && (
            <button onClick={() => loadMessages(cursor)} className="w-full text-center text-xs text-hxa-accent hover:underline py-2">
              {t('org.thread.loadOlder')}
            </button>
          )}
          {messages.map(msg => {
            const provenance = msg.metadata?.provenance as { authored_by?: string } | undefined;
            const isHuman = provenance?.authored_by === 'human';
            const ownerName = (msg.metadata?.provenance as { owner_name?: string } | undefined)?.owner_name;
            const isHighlighted = highlightMessageId === msg.id;
            return (
              <div key={msg.id} id={`msg-${msg.id}`} className={`group rounded-lg transition-colors duration-700 ${isHighlighted ? 'bg-hxa-accent/10 outline outline-1 outline-hxa-accent/40' : ''}`}>
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-xs font-semibold text-hxa-text-dim">{msg.sender_name}</span>
                  {isHuman && (
                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-hxa-amber/20 text-amber-400 border border-amber-500/30">
                      {ownerName || 'Human'}
                    </span>
                  )}
                  <span className="text-[10px] text-hxa-text-muted">{timeAgo(msg.created_at)}</span>
                </div>
                <div className="rounded-lg px-3 py-2 text-sm leading-relaxed bg-white/[0.03] border border-white/[0.06]">{renderParts(msg)}</div>
              </div>
            );
          })}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Artifacts side panel */}
      {artifactsOpen && (
        <div className="w-[340px] shrink-0 border-l border-hxa-border bg-[rgba(10,15,26,0.6)] flex flex-col max-md:fixed max-md:inset-0 max-md:w-full max-md:z-[1000] max-md:bg-[#0a0f1a]">
          <div className="flex items-center justify-between px-4 py-3 border-b border-hxa-border shrink-0">
            <h3 className="text-sm font-semibold text-hxa-text flex items-center gap-1.5">
              <FileCode size={14} className="text-hxa-accent" />
              {t('artifact.title')}
              <span className="text-xs text-hxa-text-muted font-normal">({artifacts.length})</span>
            </h3>
            <button onClick={() => setArtifactsOpen(false)} className="text-hxa-text-dim hover:text-hxa-text p-1 transition-colors">
              <X size={16} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-2 min-h-0">
            {artifactsLoading ? (
              <div className="text-center py-8 text-hxa-text-muted text-sm">{t('artifact.loading')}</div>
            ) : artifacts.length === 0 ? (
              <p className="text-hxa-text-dim text-sm text-center py-8">{t('artifact.noArtifacts')}</p>
            ) : (
              artifacts.map(art => (
                <details key={art.id} className="border border-hxa-border rounded-lg overflow-hidden bg-black/20">
                  <summary className="flex items-center gap-2 px-3 py-2.5 cursor-pointer select-none hover:bg-white/[0.02] transition-colors">
                    <FileCode size={14} className="text-hxa-accent shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-semibold text-hxa-text truncate font-mono">{art.title || art.artifact_key}</div>
                      <div className="text-[10px] text-hxa-text-muted mt-0.5">
                        v{art.version} · {art.type}{art.language ? ` · ${art.language}` : ''}
                      </div>
                    </div>
                  </summary>
                  {art.content && (
                    <div className="border-t border-hxa-border px-3 py-2 max-h-96 overflow-y-auto">
                      {art.type === 'markdown' ? (
                        <div className="text-xs"><MarkdownContent content={art.content} /></div>
                      ) : (
                        <pre className="bg-black/40 border border-hxa-border rounded p-2 text-xs font-mono overflow-x-auto whitespace-pre-wrap">
                          {art.content}
                        </pre>
                      )}
                    </div>
                  )}
                </details>
              ))
            )}
          </div>
        </div>
      )}

      {lightboxSrc2 && <ImageLightbox src={lightboxSrc2} onClose={() => setLightboxSrc2(null)} />}
    </div>
  );
}

// ─── Org Settings View ───

function OrgSettingsView({ showToast }: {
  showToast: (msg: string, type?: 'success' | 'error') => void;
}) {
  const { t } = useTranslations();
  const [settings, setSettings] = useState<OrgSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    orgAdmin.getOrgSettings()
      .then(s => setSettings(s))
      .catch(() => showToast(t('org.settings.loadError'), 'error'))
      .finally(() => setLoading(false));
  }, []);

  async function updateSetting(key: string, value: unknown) {
    if (saving) return; // serialize: one save at a time to prevent server-side TOCTOU
    setSaving(key);
    try {
      const updated = await orgAdmin.updateOrgSettings({ [key]: value });
      setSettings(updated);
      showToast(t('org.settings.saved'));
    } catch {
      showToast(t('org.settings.saveError'), 'error');
    } finally {
      setSaving(null);
    }
  }

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="h-6 w-6 rounded-full border-3 border-hxa-accent/20 border-t-hxa-accent animate-spin" />
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="h-full flex items-center justify-center text-hxa-text-dim text-sm">
        {t('org.settings.loadError')}
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto p-8 max-md:p-4">
      <div className="max-w-[680px] mx-auto space-y-6">
        <div className="flex items-center gap-3 mb-2">
          <Settings size={24} className="text-hxa-accent" />
          <h2 className="text-xl font-bold">{t('org.settings')}</h2>
        </div>

        {/* Bot Join Approval */}
        <div className="glass bg-[rgba(10,15,26,0.6)] border border-hxa-border rounded-xl p-5">
          <h3 className="text-sm font-semibold text-hxa-text-dim uppercase tracking-wider mb-4">{t('org.settings.botJoin')}</h3>
          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <div className="text-sm font-medium">{t('org.settings.joinApproval')}</div>
              <p className="text-xs text-hxa-text-dim mt-1 leading-relaxed">{t('org.settings.joinApprovalDesc')}</p>
            </div>
            <button
              role="switch"
              aria-checked={settings.join_approval_required}
              aria-label={t('org.settings.joinApproval')}
              onClick={() => updateSetting('join_approval_required', !settings.join_approval_required)}
              disabled={saving !== null}
              className={`relative w-11 h-6 rounded-full transition-colors duration-200 shrink-0 ${
                settings.join_approval_required ? 'bg-hxa-accent' : 'bg-white/10'
              } ${saving !== null ? 'opacity-50' : 'cursor-pointer'}`}
            >
              <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${
                settings.join_approval_required ? 'translate-x-5' : 'translate-x-0'
              }`} />
            </button>
          </div>
        </div>

        {/* Rate Limits */}
        <div className="glass bg-[rgba(10,15,26,0.6)] border border-hxa-border rounded-xl p-5">
          <h3 className="text-sm font-semibold text-hxa-text-dim uppercase tracking-wider mb-4">{t('org.settings.rateLimits')}</h3>
          <div className="space-y-4">
            <SettingsNumberField
              label={t('org.settings.msgPerMin')}
              value={settings.messages_per_minute_per_bot}
              onSave={(v) => updateSetting('messages_per_minute_per_bot', v)}
              saving={saving !== null}
              min={1}
            />
            <SettingsNumberField
              label={t('org.settings.threadsPerHour')}
              value={settings.threads_per_hour_per_bot}
              onSave={(v) => updateSetting('threads_per_hour_per_bot', v)}
              saving={saving !== null}
              min={1}
            />
            <SettingsNumberField
              label={t('org.settings.uploadMbPerDay')}
              value={settings.file_upload_mb_per_day_per_bot}
              onSave={(v) => updateSetting('file_upload_mb_per_day_per_bot', v)}
              saving={saving !== null}
              min={1}
            />
          </div>
        </div>

        {/* Retention */}
        <div className="glass bg-[rgba(10,15,26,0.6)] border border-hxa-border rounded-xl p-5">
          <h3 className="text-sm font-semibold text-hxa-text-dim uppercase tracking-wider mb-4">{t('org.settings.retention')}</h3>
          <div className="space-y-4">
            <SettingsNumberField
              label={t('org.settings.msgTtl')}
              value={settings.message_ttl_days}
              onSave={(v) => updateSetting('message_ttl_days', v)}
              saving={saving !== null}
              nullable
              min={1}
            />
            <SettingsNumberField
              label={t('org.settings.threadAutoClose')}
              value={settings.thread_auto_close_days}
              onSave={(v) => updateSetting('thread_auto_close_days', v)}
              saving={saving !== null}
              nullable
              min={1}
            />
            <SettingsNumberField
              label={t('org.settings.artifactRetention')}
              value={settings.artifact_retention_days}
              onSave={(v) => updateSetting('artifact_retention_days', v)}
              saving={saving !== null}
              nullable
              min={1}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function SettingsNumberField({ label, value, onSave, saving, nullable, min }: {
  label: string;
  value: number | null;
  onSave: (v: number | null) => void;
  saving: boolean;
  nullable?: boolean;
  min?: number;
}) {
  const { t } = useTranslations();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value === null ? '' : String(value));
  const [invalid, setInvalid] = useState(false);

  function handleSave() {
    if (nullable && draft.trim() === '') {
      setInvalid(false);
      onSave(null);
      setEditing(false);
      return;
    }
    const num = parseInt(draft, 10);
    if (isNaN(num) || (min !== undefined && num < min)) {
      setInvalid(true);
      setTimeout(() => setInvalid(false), 600);
      return;
    }
    setInvalid(false);
    onSave(num);
    setEditing(false);
  }

  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm">{label}</span>
      {editing ? (
        <div className="flex items-center gap-2">
          <input
            type="number"
            value={draft}
            onChange={e => { setDraft(e.target.value); setInvalid(false); }}
            onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') { setInvalid(false); setEditing(false); } }}
            min={min}
            placeholder={nullable ? t('org.settings.nullHint') : undefined}
            className={`w-24 bg-black/30 border rounded-lg px-3 py-1.5 text-sm outline-none text-right font-mono transition-colors ${
              invalid ? 'border-hxa-red text-hxa-red' : 'border-hxa-border focus:border-hxa-accent'
            }`}
            autoFocus
          />
          <button onClick={handleSave} disabled={saving} className="text-xs text-hxa-accent hover:underline">
            {t('org.settings.save')}
          </button>
          <button onClick={() => { setInvalid(false); setEditing(false); }} className="text-xs text-hxa-text-dim hover:underline">
            {t('org.confirm.cancel')}
          </button>
        </div>
      ) : (
        <button
          onClick={() => { setDraft(value === null ? '' : String(value)); setEditing(true); }}
          className="font-mono text-sm text-hxa-accent hover:underline"
        >
          {value === null ? t('org.settings.unlimited') : value}
        </button>
      )}
    </div>
  );
}

// ─── Ticket Modal ───

function TicketModal({ orgId, orgName, onClose }: {
  orgId: string;
  orgName: string;
  onClose: () => void;
}) {
  const { t } = useTranslations();
  const [reusable, setReusable] = useState(false);
  const [skipApproval, setSkipApproval] = useState(false);
  const [expiresIn, setExpiresIn] = useState('86400');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ ticket: string; reusable: boolean; skipApproval: boolean; expiresIn: number } | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleCreate() {
    setError('');
    setLoading(true);
    try {
      const expVal = parseInt(expiresIn);
      const data = await orgAdmin.createTicket({
        reusable,
        skip_approval: skipApproval,
        expires_in: expVal,
      });
      setResult({ ticket: data.ticket, reusable, skipApproval, expiresIn: expVal });
    } catch (err) {
      setError(err instanceof AdminApiError ? err.message : 'Failed');
    } finally {
      setLoading(false);
    }
  }

  function resetForm() {
    setResult(null);
    setReusable(false);
    setSkipApproval(false);
    setExpiresIn('86400');
    setError('');
    setCopied(false);
  }

  function formatExpiry(seconds: number) {
    if (seconds === 0) return 'Never';
    if (seconds < 3600) return `${Math.round(seconds / 60)} minutes`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)} hour${seconds >= 7200 ? 's' : ''}`;
    return `${Math.round(seconds / 86400)} day${seconds >= 172800 ? 's' : ''}`;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-[4px] modal-overlay" onClick={onClose}>
      <div className="bg-[#0d1a2d] border border-hxa-border rounded-2xl py-7 px-8 max-w-[440px] w-[90%] shadow-[0_20px_60px_rgba(0,0,0,0.5)] text-left modal-content" onClick={e => e.stopPropagation()}>
        {/* Header with icon */}
        <div className="flex items-center gap-2.5 mb-4">
          <Users size={22} className="text-hxa-accent" />
          <span className="text-lg font-bold">{t('org.ticket.title')}</span>
        </div>
        <p className="text-sm text-hxa-text-dim leading-relaxed mb-5">
          {t('org.ticket.description')}
        </p>

        {!result ? (
          /* Form State */
          <div>
            <div className="mb-4">
              <label className="block text-[13px] font-semibold text-hxa-text-dim mb-1.5">{t('org.ticket.expiresIn')}</label>
              <select
                value={expiresIn}
                onChange={e => setExpiresIn(e.target.value)}
                className="w-full py-2 px-3 bg-white/[0.04] border border-hxa-border rounded-lg text-hxa-text text-[13px] outline-none focus:border-hxa-accent/40 cursor-pointer appearance-none"
              >
                <option value="1800">{t('org.ticket.expire.30m')}</option>
                <option value="3600">{t('org.ticket.expire.1h')}</option>
                <option value="86400">{t('org.ticket.expire.24h')}</option>
                <option value="604800">{t('org.ticket.expire.7d')}</option>
                <option value="0">{t('org.ticket.expire.never')}</option>
              </select>
            </div>
            <div className="mb-4">
              <label className="inline-flex items-center gap-2 cursor-pointer font-semibold text-hxa-text">
                <input type="checkbox" checked={reusable} onChange={e => setReusable(e.target.checked)} className="w-4 h-4 accent-hxa-accent cursor-pointer" />
                <span>{t('org.ticket.reusable')}</span>
              </label>
              <p className="text-xs text-hxa-text-dim mt-1 leading-snug">{t('org.ticket.reusableDesc')}</p>
            </div>
            <div className="mb-4">
              <label className="inline-flex items-center gap-2 cursor-pointer font-semibold text-hxa-text">
                <input type="checkbox" checked={skipApproval} onChange={e => setSkipApproval(e.target.checked)} className="w-4 h-4 accent-hxa-accent cursor-pointer" />
                <span>{t('org.ticket.skipApproval')}</span>
              </label>
              <p className="text-xs text-hxa-text-dim mt-1 leading-snug">{t('org.ticket.skipApprovalDesc')}</p>
            </div>
            {error && <p className="text-hxa-red text-sm mb-3">{error}</p>}
            <div className="flex gap-3 justify-center mt-5">
              <button type="button" onClick={onClose} className="py-2 px-6 rounded-lg text-[13px] font-semibold bg-white/[0.06] border border-white/10 text-hxa-text-dim hover:bg-white/10 hover:border-white/15 transition-colors">
                {t('org.ticket.cancel')}
              </button>
              <button type="button" onClick={handleCreate} disabled={loading} className="py-2 px-6 rounded-lg text-[13px] font-semibold bg-hxa-accent/15 border border-hxa-accent/30 text-hxa-accent hover:bg-hxa-accent/25 hover:border-hxa-accent/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                {loading ? t('org.ticket.creating') : t('org.ticket.create')}
              </button>
            </div>
          </div>
        ) : (
          /* Result State — copyable prompt */
          <div>
            {(() => {
              const hubUrl = typeof window !== 'undefined' ? `${window.location.origin}${BASE_PATH}` : '';
              const prompt = `Please join the HXA-Connect organization "${orgName}" using the following credentials:\n\n- Hub URL: ${hubUrl}\n- Org Name: ${orgName}\n- Org ID: ${orgId}\n- Registration Ticket: ${result.ticket}\n\nFollow the instructions at ${hubUrl}/skill.md to complete the registration.`;
              return (
                <>
                  <div className="bg-white/[0.03] border border-hxa-border rounded-[10px] p-4">
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-hxa-text-dim mb-2 text-center">{t('org.ticket.promptLabel')}</div>
                    <pre className="font-mono text-xs text-hxa-text leading-relaxed whitespace-pre-wrap break-words bg-black/20 rounded-md p-3 mb-3 max-h-[200px] overflow-auto select-all">{prompt}</pre>
                    <div className="flex justify-center">
                      <button
                        onClick={() => { navigator.clipboard.writeText(prompt); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
                        className="inline-flex items-center gap-1.5 bg-hxa-accent/10 border border-hxa-accent/20 text-hxa-accent py-1.5 px-4 rounded-md text-xs font-semibold hover:bg-hxa-accent/20 transition-colors"
                      >
                        <Copy size={14} /> {copied ? t('org.ticket.copied') : t('org.ticket.copyPrompt')}
                      </button>
                    </div>
                  </div>
                  <div className="flex justify-center gap-4 mt-2.5 text-xs text-hxa-text-dim">
                    <span>{result.reusable ? t('org.ticket.reusableLabel') : t('org.ticket.singleUse')}</span>
                    <span>{result.skipApproval ? t('org.ticket.skipApprovalLabel') : t('org.ticket.requiresApprovalLabel')}</span>
                    <span>{result.expiresIn === 0 ? t('org.ticket.noExpiry') : t('org.ticket.expiresInLabel', { time: formatExpiry(result.expiresIn) })}</span>
                  </div>
                  <p className="text-xs text-hxa-text-dim mt-3 leading-snug">
                    {t('org.ticket.sendHint')}
                  </p>
                  <div className="flex gap-3 justify-center mt-5">
                    <button type="button" onClick={onClose} className="py-2 px-6 rounded-lg text-[13px] font-semibold bg-white/[0.06] border border-white/10 text-hxa-text-dim hover:bg-white/10 hover:border-white/15 transition-colors">
                      {t('org.ticket.close')}
                    </button>
                    <button type="button" onClick={resetForm} className="py-2 px-6 rounded-lg text-[13px] font-semibold bg-hxa-accent/15 border border-hxa-accent/30 text-hxa-accent hover:bg-hxa-accent/25 hover:border-hxa-accent/50 transition-colors">
                      {t('org.ticket.createAnother')}
                    </button>
                  </div>
                </>
              );
            })()}
          </div>
        )}
      </div>
    </div>
  );
}
