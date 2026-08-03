import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The Vite project lives in `client/`; its build output goes to `client/dist`,
// which the server serves in preference to the legacy `web/` client (see
// `server/index.ts` webRoot()). One npm package, one lockfile — the server stays
// zero-dependency plain Node; only the client is built.
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// The real server. In dev, the React app runs on :5173 and proxies API + SSE to
// the console on :4123. The console's CSRF guard requires a same-origin Origin on
// every non-GET (Origin.host === Host); a browser POST from :5173 would fail that,
// so the proxy rewrites BOTH: changeOrigin sets Host to the target, and the hook
// below sets Origin to match. `changeOrigin` alone is not enough.
const CONSOLE = 'http://127.0.0.1:4123';
const rewriteOrigin = (proxy: { on: (e: string, cb: (r: { setHeader: (k: string, v: string) => void }) => void) => void }) => {
  proxy.on('proxyReq', (proxyReq) => proxyReq.setHeader('origin', CONSOLE));
};

export default defineConfig({
  root: here('client'),
  // Never widen the bind — the whole security model assumes loopback; remote
  // access is tailscale in front of 127.0.0.1, never `--host 0.0.0.0`.
  server: {
    host: '127.0.0.1',
    port: 5173,
    // shared/ lives outside the client root; allow Vite to serve it in dev.
    fs: { allow: [here('.')] },
    proxy: {
      '/api': { target: CONSOLE, changeOrigin: true, configure: rewriteOrigin },
      '/hooks': { target: CONSOLE, changeOrigin: true, configure: rewriteOrigin },
      // SSE + the service worker are GETs — no CSRF, no Origin rewrite needed.
      '/events': { target: CONSOLE, changeOrigin: true },
      '/sw.js': { target: CONSOLE, changeOrigin: true },
    },
  },
  plugins: [react()],
  resolve: {
    alias: {
      '@': here('client/src'),
      // The Node-importable SSOT modules (routes, route-meta, console-model,
      // phase-model). Same files `node --test` imports — one source of truth.
      '@shared': here('shared'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
