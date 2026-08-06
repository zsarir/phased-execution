/**
 * Injected by Vite (`define` in vite.config.ts): the commit this client was
 * built from, computed by `scripts/build-rev.mjs` — the same function that
 * stamps `dist/.build-rev`, so the Settings Interface row compares like with
 * like. `"unknown"` on a tarball build; never absent in app code (dev and
 * vitest define it too).
 */
declare const __BUILD_REV__: string;
