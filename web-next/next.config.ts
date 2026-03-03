import type { NextConfig } from 'next';
import { resolve } from 'path';

// Set NEXT_PUBLIC_BASE_PATH when deploying behind a URL prefix (e.g. "/hub").
// Leave empty when serving from root.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';

const nextConfig: NextConfig = {
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  outputFileTracingRoot: resolve(import.meta.dirname),
  ...(basePath ? { basePath } : {}),
};

export default nextConfig;
