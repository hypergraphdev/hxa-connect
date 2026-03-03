'use client';

import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import type { SessionData } from '@/lib/types';
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

export function useSessionState(): SessionState {
  const [session, setSession] = useState<SessionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Check existing session on mount
  useEffect(() => {
    api.getSession()
      .then(setSession)
      .catch(() => setSession(null))
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (params: { token: string; owner_name: string }) => {
    setError(null);
    setLoading(true);
    try {
      const data = await api.login(params);
      setSession(data);
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
