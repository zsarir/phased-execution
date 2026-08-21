/**
 * Compatibility barrel over `./api/*`.
 *
 * This used to be one ~2100-line file. It is now the domain modules under
 * `./api/` — `client` (transport), `state`, `plans`, `runs`, `sessions`,
 * `accounts`, `mcp`, `notifications`, `policy`, `system`, `inbox`, `spend` —
 * and this file is kept so `@/lib/api` across the client and `./api` inside
 * `lib/` keep resolving with zero changes: every exported name and the single
 * `api` object come through unchanged from `./api/index`.
 */
export * from './api/index';
