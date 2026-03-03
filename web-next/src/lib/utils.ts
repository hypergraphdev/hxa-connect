/** Format a timestamp for display */
export function formatTime(ts: string | number): string {
  const d = new Date(typeof ts === 'number' ? ts : ts);
  const now = new Date();
  const diff = now.getTime() - d.getTime();

  // Today: show time only
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  // Yesterday
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) {
    return `Yesterday ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
  }

  // Within a week
  if (diff < 7 * 24 * 60 * 60 * 1000) {
    return d.toLocaleDateString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  }

  // Older
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Safely parse message parts from backend (may be JSON string, null, or already-parsed array).
 *  Falls back to `content` field for legacy messages where parts is null. */
export function parseParts(parts: string | null | import('./types').MessagePart[], content?: string): import('./types').MessagePart[] {
  if (Array.isArray(parts)) return parts;
  if (typeof parts === 'string') {
    try { return JSON.parse(parts); } catch { return [{ type: 'text', content: parts }]; }
  }
  // parts is null — fall back to content field (legacy messages)
  if (content) return [{ type: 'text', content }];
  return [];
}

/** Sanitize a URL to only allow safe schemes (http, https, mailto). Returns '#' for unsafe URLs. */
export function safeHref(url: string | undefined | null): string {
  if (!url) return '#';
  try {
    const parsed = new URL(url, 'https://placeholder');
    if (['http:', 'https:', 'mailto:'].includes(parsed.protocol)) return url;
    return '#';
  } catch {
    return '#';
  }
}

/** Merge class names, filtering falsy values */
export function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}

/** Thread status → display color class */
export function statusColor(status: string): string {
  const map: Record<string, string> = {
    active: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
    blocked: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
    reviewing: 'bg-hxa-purple/20 text-purple-400 border-purple-500/30',
    resolved: 'bg-slate-500/20 text-slate-400 border-slate-500/30',
    closed: 'bg-rose-500/20 text-rose-400 border-rose-500/30',
  };
  return map[status] ?? 'bg-slate-500/20 text-slate-400 border-slate-500/30';
}

/** Valid status transitions for threads */
export const STATUS_TRANSITIONS: Record<string, string[]> = {
  active: ['blocked', 'reviewing', 'resolved'],
  blocked: ['active'],
  reviewing: ['active', 'resolved'],
  resolved: ['active', 'closed'],
  closed: [],
};

/** Thread status filter options — matches B2B protocol */
export const THREAD_STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'All Statuses' },
  { value: 'active', label: 'Active' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'reviewing', label: 'Reviewing' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'closed', label: 'Closed' },
];
