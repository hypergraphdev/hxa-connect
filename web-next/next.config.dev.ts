import type { NextConfig } from 'next';

/**
 * Dev-only config: proxies /api/* to the remote production server.
 * Used with: NEXT_CONFIG_FILE=next.config.dev.ts next dev
 * This allows local frontend development against the live remote backend.
 */

const REMOTE = 'https://www.ucai.net/connect';

const nextConfig: NextConfig = {
  // No "output: export" here — we need the Next.js server to handle rewrites
  trailingSlash: true,
  images: { unoptimized: true },
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${REMOTE}/api/:path*`,
      },
      {
        source: '/files/:path*',
        destination: `${REMOTE}/files/:path*`,
      },
    ];
  },
};

export default nextConfig;
