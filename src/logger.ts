import pino from 'pino';
import crypto from 'node:crypto';

const isDev = (process.env.NODE_ENV || 'development') !== 'production';
const level = process.env.HXA_CONNECT_LOG_LEVEL || (isDev ? 'debug' : 'info');

const transport = isDev
  ? pino.transport({ target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } })
  : undefined;

export const logger = pino({ level }, transport);

// ─── Child loggers for different components ─────────────────
export const wsLogger = logger.child({ component: 'ws' });
export const webhookLogger = logger.child({ component: 'webhook' });
export const dbLogger = logger.child({ component: 'db' });
export const routeLogger = logger.child({ component: 'routes' });

// ─── Request ID generation ──────────────────────────────────
export function generateRequestId(): string {
  return crypto.randomUUID();
}
