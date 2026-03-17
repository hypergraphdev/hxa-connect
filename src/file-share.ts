import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * File share tokens — time-limited HMAC-signed URLs for bot-to-bot file access.
 *
 * Allows AI models inside bots to fetch image/file URLs without a Bearer token.
 * The signing key is the ADMIN_SECRET (required in production).
 * TTL: 24 hours.
 *
 * URL format: /api/files/:id?exp=<unix>&sig=<base64url>
 */

const SHARE_TTL_SECONDS = 24 * 60 * 60; // 24 hours

function getSigningKey(): string {
  return process.env.ADMIN_SECRET || 'hxa-file-share-dev';
}

/**
 * Append a time-limited HMAC signature to a relative /api/files/:id URL.
 * Returns the URL unchanged if it is not a local file path.
 */
export function signFileUrl(relativeUrl: string): string {
  const match = relativeUrl.match(/^(\/api\/files\/)([^/?#]+)/);
  if (!match) return relativeUrl;
  const fileId = match[2];
  const exp = Math.floor(Date.now() / 1000) + SHARE_TTL_SECONDS;
  const sig = createHmac('sha256', getSigningKey())
    .update(`${fileId}:${exp}`)
    .digest('base64url');
  return `${relativeUrl}?exp=${exp}&sig=${sig}`;
}

/**
 * Verify a file share token. Returns true if HMAC is valid and not expired.
 */
export function verifyFileShareToken(fileId: string, exp: string, sig: string): boolean {
  const expNum = parseInt(exp, 10);
  if (!expNum || Math.floor(Date.now() / 1000) > expNum) return false;
  const expected = createHmac('sha256', getSigningKey())
    .update(`${fileId}:${exp}`)
    .digest('base64url');
  try {
    return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(sig, 'utf8'));
  } catch {
    return false;
  }
}
