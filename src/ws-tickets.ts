import crypto from 'node:crypto';

// ─── WS Ticket Store ──────────────────────────────────────────
// One-time short-lived tickets for secure WebSocket authentication.
// Tickets are stored in memory (not DB) and invalidated immediately after use.

export interface WsTicket {
  /** The raw token that was exchanged for this ticket */
  token: string;
  /** Epoch ms when this ticket expires (30s TTL) */
  expiresAt: number;
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
 * Issue a one-time WS ticket for the given token.
 * Returns the ticket ID (to be used as ?ticket=xxx).
 */
export function issueWsTicket(token: string): string {
  purgeExpiredTickets();
  const ticketId = crypto.randomBytes(24).toString('hex');
  wsTicketStore.set(ticketId, {
    token,
    expiresAt: Date.now() + WS_TICKET_TTL_MS,
  });
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
