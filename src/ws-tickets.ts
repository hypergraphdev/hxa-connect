import crypto from 'node:crypto';
import type { SessionRole, TokenScope } from './types.js';

// ─── WS Ticket Store ──────────────────────────────────────────
// One-time short-lived tickets for secure WebSocket authentication.
// Tickets are stored in memory (not DB) and invalidated immediately after use.

export interface WsTicket {
  /** The raw token that was exchanged for this ticket (bot API flow) */
  token?: string;
  /** Org binding for multi-org validation (Phase 3) */
  orgId?: string;
  /** Epoch ms when this ticket expires (30s TTL) */
  expiresAt: number;
  /** Session-based flow (ADR-002) */
  sessionId?: string;
  role?: SessionRole;
  botId?: string;
  scopes?: TokenScope[] | null;
  isScopedToken?: boolean;
}

/** In-memory ticket store: ticketId → WsTicket (module-private to enforce one-time-use semantics) */
const wsTicketStore = new Map<string, WsTicket>();

const WS_TICKET_TTL_MS = 30_000; // 30 seconds

/** Purge expired tickets (called lazily on each issue/redeem) */
function purgeExpiredTickets() {
  const now = Date.now();
  for (const [id, ticket] of wsTicketStore) {
    if (ticket.expiresAt < now) {
      wsTicketStore.delete(id);
    }
  }
}

/**
 * Issue a one-time WS ticket.
 * Accepts either a bot token (existing flow) or session identity (ADR-002).
 */
export function issueWsTicket(auth: { token: string; orgId?: string } | {
  sessionId: string; role: SessionRole; botId?: string;
  orgId: string; scopes?: TokenScope[] | null; isScopedToken?: boolean;
}): string {
  purgeExpiredTickets();
  const ticketId = crypto.randomBytes(24).toString('hex');
  if ('token' in auth) {
    wsTicketStore.set(ticketId, {
      token: auth.token,
      orgId: auth.orgId,
      expiresAt: Date.now() + WS_TICKET_TTL_MS,
    });
  } else {
    wsTicketStore.set(ticketId, {
      sessionId: auth.sessionId,
      role: auth.role,
      botId: auth.botId,
      orgId: auth.orgId,
      scopes: auth.scopes,
      isScopedToken: auth.isScopedToken,
      expiresAt: Date.now() + WS_TICKET_TTL_MS,
    });
  }
  return ticketId;
}

/**
 * Redeem a one-time WS ticket. Returns the ticket if valid, otherwise undefined.
 * Invalidates the ticket immediately on successful redemption.
 */
export function redeemWsTicket(ticketId: string): WsTicket | undefined {
  purgeExpiredTickets();
  const ticket = wsTicketStore.get(ticketId);
  if (!ticket) return undefined;
  if (ticket.expiresAt < Date.now()) {
    wsTicketStore.delete(ticketId);
    return undefined;
  }
  // Invalidate immediately after use (one-time use)
  wsTicketStore.delete(ticketId);
  return ticket;
}
