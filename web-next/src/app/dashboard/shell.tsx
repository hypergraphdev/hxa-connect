'use client';

import { useEffect, useState, useCallback, createContext, useContext } from 'react';
import { useRouter } from 'next/navigation';
import { SessionContext, useSessionState } from '@/hooks/useSession';
import { useWebSocket } from '@/hooks/useWebSocket';
import { Header } from '@/components/layout/Header';
import { Sidebar } from '@/components/layout/Sidebar';
import { ThreadList } from '@/components/thread/ThreadList';
import { DMList } from '@/components/dm/DMList';
import type { WsEvent, Thread, ThreadMessage, ThreadStatus, Artifact, DmMessage, Channel } from '@/lib/types';

type Tab = 'threads' | 'dms';

function tabFromPath(pathname: string): Tab {
  if (pathname.includes('/dms')) return 'dms';
  return 'threads';
}

// ─── Dashboard Navigation Context ───

const DASHBOARD_BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

export interface DashNavState {
  section: string;
  id?: string;
  navigate: (path: string) => void;
}

const DashNavContext = createContext<DashNavState>({
  section: '',
  id: undefined,
  navigate: () => {},
});

export function useDashNav(): DashNavState {
  return useContext(DashNavContext);
}

// ─── WS Event Context ───

export interface WsEventState {
  wsConnected: boolean;
  wsThreads: Thread[];
  wsMessages: ThreadMessage[];
  wsArtifacts: Artifact[];
  wsThread: Thread | undefined;
  wsThreadStatusChange: { thread_id: string; to: ThreadStatus } | undefined;
  wsParticipantEvents: Array<{ thread_id: string; bot_id: string; bot_name: string; action: 'joined' | 'left' }>;
  wsBotStatusEvents: Array<{ bot_id: string; bot_name: string; online: boolean }>;
  wsDmMessages: DmMessage[];
  wsNewChannels: Channel[];
}

const WsEventContext = createContext<WsEventState>({
  wsConnected: false,
  wsThreads: [],
  wsMessages: [],
  wsArtifacts: [],
  wsThread: undefined,
  wsThreadStatusChange: undefined,
  wsParticipantEvents: [],
  wsBotStatusEvents: [],
  wsDmMessages: [],
  wsNewChannels: [],
});

export function useWsEvents(): WsEventState {
  return useContext(WsEventContext);
}

// ─── Route helpers (hash-first) ───

function parseRoute(p: string): { section: string; id?: string } {
  let pathname = p;
  if (!pathname.startsWith('/')) pathname = `/${pathname}`;

  const clean = pathname.split('?')[0];
  const parts = clean
    .replace(/^\/+/, '')
    .split('/')
    .filter(Boolean);

  const body = parts[0] === 'dashboard' ? parts.slice(1) : parts;
  return { section: body[0] ?? '', id: body[1] };
}

function getLocationRoute(): { path: string; section: string; id?: string } {
  if (typeof window === 'undefined') return { path: '/', section: '', id: undefined };
  const rawHash = window.location.hash || '';
  const rawPath = rawHash.startsWith('#') && rawHash.length > 1
    ? rawHash.slice(1)
    : window.location.pathname;

  let path = rawPath;
  if (DASHBOARD_BASE && path.startsWith(DASHBOARD_BASE)) {
    path = path.slice(DASHBOARD_BASE.length);
  }
  if (!path) path = '/';
  if (!path.startsWith('/')) path = `/${path}`;

  const { section, id } = parseRoute(path);
  return { path, section, id };
}

// ─── Shell ───

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const sessionState = useSessionState();
  const router = useRouter();

  const route = getLocationRoute();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>(() => tabFromPath(route.path));
  const [navRoute, setNavRoute] = useState<{ section: string; id?: string }>(() => ({
    section: route.section,
    id: route.id,
  }));

  // WS event state
  const [wsConnected, setWsConnected] = useState(false);
  const [wsThreads, setWsThreads] = useState<Thread[]>([]);
  const [wsMessages, setWsMessages] = useState<ThreadMessage[]>([]);
  const [wsArtifacts, setWsArtifacts] = useState<Artifact[]>([]);
  const [wsThread, setWsThread] = useState<Thread | undefined>();
  const [wsDmMessages, setWsDmMessages] = useState<DmMessage[]>([]);
  const [wsThreadStatusChange, setWsThreadStatusChange] = useState<{ thread_id: string; to: ThreadStatus } | undefined>();
  const [wsParticipantEvents, setWsParticipantEvents] = useState<WsEventState['wsParticipantEvents']>([]);
  const [wsBotStatusEvents, setWsBotStatusEvents] = useState<WsEventState['wsBotStatusEvents']>([]);
  const [wsNewChannels, setWsNewChannels] = useState<Channel[]>([]);

  const syncFromCurrentLocation = useCallback(() => {
    const next = getLocationRoute();
    setNavRoute({ section: next.section, id: next.id });
    setActiveTab(tabFromPath(next.path));
    setWsMessages([]);
    setWsDmMessages([]);
    setWsArtifacts([]);
  }, []);

  const navigate = useCallback((path: string) => {
    const resolved = path.startsWith('/') ? path : `/${path}`;
    window.history.pushState(null, '', `#${resolved}`);
    syncFromCurrentLocation();
  }, [syncFromCurrentLocation]);

  const handleWsEvent = useCallback((event: WsEvent) => {
    switch (event.type) {
      case 'thread_created':
        setWsThreads((prev) => [event.thread, ...prev]);
        break;
      case 'thread_updated':
        setWsThreads((prev) => {
          const idx = prev.findIndex((t) => t.id === event.thread.id);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = event.thread;
            return next;
          }
          return [event.thread, ...prev];
        });
        setWsThread(event.thread);
        break;
      case 'thread_status_changed':
        // Update thread in sidebar list
        setWsThreads((prev) => prev.map((t) =>
          t.id === event.thread_id ? { ...t, status: event.to } : t
        ));
        // Propagate to active ThreadView so it can update status/composer
        setWsThreadStatusChange({ thread_id: event.thread_id, to: event.to });
        break;
      case 'thread_message':
        setWsMessages((prev) => [...prev, event.message]);
        break;
      case 'thread_artifact':
        setWsArtifacts((prev) => [...prev, event.artifact]);
        break;
      case 'thread_participant':
        setWsParticipantEvents((prev) => [...prev, { thread_id: event.thread_id, bot_id: event.bot_id, bot_name: event.bot_name, action: event.action }]);
        break;
      case 'message':
        setWsDmMessages((prev) => [...prev, { ...event.message, sender_name: event.message.sender_name || event.sender_name }]);
        break;
      case 'channel_created':
        setWsNewChannels((prev) => [...prev, event.channel]);
        break;
      case 'bot_online':
      case 'bot_offline':
        setWsBotStatusEvents((prev) => [...prev, { bot_id: event.bot.id, bot_name: event.bot.name, online: event.type === 'bot_online' }]);
        break;
      case 'bot_registered':
        setWsBotStatusEvents((prev) => [...prev, { bot_id: event.bot.id, bot_name: event.bot.name, online: false }]);
        break;
    }
  }, []);

  const handleSessionExpired = useCallback(async () => {
    await sessionState.logout();
    router.replace('/');
  }, [sessionState, router]);

  useWebSocket({
    onEvent: handleWsEvent,
    onStatusChange: setWsConnected,
    onSessionExpired: handleSessionExpired,
    enabled: !!sessionState.session,
  });

  // Redirect to login if no session, or wrong role
  useEffect(() => {
    if (!sessionState.loading && !sessionState.session) {
      router.replace('/');
    } else if (!sessionState.loading && sessionState.session && sessionState.session.role !== 'bot_owner') {
      router.replace('/');
    }
  }, [sessionState.loading, sessionState.session, router]);

  // Sync tab with current URL (supports history back/forward and deep link hash)
  useEffect(() => {
    syncFromCurrentLocation();
    window.addEventListener('popstate', syncFromCurrentLocation);
    window.addEventListener('hashchange', syncFromCurrentLocation);
    return () => {
      window.removeEventListener('popstate', syncFromCurrentLocation);
      window.removeEventListener('hashchange', syncFromCurrentLocation);
    };
  }, [syncFromCurrentLocation]);

  function handleTabChange(tab: Tab) {
    navigate(tab === 'dms' ? '/dashboard/dms/' : '/dashboard/');
  }

  if (sessionState.loading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center">
        <div className="h-6 w-6 rounded-full border-3 border-hxa-accent/20 border-t-hxa-accent animate-spin" />
      </div>
    );
  }

  if (!sessionState.session) return null;

  const sidebarContent = (() => {
    switch (activeTab) {
      case 'threads':
        return <ThreadList wsThreads={wsThreads} />;
      case 'dms':
        return <DMList wsDmMessages={wsDmMessages} wsNewChannels={wsNewChannels} />;
    }
  })();

  return (
    <SessionContext value={sessionState}>
      <DashNavContext value={{ ...navRoute, navigate }}>
        <WsEventContext value={{
          wsConnected, wsThreads, wsMessages, wsArtifacts, wsThread,
          wsThreadStatusChange, wsParticipantEvents, wsBotStatusEvents, wsDmMessages, wsNewChannels,
        }}>
          <div className="fixed inset-0 flex flex-col animate-fade-in">
            <Header onMenuToggle={() => setSidebarOpen((o) => !o)} wsConnected={wsConnected} />
            <div className="flex-1 flex min-h-0 overflow-hidden">
              <Sidebar
                open={sidebarOpen}
                onClose={() => setSidebarOpen(false)}
                activeTab={activeTab}
                onTabChange={handleTabChange}
              >
                {sidebarContent}
              </Sidebar>
              <main className="flex-1 flex flex-col overflow-hidden min-w-0">
                {children}
              </main>
            </div>
          </div>
        </WsEventContext>
      </DashNavContext>
    </SessionContext>
  );
}
