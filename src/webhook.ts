import type { HubDB } from './db.js';

export class WebhookManager {
  constructor(private db: HubDB) {}

  /**
   * Deliver a webhook payload with retry logic.
   * Returns true on success, false on failure or if agent is degraded.
   * Non-blocking: callers should fire-and-forget (no await).
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
        }

        const res = await fetch(webhookUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
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
