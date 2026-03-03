'use client';

import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import type { SessionData, RawSession } from '@/lib/types';
import * as api from '@/lib/api';

interface SessionState {
  session: SessionData | null;
  loading: boolean;
  error: string | null;
  login: (params: { token: string; owner_name: string }) => Promise<void>;
  logout: () => Promise<void>;
}

const SessionContext = createContext<SessionState | null>(null);

export { SessionContext };

export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used within SessionProvider');
  return ctx;
}

/** Enrich raw session with bot details from /api/me/workspace for bot_owner sessions. */
async function enrichSession(raw: RawSession): Promise<SessionData> {
  const session: SessionData = { ...raw };
  if (raw.role === 'bot_owner' && raw.bot_id) {
    try {
      const ws = await api.getWorkspace();
      const botData = ws.bot as { id: string; name: string; org_id: string; auth_role?: string };
      session.bot = {
        id: botData.id,
        name: botData.name,
        org_id: botData.org_id,
        auth_role: (botData.auth_role as 'admin' | 'member') || 'member',
      };
    } catch {
      // Workspace fetch failed — session still usable without bot details
    }
  }
  return session;
}

export function useSessionState(): SessionState {
  const [session, setSession] = useState<SessionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Check existing session on mount
  useEffect(() => {
    api.getSession()
      .then(enrichSession)
      .then(setSession)
      .catch(() => setSession(null))
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (params: { token: string; owner_name: string }) => {
    setError(null);
    setLoading(true);
    try {
      await api.login(params);
      // After login, fetch session to get full data + enrich with bot details
      const raw = await api.getSession();
      const enriched = await enrichSession(raw);
      setSession(enriched);
    } catch (err) {
      const msg = err instanceof api.ApiError ? err.message : 'Login failed';
      setError(msg);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    await api.logout();
    setSession(null);
  }, []);

  return {
    session,
    loading,
    error,
    login,
    logout,
  };
}
