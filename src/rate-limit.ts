/**
 * Login rate limiter — in-memory, composite key, periodic cleanup.
 * ADR-002: 5 failures per key → 15min lockout, 20 per IP → 15min IP lockout.
 * super_admin: 3 failures → 30min lockout.
 */

interface RateLimitEntry {
  failures: number;
  locked_until: number | null;
  last_failure: number;
}

const limitStore = new Map<string, RateLimitEntry>();

const LOCKOUT_MS = 15 * 60 * 1000;           // 15 minutes
const SUPER_ADMIN_LOCKOUT_MS = 30 * 60 * 1000; // 30 minutes
const MAX_FAILURES = 5;
const SUPER_ADMIN_MAX_FAILURES = 3;
const IP_MAX_FAILURES = 20;
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000;  // 30 minutes

export interface RateLimitResult {
  allowed: boolean;
  retryAfter?: number; // seconds until unlock
}

/**
 * Check rate limit before a login attempt.
 * @param ip - Client IP
 * @param type - Login type: 'bot', 'org_admin', 'super_admin'
 * @param identifier - Type-specific key (token prefix, org_id, or empty for super_admin)
 */
export function checkLoginRateLimit(ip: string, type: string, identifier: string): RateLimitResult {
  const now = Date.now();

  // Check IP-wide limit
  const ipKey = `ip:${ip}`;
  const ipEntry = limitStore.get(ipKey);
  if (ipEntry?.locked_until && ipEntry.locked_until > now) {
    return { allowed: false, retryAfter: Math.ceil((ipEntry.locked_until - now) / 1000) };
  }

  // Check per-key limit
  const key = `${ip}:${type}:${identifier}`;
  const entry = limitStore.get(key);
  if (entry?.locked_until && entry.locked_until > now) {
    return { allowed: false, retryAfter: Math.ceil((entry.locked_until - now) / 1000) };
  }

  return { allowed: true };
}

/**
 * Record a failed login attempt.
 */
export function recordLoginFailure(ip: string, type: string, identifier: string): void {
  const now = Date.now();
  const isSuperAdmin = type === 'super_admin';
  const maxFailures = isSuperAdmin ? SUPER_ADMIN_MAX_FAILURES : MAX_FAILURES;
  const lockoutMs = isSuperAdmin ? SUPER_ADMIN_LOCKOUT_MS : LOCKOUT_MS;

  // Per-key tracking
  const key = `${ip}:${type}:${identifier}`;
  const entry = limitStore.get(key) || { failures: 0, locked_until: null, last_failure: 0 };
  entry.failures++;
  entry.last_failure = now;
  if (entry.failures >= maxFailures) {
    entry.locked_until = now + lockoutMs;
  }
  limitStore.set(key, entry);

  // IP aggregate tracking
  const ipKey = `ip:${ip}`;
  const ipEntry = limitStore.get(ipKey) || { failures: 0, locked_until: null, last_failure: 0 };
  ipEntry.failures++;
  ipEntry.last_failure = now;
  if (ipEntry.failures >= IP_MAX_FAILURES) {
    ipEntry.locked_until = now + LOCKOUT_MS;
  }
  limitStore.set(ipKey, ipEntry);
}

/**
 * Clear rate limit entries older than 30 minutes.
 * Call periodically via setInterval.
 */
export function cleanupRateLimits(): void {
  const cutoff = Date.now() - CLEANUP_INTERVAL_MS;
  for (const [key, entry] of limitStore) {
    if (entry.last_failure < cutoff && (!entry.locked_until || entry.locked_until < Date.now())) {
      limitStore.delete(key);
    }
  }
}

// Auto-cleanup interval
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

export function startRateLimitCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(cleanupRateLimits, CLEANUP_INTERVAL_MS);
  // Unref so the timer doesn't keep the process alive during shutdown
  if (cleanupTimer.unref) cleanupTimer.unref();
}
