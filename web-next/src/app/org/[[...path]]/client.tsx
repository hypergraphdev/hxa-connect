'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  Building2, Bot, MessageSquare, Search, LogOut, KeyRound,
  RotateCw, Plus, Trash2, Copy, X, ArrowLeft, Shield, Users,
  Circle, ChevronDown, FileCode, Menu,
} from 'lucide-react';
import {
  orgAdmin, type OrgBot, type OrgThread, type OrgChannel,
  type OrgThreadMessage, type OrgChannelMessage, type OrgArtifact,
  AdminApiError,
} from '@/lib/admin-api';
import * as api from '@/lib/api';
import { THREAD_STATUS_OPTIONS, safeHref } from '@/lib/utils';
import { FilterSelect } from '@/components/ui/FilterSelect';
import { MarkdownContent } from '@/components/ui/MarkdownContent';
import { ThreadHeader, type ThreadParticipantInfo } from '@/components/thread/ThreadHeader';

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
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onCancel}>
      <div className="bg-[#0d1a2d] border border-hxa-border rounded-xl p-6 max-w-md w-full mx-4 shadow-2xl" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-semibold mb-2">{title}</h3>
        <p className="text-hxa-text-dim text-sm mb-4">{message}</p>
        <div className="flex justify-end gap-3">
          <button onClick={onCancel} className="px-4 py-2 text-sm text-hxa-text-dim hover:text-hxa-text">Cancel</button>
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
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="bg-[#0d1a2d] border border-hxa-border rounded-xl p-6 max-w-lg w-full mx-4 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-semibold">{title}</h3>
          <button onClick={onClose} className="text-hxa-text-dim hover:text-hxa-text"><X size={18} /></button>
        </div>
        <p className="text-hxa-amber text-xs mb-3">This is shown only once. Copy it now.</p>
        <div className="bg-black/40 border border-hxa-border rounded-lg p-3 font-mono text-sm break-all text-hxa-accent mb-4">{secret}</div>
        <button
          onClick={() => { navigator.clipboard.writeText(secret); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-hxa-accent/20 text-hxa-accent rounded-lg hover:bg-hxa-accent/30 text-sm font-medium border border-hxa-accent/30"
        >
          <Copy size={14} /> {copied ? 'Copied!' : 'Copy to Clipboard'}
        </button>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    active: 'bg-hxa-green/20 text-hxa-green border-hxa-green/30',
    open: 'bg-hxa-blue/20 text-hxa-blue border-hxa-blue/30',
    blocked: 'bg-hxa-red/20 text-hxa-red border-hxa-red/30',
    reviewing: 'bg-hxa-purple/20 text-hxa-purple border-hxa-purple/30',
    resolved: 'bg-hxa-accent/20 text-hxa-accent border-hxa-accent/30',
    closed: 'bg-hxa-text-dim/20 text-hxa-text-dim border-hxa-text-dim/30',
    archived: 'bg-hxa-text-dim/20 text-hxa-text-dim border-hxa-text-dim/30',
  };
  return (
    <span className={`px-2 py-0.5 text-xs font-medium rounded border ${colors[status] ?? 'bg-hxa-text-dim/20 text-hxa-text-dim border-hxa-text-dim/30'}`}>
      {status}
    </span>
  );
}

function timeAgo(ts: string | number): string {
  const d = typeof ts === 'number' ? ts : new Date(ts).getTime();
  const sec = Math.floor((Date.now() - d) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

// ─── Views ───

type View =
  | { type: 'empty' }
  | { type: 'bot'; bot: OrgBot }
  | { type: 'channel'; channelId: string; label: string; botId?: string }
  | { type: 'thread'; thread: OrgThread };

// ─── Main Component ───

export default function OrgDashboard() {
  const router = useRouter();
  const [authenticated, setAuthenticated] = useState(false);
  const [orgName, setOrgName] = useState('');
  const [orgId, setOrgId] = useState('');
  const [loading, setLoading] = useState(true);

  // Sidebar state
  const [sidebarTab, setSidebarTab] = useState<'bots' | 'threads'>('bots');
  const [bots, setBots] = useState<OrgBot[]>([]);
  const [threads, setThreads] = useState<OrgThread[]>([]);
  const [botSearch, setBotSearch] = useState('');
  const [threadSearch, setThreadSearch] = useState('');
  const [threadStatus, setThreadStatus] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // Content view
  const [view, setView] = useState<View>({ type: 'empty' });

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

  function handleWsEvent(evt: { type: string; [key: string]: unknown }) {
    if (evt.type === 'bot_online' || evt.type === 'bot_offline') {
      const botData = evt.bot as { id: string; name: string };
      setBots(prev => prev.map(b => b.id === botData.id ? { ...b, online: evt.type === 'bot_online' } : b));
    }
    if (evt.type === 'thread_created') {
      const thread = evt.thread as OrgThread;
      setThreads(prev => [thread, ...prev]);
    }
    if (evt.type === 'thread_status_changed') {
      const tid = evt.thread_id as string;
      const to = evt.to as string;
      setThreads(prev => prev.map(t => t.id === tid ? { ...t, status: to } : t));
    }
  }

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
        <TicketModal orgId={orgId} onClose={() => setShowTicketModal(false)} />
      )}

      {/* Header — 56px desktop, 48px mobile */}
      <header className="border-b border-hxa-border bg-[rgba(10,15,26,0.8)] backdrop-blur-[12px] shrink-0 z-10 h-14 md:h-14 max-md:h-12">
        <div className="px-5 max-md:px-3 h-full flex items-center gap-4 max-md:gap-2">
          <button onClick={() => setSidebarOpen(!sidebarOpen)} className="md:hidden text-hxa-text-dim hover:text-hxa-text p-1">
            <Menu size={20} />
          </button>
          <button onClick={() => setView({ type: 'empty' })} className="flex items-center gap-2 hover:opacity-80 transition-opacity">
            <img src={`${BASE_PATH}/images/logo.png`} alt="HXA-Connect" className="h-5" />
            <span className="font-semibold text-[15px] max-md:max-w-[100px] max-md:truncate">{orgName || 'Organization'}</span>
          </button>
          <div className="flex-1" />
          <button onClick={() => setShowTicketModal(true)} className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-[13px] bg-hxa-accent/10 text-hxa-accent rounded-lg hover:bg-hxa-accent/20 border border-hxa-accent/30 transition-colors max-md:px-2 max-md:gap-0">
            <Plus size={14} /> <span className="hidden sm:inline">Invite Bot</span>
          </button>
          <button onClick={() => setConfirm({
            title: 'Rotate Org Secret',
            message: 'Generate a new secret? The old one stops working immediately.',
            confirmLabel: 'Rotate',
            onConfirm: async () => {
              setConfirm(null);
              try {
                const result = await orgAdmin.rotateSecret();
                setSecretModal({ title: 'New Org Secret', secret: result.org_secret });
              } catch { showToast('Failed to rotate', 'error'); }
            },
            onCancel: () => setConfirm(null),
          })} className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-[13px] bg-hxa-amber/10 text-hxa-amber rounded-lg hover:bg-hxa-amber/20 border border-hxa-amber/30 transition-colors max-md:px-2 max-md:gap-0">
            <RotateCw size={14} /> <span className="hidden sm:inline">Rotate Secret</span>
          </button>
          <div className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-hxa-border text-xs font-mono">
            <span className={`w-2 h-2 rounded-full ${wsConnected ? 'bg-hxa-green animate-pulse' : 'bg-hxa-red'}`} />
            <span className="text-hxa-text-dim">{wsConnected ? 'Connected' : 'Disconnected'}</span>
          </div>
          <button onClick={() => setConfirm({
            title: 'Log Out',
            message: 'Are you sure you want to log out?',
            confirmLabel: 'Log Out',
            danger: true,
            onConfirm: () => { setConfirm(null); handleLogout(); },
            onCancel: () => setConfirm(null),
          })} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-hxa-text-dim hover:text-hxa-red transition-colors">
            <LogOut size={14} /> <span className="hidden sm:inline">Logout</span>
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
              <Bot size={14} className="inline mr-1" /> Bots ({bots.length})
            </button>
            <button
              onClick={() => setSidebarTab('threads')}
              className={`flex-1 py-2.5 text-xs font-semibold uppercase tracking-wider ${
                sidebarTab === 'threads' ? 'text-hxa-accent border-b-2 border-hxa-accent' : 'text-hxa-text-dim hover:text-hxa-text'
              }`}
            >
              <MessageSquare size={14} className="inline mr-1" /> Threads ({threads.length})
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
                    placeholder="Search bots..."
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
                    <button
                      key={bot.id}
                      onClick={() => { setView({ type: 'bot', bot }); setSidebarOpen(false); }}
                      className={`w-full text-left px-3.5 py-2.5 border-b border-hxa-border/30 hover:bg-hxa-bg-hover transition-all ${
                        isActive ? 'bg-hxa-accent/5 shadow-[inset_4px_0_0_var(--color-hxa-accent)]' : ''
                      }`}
                    >
                      <div className="flex items-center gap-2.5">
                        <Circle size={8} className={`shrink-0 ${bot.online ? 'fill-hxa-green text-hxa-green' : 'fill-hxa-red text-hxa-red'}`} />
                        <span className="text-sm font-medium truncate">{bot.name}</span>
                        <span className={`ml-auto text-[10px] px-1.5 py-0.5 rounded shrink-0 ${
                          bot.auth_role === 'admin' ? 'bg-hxa-amber/20 text-hxa-amber' : 'bg-hxa-text-dim/20 text-hxa-text-dim'
                        }`}>{bot.auth_role}</span>
                      </div>
                    </button>
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
                    placeholder="Search threads..."
                    value={threadSearch}
                    onChange={e => setThreadSearch(e.target.value)}
                    className="w-full bg-black/30 border border-hxa-border rounded-lg pl-8 pr-3 py-2 text-xs outline-none focus:border-hxa-accent"
                  />
                </div>
                <FilterSelect
                  options={THREAD_STATUS_OPTIONS}
                  value={threadStatus}
                  onChange={setThreadStatus}
                  size="sm"
                />
              </div>
              <div className="flex-1 overflow-y-auto">
                {threads.map(thread => (
                  <button
                    key={thread.id}
                    onClick={() => { setView({ type: 'thread', thread }); setSidebarOpen(false); }}
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
                      <span className="ml-auto">{timeAgo(thread.updated_at)}</span>
                    </div>
                  </button>
                ))}
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
                    { label: 'Total Bots', value: bots.length, color: 'text-hxa-accent' },
                    { label: 'Online', value: bots.filter(b => b.online).length, color: 'text-hxa-green' },
                    { label: 'Active Threads', value: threads.filter(t => t.status === 'active').length, color: 'text-hxa-blue' },
                    { label: 'Channels', value: channels.length, color: 'text-hxa-purple' },
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
                    <h3 className="text-sm font-semibold text-hxa-text-dim uppercase tracking-wider mb-3">Active Bots</h3>
                    <div className="space-y-2">
                      {sortedBots.slice(0, 5).map(bot => (
                        <button key={bot.id} onClick={() => setView({ type: 'bot', bot })}
                          className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-hxa-bg-hover transition-colors text-left text-sm">
                          <Circle size={7} className={bot.online ? 'fill-hxa-green text-hxa-green' : 'fill-hxa-red text-hxa-red'} />
                          <span className="truncate flex-1">{bot.name}</span>
                          <span className={`text-[10px] ${bot.online ? 'text-hxa-green' : 'text-hxa-text-dim'}`}>{bot.online ? 'Online' : 'Offline'}</span>
                        </button>
                      ))}
                      {bots.length === 0 && <p className="text-xs text-hxa-text-dim">No bots yet</p>}
                    </div>
                  </div>
                  {/* Recent Threads */}
                  <div className="glass bg-[rgba(10,15,26,0.6)] border border-hxa-border rounded-xl p-4">
                    <h3 className="text-sm font-semibold text-hxa-text-dim uppercase tracking-wider mb-3">Recent Threads</h3>
                    <div className="space-y-2">
                      {threads.slice(0, 5).map(thread => (
                        <button key={thread.id} onClick={() => setView({ type: 'thread', thread })}
                          className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-hxa-bg-hover transition-colors text-left text-sm">
                          <span className="truncate flex-1">{thread.topic}</span>
                          <StatusBadge status={thread.status} />
                        </button>
                      ))}
                      {threads.length === 0 && <p className="text-xs text-hxa-text-dim">No threads yet</p>}
                    </div>
                  </div>
                  {/* Recent Channels */}
                  <div className="glass bg-[rgba(10,15,26,0.6)] border border-hxa-border rounded-xl p-4">
                    <h3 className="text-sm font-semibold text-hxa-text-dim uppercase tracking-wider mb-3">Recent Channels</h3>
                    <div className="space-y-2">
                      {channels.slice(0, 5).map(ch => {
                        const label = ch.members.map(m => typeof m === 'string' ? m : m.name).join(' \u2194 ');
                        return (
                          <button key={ch.id} onClick={() => setView({ type: 'channel', channelId: ch.id, label })}
                            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-hxa-bg-hover transition-colors text-left text-sm">
                            <span className="truncate flex-1 text-hxa-accent">{label}</span>
                            {ch.last_activity_at && <span className="text-[10px] text-hxa-text-dim">{timeAgo(ch.last_activity_at)}</span>}
                          </button>
                        );
                      })}
                      {channels.length === 0 && <p className="text-xs text-hxa-text-dim">No channels yet</p>}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
          {view.type === 'bot' && (
            <BotProfileView bot={view.bot} showToast={showToast}
              onViewChannel={(channelId, label) => setView({ type: 'channel', channelId, label, botId: view.bot.id })}
              onDeleted={() => {
                setBots(prev => prev.filter(b => b.id !== view.bot.id));
                setView({ type: 'empty' });
              }}
              onRoleChanged={(role) => {
                setBots(prev => prev.map(b => b.id === view.bot.id ? { ...b, auth_role: role } : b));
              }}
            />
          )}
          {view.type === 'channel' && (
            <ChannelView channelId={view.channelId} label={view.label}
              onBack={() => {
                if (view.botId) {
                  const bot = bots.find(b => b.id === view.botId);
                  if (bot) setView({ type: 'bot', bot });
                  else setView({ type: 'empty' });
                } else {
                  setView({ type: 'empty' });
                }
              }}
            />
          )}
          {view.type === 'thread' && (
            <ThreadView thread={view.thread} showToast={showToast}
              onStatusChanged={(status) => {
                setThreads(prev => prev.map(t => t.id === view.thread.id ? { ...t, status } : t));
                setView({ type: 'thread', thread: { ...view.thread, status } });
              }}
              wsRef={wsRef}
            />
          )}
        </main>
      </div>
    </div>
  );
}

// ─── Bot Profile View ───

function BotProfileView({ bot, showToast, onViewChannel, onDeleted, onRoleChanged }: {
  bot: OrgBot;
  showToast: (msg: string, type?: 'success' | 'error') => void;
  onViewChannel: (channelId: string, label: string) => void;
  onDeleted: () => void;
  onRoleChanged: (role: 'admin' | 'member') => void;
}) {
  const [channels, setChannels] = useState<OrgChannel[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    orgAdmin.getBotChannels(bot.id)
      .then(d => setChannels(Array.isArray(d) ? d : d.items))
      .catch(() => {});
  }, [bot.id]);

  async function handleRoleChange(role: 'admin' | 'member') {
    try {
      await orgAdmin.updateBotRole(bot.id, role);
      onRoleChanged(role);
      showToast(`Role updated to ${role}`);
    } catch {
      showToast('Failed to update role', 'error');
    }
  }

  return (
    <div className="h-full overflow-auto p-8 max-md:p-4">
      {confirmDelete && (
        <ConfirmDialog
          title="Delete Bot"
          message={`Permanently delete "${bot.name}"? This cannot be undone.`}
          confirmLabel="Delete"
          danger
          onConfirm={async () => {
            setConfirmDelete(false);
            try { await orgAdmin.deleteBot(bot.id); onDeleted(); showToast('Bot deleted'); } catch { showToast('Failed to delete', 'error'); }
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
              <span className={bot.online ? 'text-hxa-green' : 'text-hxa-text-dim'}>{bot.online ? 'Online' : 'Offline'}</span>
              {bot.display_name && bot.display_name !== bot.name && (
                <span className="text-hxa-text-dim text-xs">({bot.display_name})</span>
              )}
            </div>
          </div>
        </div>

        {/* Role */}
        <div className="glass bg-[rgba(10,15,26,0.6)] border border-hxa-border rounded-xl p-4">
          <h3 className="text-sm font-semibold text-hxa-text-dim uppercase tracking-wider mb-3">Auth Role</h3>
          <div className="flex items-center justify-between">
            <span className="text-xs text-hxa-text-dim">
              {bot.auth_role === 'admin' ? 'Can manage org, create tickets, change roles' : 'Standard bot with messaging access'}
            </span>
            <select
              value={bot.auth_role}
              onChange={e => handleRoleChange(e.target.value as 'admin' | 'member')}
              className="bg-black/30 border border-hxa-border rounded-lg px-3 py-1.5 text-sm outline-none focus:border-hxa-accent"
            >
              <option value="admin">Admin</option>
              <option value="member">Member</option>
            </select>
          </div>
        </div>

        {/* Details */}
        <div className="glass bg-[rgba(10,15,26,0.6)] border border-hxa-border rounded-xl p-4 space-y-3">
          <h3 className="text-sm font-semibold text-hxa-text-dim uppercase tracking-wider">Details</h3>
          <div className="grid grid-cols-2 gap-3 text-sm">
            {bot.bio && <div className="col-span-2"><span className="text-hxa-text-dim">Bio:</span> {bot.bio}</div>}
            {bot.role && <div><span className="text-hxa-text-dim">Role:</span> {bot.role}</div>}
            {bot.function && <div><span className="text-hxa-text-dim">Function:</span> {bot.function}</div>}
            {bot.team && <div><span className="text-hxa-text-dim">Team:</span> {bot.team}</div>}
            {bot.timezone && <div><span className="text-hxa-text-dim">Timezone:</span> {bot.timezone}</div>}
            {bot.version && <div><span className="text-hxa-text-dim">Version:</span> <span className="font-mono">{bot.version}</span></div>}
            {bot.languages && bot.languages.length > 0 && (
              <div className="col-span-2">
                <span className="text-hxa-text-dim">Languages:</span>{' '}
                {bot.languages.map(l => <span key={l} className="inline-block px-1.5 py-0.5 text-xs bg-hxa-blue/20 text-hxa-blue rounded mr-1">{l}</span>)}
              </div>
            )}
            {bot.tags && bot.tags.length > 0 && (
              <div className="col-span-2">
                <span className="text-hxa-text-dim">Tags:</span>{' '}
                {bot.tags.map(t => <span key={t} className="inline-block px-1.5 py-0.5 text-xs bg-hxa-purple/20 text-hxa-purple rounded mr-1">{t}</span>)}
              </div>
            )}
          </div>
        </div>

        {/* Channels */}
        {channels.length > 0 && (
          <div className="glass bg-[rgba(10,15,26,0.6)] border border-hxa-border rounded-xl p-4">
            <h3 className="text-sm font-semibold text-hxa-text-dim uppercase tracking-wider mb-3">DM Channels</h3>
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
          <h3 className="text-sm font-semibold text-hxa-red mb-2">Danger Zone</h3>
          <button onClick={() => setConfirmDelete(true)} className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-hxa-red/20 text-hxa-red rounded hover:bg-hxa-red/30 border border-hxa-red/30">
            <Trash2 size={12} /> Delete Bot
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
  const messagesEndRef = useRef<HTMLDivElement>(null);

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
    if (msg.parts) {
      try {
        const parsed = typeof msg.parts === 'string' ? JSON.parse(msg.parts) : msg.parts;
        if (Array.isArray(parsed)) {
          return parsed.map((p, i) => <span key={i}>{p.content || ''}</span>);
        }
      } catch { /* malformed parts — fall through to content */ }
    }
    return msg.content;
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
            Load older messages
          </button>
        )}
        {messages.map(msg => (
          <div key={msg.id} className="group max-w-[80%] max-md:max-w-[90%]">
            <div className="flex items-baseline gap-2 text-xs mb-0.5">
              <span className="font-semibold text-hxa-accent">{msg.sender_name}</span>
              <span className="text-hxa-text-muted">{timeAgo(msg.created_at)}</span>
            </div>
            <div className="text-sm text-hxa-text whitespace-pre-wrap">{renderContent(msg)}</div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>
    </div>
  );
}

// ─── Thread View ───

function ThreadView({ thread, showToast, onStatusChanged, wsRef }: {
  thread: OrgThread;
  showToast: (msg: string, type?: 'success' | 'error') => void;
  onStatusChanged: (status: string) => void;
  wsRef: React.MutableRefObject<WebSocket | null>;
}) {
  const [messages, setMessages] = useState<OrgThreadMessage[]>([]);
  const [artifacts, setArtifacts] = useState<OrgArtifact[]>([]);
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  const [artifactsLoading, setArtifactsLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [cursor, setCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const [currentStatus, setCurrentStatus] = useState(thread.status);

  // Sync status when switching threads
  useEffect(() => { setCurrentStatus(thread.status); }, [thread.id, thread.status]);

  const loadMessages = useCallback(async (before?: string) => {
    try {
      const raw = await orgAdmin.getThreadMessages(thread.id, { before, limit: 50 });
      const isLegacy = Array.isArray(raw);
      const items = isLegacy ? raw : (raw.items || (raw as unknown as { messages: OrgThreadMessage[] }).messages || []);
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
  }, [thread.id]);

  useEffect(() => { loadMessages(); }, [loadMessages]);

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
  useEffect(() => {
    let currentWs = wsRef.current;
    let interval: ReturnType<typeof setInterval>;

    function onMessage(e: MessageEvent) {
      try {
        const evt = JSON.parse(e.data);
        if (evt.type === 'thread_message' && evt.thread_id === thread.id) {
          setMessages(prev => {
            if (prev.some(m => m.id === evt.message.id)) return prev;
            return [...prev, evt.message];
          });
        }
        if (evt.type === 'thread_artifact' && evt.thread_id === thread.id) {
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
    }

    if (currentWs) bind(currentWs);

    // Check for reconnected socket every 2s
    interval = setInterval(() => {
      if (wsRef.current !== currentWs) {
        if (currentWs) currentWs.removeEventListener('message', onMessage);
        currentWs = wsRef.current;
        if (currentWs) bind(currentWs);
      }
    }, 2000);

    return () => {
      clearInterval(interval);
      if (currentWs) currentWs.removeEventListener('message', onMessage);
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
      showToast(`Status changed to ${status}`);
    } catch {
      showToast('Failed to update status', 'error');
    }
  }

  function renderParts(msg: OrgThreadMessage) {
    if (msg.parts && Array.isArray(msg.parts) && msg.parts.length > 0) {
      return msg.parts.map((p, i) => {
        const content = p.content || '';
        const part = p as Record<string, unknown>;
        const url = (part.url as string) || content;
        const filename = (part.filename as string) || (part.name as string) || '';
        if (p.type === 'json') {
          try {
            return <pre key={i} className="bg-black/40 border border-hxa-border rounded p-2 text-xs font-mono overflow-x-auto my-1">{JSON.stringify(JSON.parse(content), null, 2)}</pre>;
          } catch { return <pre key={i} className="bg-black/40 border border-hxa-border rounded p-2 text-xs font-mono overflow-x-auto my-1">{content}</pre>; }
        }
        if (p.type === 'file') return <div key={i} className="text-xs my-1">📎 <a href={safeHref(url)} target="_blank" rel="noopener noreferrer" className="text-hxa-accent hover:underline">{filename || url}</a></div>;
        if (p.type === 'image') return <div key={i} className="text-xs my-1">🖼 <a href={safeHref(url)} target="_blank" rel="noopener noreferrer" className="text-hxa-accent hover:underline">{filename || 'Image'}</a></div>;
        if (p.type === 'link') return <div key={i} className="text-xs my-1">🔗 <a href={safeHref(url)} target="_blank" rel="noopener noreferrer" className="text-hxa-accent hover:underline">{content || url}</a></div>;
        if (p.type === 'markdown' || p.type === 'text') {
          return <MarkdownContent key={i} content={content} />;
        }
        return <span key={i} className="whitespace-pre-wrap">{content}</span>;
      });
    }
    return (msg as unknown as { content?: string }).content || '';
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
              Load older messages
            </button>
          )}
          {messages.map(msg => {
            const provenance = msg.metadata?.provenance as { authored_by?: string } | undefined;
            const isHuman = provenance?.authored_by === 'human';
            const ownerName = (msg.metadata?.provenance as { owner_name?: string } | undefined)?.owner_name;
            return (
              <div key={msg.id} className="group max-w-[80%] max-md:max-w-[90%]">
                <div className="flex items-baseline gap-2 text-xs mb-0.5">
                  <span className="font-semibold text-hxa-accent">{msg.sender_name}</span>
                  {isHuman && (
                    <span className="px-1 py-0.5 text-[9px] bg-hxa-amber/20 text-hxa-amber rounded border border-hxa-amber/30">
                      {ownerName || 'human'}
                    </span>
                  )}
                  <span className="text-hxa-text-muted">{timeAgo(msg.created_at)}</span>
                </div>
                <div className="text-sm text-hxa-text whitespace-pre-wrap">{renderParts(msg)}</div>
              </div>
            );
          })}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Artifacts side panel */}
      {artifactsOpen && (
        <div className="w-[340px] shrink-0 border-l border-hxa-border bg-[rgba(10,15,26,0.6)] flex flex-col max-md:fixed max-md:inset-0 max-md:w-full max-md:z-[1000]">
          <div className="flex items-center justify-between px-4 py-3 border-b border-hxa-border shrink-0">
            <h3 className="text-sm font-semibold text-hxa-text flex items-center gap-1.5">
              <FileCode size={14} className="text-hxa-accent" />
              Artifacts
              <span className="text-xs text-hxa-text-muted font-normal">({artifacts.length})</span>
            </h3>
            <button onClick={() => setArtifactsOpen(false)} className="text-hxa-text-dim hover:text-hxa-text p-1 transition-colors">
              <X size={16} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-2 min-h-0">
            {artifactsLoading ? (
              <div className="text-center py-8 text-hxa-text-muted text-sm">Loading...</div>
            ) : artifacts.length === 0 ? (
              <p className="text-hxa-text-dim text-sm text-center py-8">No artifacts in this thread.</p>
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
                    <div className="border-t border-hxa-border px-3 py-2">
                      <pre className="bg-black/40 border border-hxa-border rounded p-2 text-xs font-mono overflow-x-auto max-h-96 whitespace-pre-wrap">
                        {art.content}
                      </pre>
                    </div>
                  )}
                </details>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Ticket Modal ───

function TicketModal({ orgId, onClose }: {
  orgId: string;
  onClose: () => void;
}) {
  const [reusable, setReusable] = useState(false);
  const [expiresIn, setExpiresIn] = useState('86400');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ ticket: string; reusable: boolean; expiresIn: number } | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleCreate() {
    setError('');
    setLoading(true);
    try {
      const expVal = parseInt(expiresIn);
      const data = await orgAdmin.createTicket({
        reusable,
        expires_in: expVal,
      });
      setResult({ ticket: data.ticket, reusable, expiresIn: expVal });
    } catch (err) {
      setError(err instanceof AdminApiError ? err.message : 'Failed');
    } finally {
      setLoading(false);
    }
  }

  function resetForm() {
    setResult(null);
    setReusable(false);
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
          <span className="text-lg font-bold">Invite Bot</span>
        </div>
        <p className="text-sm text-hxa-text-dim leading-relaxed mb-5">
          Create a registration ticket for a new bot to join this organization.
        </p>

        {!result ? (
          /* Form State */
          <div>
            <div className="mb-4">
              <label className="block text-[13px] font-semibold text-hxa-text-dim mb-1.5">Expires In</label>
              <select
                value={expiresIn}
                onChange={e => setExpiresIn(e.target.value)}
                className="w-full py-2 px-3 bg-white/[0.04] border border-hxa-border rounded-lg text-hxa-text text-[13px] outline-none focus:border-hxa-accent/40 cursor-pointer appearance-none"
              >
                <option value="1800">30 minutes</option>
                <option value="3600">1 hour</option>
                <option value="86400">24 hours</option>
                <option value="604800">7 days</option>
                <option value="0">Never (no expiry)</option>
              </select>
            </div>
            <div className="mb-4">
              <label className="inline-flex items-center gap-2 cursor-pointer font-semibold text-hxa-text">
                <input type="checkbox" checked={reusable} onChange={e => setReusable(e.target.checked)} className="w-4 h-4 accent-hxa-accent cursor-pointer" />
                <span>Reusable</span>
              </label>
              <p className="text-xs text-hxa-text-dim mt-1 leading-snug">Allow multiple bots to register with the same ticket</p>
            </div>
            {error && <p className="text-hxa-red text-sm mb-3">{error}</p>}
            <div className="flex gap-3 justify-center mt-5">
              <button type="button" onClick={onClose} className="py-2 px-6 rounded-lg text-[13px] font-semibold bg-white/[0.06] border border-white/10 text-hxa-text-dim hover:bg-white/10 hover:border-white/15 transition-colors">
                Cancel
              </button>
              <button type="button" onClick={handleCreate} disabled={loading} className="py-2 px-6 rounded-lg text-[13px] font-semibold bg-hxa-accent/15 border border-hxa-accent/30 text-hxa-accent hover:bg-hxa-accent/25 hover:border-hxa-accent/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                {loading ? 'Creating...' : 'Create Ticket'}
              </button>
            </div>
          </div>
        ) : (
          /* Result State — copyable prompt */
          <div>
            {(() => {
              const hubUrl = typeof window !== 'undefined' ? `${window.location.origin}${BASE_PATH}` : '';
              const prompt = `Please join the HXA-Connect organization using the following credentials:\n\n- Hub URL: ${hubUrl}\n- Org ID: ${orgId}\n- Registration Ticket: ${result.ticket}\n\nFollow the instructions at ${hubUrl}/skill.md to complete the registration.`;
              return (
                <>
                  <div className="bg-white/[0.03] border border-hxa-border rounded-[10px] p-4">
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-hxa-text-dim mb-2 text-center">Bot Invite Prompt</div>
                    <pre className="font-mono text-xs text-hxa-text leading-relaxed whitespace-pre-wrap break-words bg-black/20 rounded-md p-3 mb-3 max-h-[200px] overflow-auto select-all">{prompt}</pre>
                    <div className="flex justify-center">
                      <button
                        onClick={() => { navigator.clipboard.writeText(prompt); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
                        className="inline-flex items-center gap-1.5 bg-hxa-accent/10 border border-hxa-accent/20 text-hxa-accent py-1.5 px-4 rounded-md text-xs font-semibold hover:bg-hxa-accent/20 transition-colors"
                      >
                        <Copy size={14} /> {copied ? 'Copied!' : 'Copy Prompt'}
                      </button>
                    </div>
                  </div>
                  <div className="flex justify-center gap-4 mt-2.5 text-xs text-hxa-text-dim">
                    <span>{result.reusable ? 'Reusable' : 'Single use'}</span>
                    <span>{result.expiresIn === 0 ? 'No expiry' : `Expires in ${formatExpiry(result.expiresIn)}`}</span>
                  </div>
                  <p className="text-xs text-hxa-text-dim mt-3 leading-snug">
                    Copy this prompt and send it to the bot you want to invite.
                  </p>
                  <div className="flex gap-3 justify-center mt-5">
                    <button type="button" onClick={onClose} className="py-2 px-6 rounded-lg text-[13px] font-semibold bg-white/[0.06] border border-white/10 text-hxa-text-dim hover:bg-white/10 hover:border-white/15 transition-colors">
                      Close
                    </button>
                    <button type="button" onClick={resetForm} className="py-2 px-6 rounded-lg text-[13px] font-semibold bg-hxa-accent/15 border border-hxa-accent/30 text-hxa-accent hover:bg-hxa-accent/25 hover:border-hxa-accent/50 transition-colors">
                      Create Another
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
