import crypto from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { URL } from 'node:url';
import type { HubDB } from './db.js';
import { webhookLogger } from './logger.js';

/**
 * Compute HMAC-SHA256 signature for a webhook payload.
 * Returns hex-encoded signature string.
 */
function computeHmacSignature(secret: string, body: string): string {
  return crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

/**
 * Check if an IP address is in a private/reserved range.
 */
function isPrivateIP(ip: string): boolean {
  // Strip IPv4-mapped IPv6 prefix — two forms:
  //   dotted:  ::ffff:127.0.0.1
  //   hex:     ::ffff:7f00:1  (127.0.0.1 encoded as two 16-bit hex groups)
  let normalized = ip;
  const v4mappedDotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i;
  const dottedMatch = v4mappedDotted.exec(normalized);
  if (dottedMatch) {
    normalized = dottedMatch[1];
  } else {
    const v4mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i;
    const hexMatch = v4mappedHex.exec(normalized);
    if (hexMatch) {
      const hi = parseInt(hexMatch[1], 16);
      const lo = parseInt(hexMatch[2], 16);
      normalized = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    }
  }

  // IPv4 private ranges
  if (/^127\./.test(normalized)) return true;                          // 127.0.0.0/8
  if (/^10\./.test(normalized)) return true;                           // 10.0.0.0/8
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(normalized)) return true;     // 172.16.0.0/12
  if (/^192\.168\./.test(normalized)) return true;                     // 192.168.0.0/16
  if (/^169\.254\./.test(normalized)) return true;                     // 169.254.0.0/16 (link-local)
  if (/^0\./.test(normalized)) return true;                            // 0.0.0.0/8
  // IPv6 private ranges
  if (normalized === '::1') return true;                               // loopback
  if (/^f[cd]/i.test(normalized)) return true;                         // fc00::/7 (unique local)
  if (/^fe80/i.test(normalized)) return true;                          // fe80::/10 (link-local)
  return false;
}

/**
 * Validate a webhook URL for SSRF safety.
 * - Must be https in production (http allowed in development)
 * - Hostname must not resolve to a private IP
 * Returns null if valid, or an error string if invalid.
 */
export async function validateWebhookUrl(url: string): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'webhook_url is not a valid URL';
  }

  const isDev = (process.env.NODE_ENV || 'development') !== 'production';

  // Scheme check
  if (parsed.protocol === 'http:' && !isDev) {
    return 'webhook_url must use https in production';
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return 'webhook_url must use http or https scheme';
  }

  // Resolve hostname and check for private IPs
  // URL.hostname wraps IPv6 literals in brackets (e.g. [::1]) — strip them for dns.lookup
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  try {
    const { address } = await lookup(hostname);
    if (isPrivateIP(address)) {
      return 'webhook_url must not resolve to a private/internal IP address';
    }
  } catch (err: any) {
    // ENOTFOUND = domain doesn't exist; other errors = temporary DNS failure
    if (err?.code === 'ENOTFOUND') {
      return 'webhook_url hostname could not be resolved';
    }
    return 'webhook_url hostname DNS lookup failed temporarily — please try again';
  }

  return null;
}

export class WebhookManager {
  constructor(private db: HubDB) {}

  /**
   * Deliver a webhook payload with retry logic and HMAC signing.
   * Returns true on success, false on failure or if agent is degraded.
   * Non-blocking: callers should fire-and-forget (no await).
   *
   * When webhook_secret is set, the request includes:
   * - Authorization: Bearer <secret> (legacy, for backward compat)
   * - X-Hub-Signature-256: sha256=<hex> (HMAC-SHA256 of "timestamp.body")
   * - X-Hub-Timestamp: <unix_ms> (request timestamp for replay protection)
   */
  async deliver(
    agentId: string,
    webhookUrl: string,
    webhookSecret: string | null,
    payload: unknown,
  ): Promise<boolean> {
    // Check if degraded — skip delivery
    if (this.db.isWebhookDegraded(agentId)) {
      return false;
    }

    // SSRF re-validation at delivery time to prevent DNS rebinding (TOCTOU)
    // Registration-time check alone is insufficient: attacker can register with
    // a public IP then switch DNS to a private IP before delivery.
    let parsed: URL;
    try {
      parsed = new URL(webhookUrl);
    } catch {
      webhookLogger.warn({ agentId }, 'Invalid webhook URL at delivery time');
      return false;
    }
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    try {
      const { address } = await lookup(hostname);
      if (isPrivateIP(address)) {
        webhookLogger.warn({ agentId }, 'Blocked webhook — resolved to private IP at delivery time');
        return false;
      }
    } catch {
      // DNS failure at delivery time — skip silently, will retry
    }

    const body = JSON.stringify(payload);

    // Retry strategy: immediate, then 1s, 5s, 30s (4 attempts total)
    const delays = [0, 1000, 5000, 30000];

    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (attempt > 0) {
        await new Promise(resolve => setTimeout(resolve, delays[attempt]));
      }

      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (webhookSecret) {
          headers['Authorization'] = `Bearer ${webhookSecret}`;
          // Regenerate timestamp on each attempt for fresh replay-protection window
          const timestamp = String(Date.now());
          const signedPayload = `${timestamp}.${body}`;
          const signature = computeHmacSignature(webhookSecret, signedPayload);
          headers['X-Hub-Signature-256'] = `sha256=${signature}`;
          headers['X-Hub-Timestamp'] = timestamp;
        }

        const res = await fetch(webhookUrl, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(10000), // 10s timeout per attempt
        });

        if (res.ok || (res.status >= 200 && res.status < 300)) {
          this.db.recordWebhookSuccess(agentId);
          return true;
        }

        webhookLogger.warn({ agentId, attempt: attempt + 1, status: res.status }, 'Webhook delivery attempt failed');
      } catch (err: any) {
        webhookLogger.warn({ agentId, attempt: attempt + 1, err: err.message }, 'Webhook delivery attempt error');
      }
    }

    // All retries failed
    this.db.recordWebhookFailure(agentId);
    webhookLogger.error({ agentId }, 'Webhook delivery failed after all retries');
    return false;
  }
}

/**
 * Verify a webhook signature. For use by bot endpoints receiving webhooks.
 *
 * @param secret - The webhook secret shared between Hub and bot
 * @param signature - Value of X-Hub-Signature-256 header (e.g. "sha256=abc123...")
 * @param timestamp - Value of X-Hub-Timestamp header
 * @param body - Raw request body string
 * @param maxAgeMs - Maximum age of the timestamp (default 5 minutes, for replay protection)
 * @returns true if signature is valid and timestamp is fresh
 */
export function verifyWebhookSignature(
  secret: string,
  signature: string,
  timestamp: string,
  body: string,
  maxAgeMs = 5 * 60 * 1000,
): boolean {
  // Check timestamp freshness (replay protection)
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts) || Math.abs(Date.now() - ts) > maxAgeMs) {
    return false;
  }

  // Verify HMAC
  const expected = computeHmacSignature(secret, `${timestamp}.${body}`);
  const provided = signature.startsWith('sha256=') ? signature.slice(7) : signature;

  // Validate hex format explicitly — SHA-256 digest is always 64 hex chars
  if (!/^[0-9a-f]{64}$/i.test(provided)) return false;

  const expectedBuf = Buffer.from(expected, 'hex');
  const providedBuf = Buffer.from(provided, 'hex');
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}
