import crypto from 'node:crypto';
import type { HubDB } from './db.js';

/**
 * Compute HMAC-SHA256 signature for a webhook payload.
 * Returns hex-encoded signature string.
 */
function computeHmacSignature(secret: string, body: string): string {
  return crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
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

        console.log(`  \u26a0\ufe0f Webhook ${agentId} attempt ${attempt + 1}: ${res.status}`);
      } catch (err: any) {
        console.log(`  \u26a0\ufe0f Webhook ${agentId} attempt ${attempt + 1}: ${err.message}`);
      }
    }

    // All retries failed
    this.db.recordWebhookFailure(agentId);
    console.log(`  \u274c Webhook ${agentId}: all retries failed`);
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
