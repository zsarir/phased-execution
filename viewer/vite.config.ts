import { fileURLToPath, URL } from 'node:url';
// `vitest/config` re-exports Vite's own defineConfig and widens it with the
// `test` block below — one config file, so the client tests resolve `@shared`
// and `@` exactly the way the app does.
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

// The Vite project lives in `client/`; its build output goes to `client/dist`,
// the only client the server serves (see `server/index.ts` webRoot() — until a
// build exists it answers with a page naming the build commands). One npm
// package, one lockfile — the server stays plain Node; only the client is built.
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
      // SSE is a GET — no CSRF, no Origin rewrite needed.
      '/events': { target: CONSOLE, changeOrigin: true },
      // `/sw.js` is deliberately NOT proxied any more. The client owns the
      // service worker now, and forwarding this would hand the dev origin the
      // *production* worker — one that precaches `/assets/index-<hash>.js`
      // URLs which do not exist on :5173, and then answers navigations from
      // that cache. `lib/pwa.ts` skips registration in dev for the same reason.
      // The terminal socket. `ws: true` is what makes Vite proxy the upgrade
      // rather than answer it; without it the handshake 404s in dev only, which
      // reads as a broken server. No Origin rewrite: the console deliberately
      // does not consult Origin on an upgrade (CORS does not apply to one), so
      // there is nothing to satisfy — the ticket is the credential.
      '/ws': { target: CONSOLE, ws: true, changeOrigin: true },
    },
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // `injectManifest`, not `generateSW`: the worker is hand-written
      // (`client/src/sw.ts`) because what it must NOT do — cache the board — is
      // the part worth reading, and a generated one hides that in options.
      strategies: 'injectManifest',
      srcDir: 'src',
      // ⚠️ The output stays `/sw.js` at scope `/`. The push subscriptions that
      // already exist are bound to that pair; moving either silently
      // unsubscribes every device and nothing announces it.
      filename: 'sw.ts',
      // The manifest is a static file in `client/public/` and the <link> is in
      // index.html — both because it predates this build and is already
      // installed on a home screen, and because it reads better as a document
      // than as a config block.
      manifest: false,
      // Registration is `lib/pwa.ts`'s job: it also owns the update toast, and
      // an injected script that registers behind its back would race it.
      injectRegister: null,
      injectManifest: {
        // A classic script, not an ES module. The default (`es`) happens to
        // emit import-free output while everything inlines, so it registers as
        // classic *by luck*; the day something does not inline, module workers
        // are unsupported in Firefox and this would break there and nowhere
        // else. `iife` makes it true on purpose.
        rollupFormat: 'iife',
        // Fonts and icons are part of the shell — the defaults cover only
        // js/css/html, which would leave an offline app in Times New Roman.
        globPatterns: ['**/*.{js,css,html}', 'assets/*.woff2', 'icons/*.png', 'manifest.webmanifest'],
        // The terminal is 89 KB gz of xterm that is useless without a socket,
        // and precaching is exactly the wrong place to spend that: it is
        // downloaded on install, by everyone, before anyone asks for a shell.
        // It stays a lazy chunk fetched from the network on demand.
        //
        // `pane-*` is where xterm actually lives now that TWO routes (terminal
        // and agent) share the pane: the bundler hoists pane+keybar+palette+
        // xterm into one lazy chunk named after the facade module. The name is
        // gated by scripts/check-dist.mjs, so a bundler that renames it fails
        // the build loudly instead of silently precaching 89 KB.
        //
        // ⚠️ Do NOT reach for rollupOptions manualChunks/advancedChunks to pin
        // a prettier name: measured on this tree (Vite 8 / Rolldown), both
        // forms pulled the captured modules' dependency subtree — React
        // itself — into the named chunk, which made index.html modulepreload
        // xterm for every visitor.
        globIgnores: [
          '**/terminal-*.js', '**/terminal-*.css',
          '**/pane-*.js', '**/pane-*.css',
          '**/agent-*.js', '**/agent-*.css',
        ],
      },
      // No worker in dev. See the `/sw.js` proxy note above.
      devOptions: { enabled: false },
    }),
  ],
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
