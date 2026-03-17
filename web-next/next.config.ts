import type { NextConfig } from 'next';
import { resolve } from 'path';

// Set NEXT_PUBLIC_BASE_PATH when deploying behind a URL prefix (e.g. "/hub").
// Leave empty when serving from root.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';

// Set NEXT_DEV_REMOTE=true to proxy /api/* to the remote production server
// instead of running a local backend. Useful for local UI debugging.
const devRemote = process.env.NEXT_DEV_REMOTE === 'true';
const REMOTE_API = 'https://www.ucai.net/connect';

const nextConfig: NextConfig = {
  // Static export for production; disabled in remote-dev mode (rewrites require server runtime)
  ...(!devRemote ? { output: 'export' } : {}),
  trailingSlash: true,
  images: { unoptimized: true },
  ...(!devRemote ? { outputFileTracingRoot: resolve(import.meta.dirname) } : {}),
  ...(basePath ? { basePath } : {}),
  ...(devRemote
    ? {
        async rewrites() {
          return [
            { source: '/api/:path*', destination: `${REMOTE_API}/api/:path*` },
            { source: '/files/:path*', destination: `${REMOTE_API}/files/:path*` },
          ];
        },
      }
    : {}),
};

export default nextConfig;
