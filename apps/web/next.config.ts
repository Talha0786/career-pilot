import type { NextConfig } from 'next';

// Dev-time single-origin proxy (M2 design §7 — "documented dev proxy
// config"). Prod is single-origin behind Caddy (task 013); this is the
// local-dev equivalent so the session cookie's SameSite=Lax never has to
// cross an actual origin boundary during `next dev`.
const API_ORIGIN = process.env.API_ORIGIN ?? 'http://localhost:8080';

const nextConfig: NextConfig = {
  // Self-contained server bundle with only the node_modules it actually
  // traces as used — the production Dockerfile copies just this output,
  // not the whole monorepo's node_modules (task 013).
  output: 'standalone',
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${API_ORIGIN}/:path*` },
      { source: '/ws', destination: `${API_ORIGIN}/ws` },
    ];
  },
  // Workspace packages (e.g. @careerpilot/contracts) use NodeNext-style
  // explicit ".js" import specifiers that actually resolve to ".ts" source
  // (tsc/tsx handle this natively; webpack doesn't by default) — this
  // teaches webpack the same resolution tsx already does.
  webpack(config) {
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
};

export default nextConfig;
