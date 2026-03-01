// ─── WS Metrics Counters ─────────────────────────────────────
// Simple in-process counters for observability.
// Exposed via getHealthStats() for the /health endpoint.

export interface WsMetrics {
  ops_total: number;
  acks_total: number;
  errors_total: number;
  conflicts_total: number;
  rate_limited_total: number;
}

const counters: WsMetrics = {
  ops_total: 0,
  acks_total: 0,
  errors_total: 0,
  conflicts_total: 0,
  rate_limited_total: 0,
};

export function incOp(): void { counters.ops_total++; }
export function incAck(): void { counters.acks_total++; }
export function incError(code?: string): void {
  counters.errors_total++;
  if (code === 'REVISION_CONFLICT') counters.conflicts_total++;
  if (code === 'RATE_LIMITED') counters.rate_limited_total++;
}

export function getMetrics(): Readonly<WsMetrics> {
  return { ...counters };
}
