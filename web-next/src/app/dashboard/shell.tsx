'use client';

import { useEffect, useState, useCallback, createContext, useContext } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { SessionContext, useSessionState } from '@/hooks/useSession';
import { useWebSocket } from '@/hooks/useWebSocket';
import { Header } from '@/components/layout/Header';
import { Sidebar } from '@/components/layout/Sidebar';
import { ThreadList } from '@/components/thread/ThreadList';
import { DMList } from '@/components/dm/DMList';
import type { WsEvent, Thread, ThreadMessage, ThreadStatus, Artifact, DmMessage, Channel, Bot } from '@/lib/types';

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
  wsDmMessages: [],
  wsNewChannels: [],
});

export function useWsEvents(): WsEventState {
  return useContext(WsEventContext);
}

// ─── Shell ───

function parseRoute(p: string): { section: string; id?: string } {
  const parts = p.replace(/^\/dashboard\/?/, '').split('/').filter(Boolean);
  return { section: parts[0] ?? '', id: parts[1] };
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const sessionState = useSessionState();
  const router = useRouter();
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>(() => tabFromPath(pathname));
  const [navRoute, setNavRoute] = useState(() => parseRoute(pathname));

  const navigate = useCallback((path: string) => {
    const url = `${DASHBOARD_BASE}${path}`;
    window.history.pushState(null, '', url);
    setNavRoute(parseRoute(path));
    setActiveTab(tabFromPath(path));
  }, []);

  // WS event state
  const [wsConnected, setWsConnected] = useState(false);
  const [wsThreads, setWsThreads] = useState<Thread[]>([]);
  const [wsMessages, setWsMessages] = useState<ThreadMessage[]>([]);
  const [wsArtifacts, setWsArtifacts] = useState<Artifact[]>([]);
  const [wsThread, setWsThread] = useState<Thread | undefined>();
  const [wsDmMessages, setWsDmMessages] = useState<DmMessage[]>([]);
  const [wsThreadStatusChange, setWsThreadStatusChange] = useState<{ thread_id: string; to: ThreadStatus } | undefined>();
  const [wsNewChannels, setWsNewChannels] = useState<Channel[]>([]);

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
        // Could refresh thread detail, for now just note it
        break;
      case 'message':
        setWsDmMessages((prev) => [...prev, event.message]);
        break;
      case 'channel_created':
        setWsNewChannels((prev) => [...prev, event.channel]);
        break;
      case 'bot_online':
      case 'bot_offline':
        // Bot status tracked for future bot list feature
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

  // Sync tab with path
  useEffect(() => {
    setActiveTab(tabFromPath(pathname));
  }, [pathname]);

  function handleTabChange(tab: Tab) {
    navigate(tab === 'dms' ? '/dashboard/dms/' : '/dashboard/');
  }

  // Handle browser back/forward
  useEffect(() => {
    function onPopState() {
      const p = window.location.pathname.replace(DASHBOARD_BASE, '');
      setNavRoute(parseRoute(p));
      setActiveTab(tabFromPath(p));
    }
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

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
          wsThreadStatusChange, wsDmMessages, wsNewChannels,
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
