import { fileURLToPath, URL } from 'node:url';
// `vitest/config` re-exports Vite's own defineConfig and widens it with the
// `test` block below — one config file, so the client tests resolve `@shared`
// and `@` exactly the way the app does.
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

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
// Overridable so a session can develop against a scratch console on another
// port — driving a real autopilot run needs `--allow-run` against a throwaway
// repo, and pointing the dev server at the operator's live console to do that
// would start a run in their working tree.
const CONSOLE = process.env.PHASE_CONSOLE_ORIGIN ?? 'http://127.0.0.1:4123';
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
      // The terminal socket. `ws: true` is what makes Vite proxy the upgrade
      // rather than answer it; without it the handshake 404s in dev only, which
      // reads as a broken server. No Origin rewrite: the console deliberately
      // does not consult Origin on an upgrade (CORS does not apply to one), so
      // there is nothing to satisfy — the ticket is the credential.
      '/ws': { target: CONSOLE, ws: true, changeOrigin: true },
    },
  },
  plugins: [react(), tailwindcss()],
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
  test: {
    // Relative to `root` (= `client/`), so this is `client/src/**`. The
    // server's own suite lives at `viewer/test/*.test.ts`, outside that root,
    // and must never be swept up here: it runs under `node --test`, imports
    // node: builtins and expects no DOM.
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    globals: true,
    setupFiles: [here('client/src/test-setup.ts')],
    css: false,
  },
});
