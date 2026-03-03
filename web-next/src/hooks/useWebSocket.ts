'use client';

import { useEffect, useRef, useCallback } from 'react';
import type { WsEvent } from '@/lib/types';
import * as api from '@/lib/api';

interface UseWebSocketOptions {
  /** Called for every WS event */
  onEvent: (event: WsEvent) => void;
  /** Called when connection state changes */
  onStatusChange?: (connected: boolean) => void;
  /** Set false to disable connection (e.g. no session yet) */
  enabled?: boolean;
}

/**
 * Manages a WebSocket connection to HXA-Connect with auto-reconnect.
 * Obtains a short-lived ticket from the session API, then connects.
 */
export function useWebSocket({ onEvent, onStatusChange, enabled = true }: UseWebSocketOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const retriesRef = useRef(0);
  const enabledRef = useRef(enabled);
  const onEventRef = useRef(onEvent);
  const onStatusRef = useRef(onStatusChange);

  // Keep refs current without re-triggering effect
  useEffect(() => { enabledRef.current = enabled; }, [enabled]);
  useEffect(() => { onEventRef.current = onEvent; }, [onEvent]);
  useEffect(() => { onStatusRef.current = onStatusChange; }, [onStatusChange]);

  const connect = useCallback(async () => {
    if (!enabledRef.current) return;
    // Close any existing connection
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.close();
    }

    try {
      const { ticket } = await api.getWsTicket();
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      // WS endpoint is at /ws (not /ui/ws). Prepend base path for proxy-prefix deployments.
      const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
      const ws = new WebSocket(`${proto}//${location.host}${basePath}/ws?ticket=${ticket}`);

      ws.onopen = () => {
        retriesRef.current = 0;
        onStatusRef.current?.(true);
      };

      ws.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data) as WsEvent;
          onEventRef.current(event);
        } catch { /* ignore malformed */ }
      };

      ws.onclose = (e) => {
        onStatusRef.current?.(false);
        wsRef.current = null;

        // 4001 = auth failure — don't reconnect
        if (e.code === 4001) return;

        if (enabledRef.current) {
          // Exponential backoff: 1s, 2s, 4s, 8s, max 30s
          const delay = Math.min(1000 * 2 ** retriesRef.current, 30000);
          retriesRef.current++;
          setTimeout(connect, delay);
        }
      };

      ws.onerror = () => { /* onclose will fire */ };

      wsRef.current = ws;
    } catch {
      // Ticket fetch failed — retry after delay
      if (enabledRef.current) {
        const delay = Math.min(1000 * 2 ** retriesRef.current, 30000);
        retriesRef.current++;
        setTimeout(connect, delay);
      }
    }
  }, []);

  useEffect(() => {
    if (enabled) {
      connect();
    }
    return () => {
      enabledRef.current = false;
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [enabled, connect]);
}
