/**
 * Claude accounts — the registry (always redacted), the usage meters, sign-in,
 * and the mid-run switch.
 */

import { request, post, q } from './client';
import type { RunState } from './runs';

/* ---------------- Claude accounts ---------------- */

export interface UsageBucket {
  /** Percent, 0–100. */
  utilization: number;
  /** ISO 8601. */
  resetsAt: string;
}

export interface AccountUsage {
  /** Keyed by the endpoint's own names — `five_hour`, `seven_day`, `seven_day_opus`, … */
  buckets: Record<string, UsageBucket>;
  fetchedAt: string;
  /** The endpoint will never serve this credential kind — "no usage data", not an error. */
  unsupported?: boolean;
  error?: string;
}

/** One registered Claude identity, redacted: never a token, never a path. */
export interface AccountView {
  id: string;
  kind: 'default' | 'profile' | 'token';
  /** The machine's own login — always present, never removable. */
  builtIn: boolean;
  name?: string;
  email?: string;
  org?: string;
  plan?: string;
  /** Profiles only: whether `claude auth login` has completed in it. */
  signedIn?: boolean;
  /** Where the login stands. `unknown` is a setup-token's honest answer. */
  authState?: 'ok' | 'expiring' | 'expired' | 'signed-out' | 'unknown';
  usage?: AccountUsage;
  /** Windows learned exhausted the hard way — bucket → ISO reset time. */
  limitedUntil?: Record<string, string>;
}

export interface AccountsState {
  accounts: AccountView[];
  allowAccounts: boolean;
}

export interface AccountLoginStart {
  accountId: string;
  /** The exact command, for the operator to run themselves when nothing opened. */
  command: string;
  /** `embedded` = a pty on the Agent page; `external` = Terminal.app opened; `command` = copy-paste. */
  mode: 'embedded' | 'external' | 'command';
  terminal?: { sessionId: string; token: string; expiresAt: number };
  detail?: string;
}

/** The account fetchers — merged into `api` by `./index`. */
export const accountsApi = {
  /* ---- Claude accounts ---- */
  accounts: () => request<AccountsState>('/api/accounts'),
  accountAdd: (name: string, token: string) =>
    post<{ account: AccountView }>('/api/accounts', { name, token }),
  accountDelete: (id: string) =>
    request<{ removed: boolean }>(`/api/accounts/${q(id)}`, { method: 'DELETE' }),
  /** Display-name only — the id (journal key, path segment) never changes. */
  accountRename: (id: string, name: string) =>
    request<{ account: AccountView }>(`/api/accounts/${q(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
  accountLogin: (body: { accountId?: string; name?: string } = {}) =>
    post<AccountLoginStart>('/api/accounts/login', body),
  /** Acts NOW: a live session is checkpointed and re-attempted under the account. */
  runSwitchAccount: (slug: string, accountId: string) =>
    post<{ ok: boolean; reason?: string; run?: RunState | null }>(`/api/run/${q(slug)}/switch-account`, {
      accountId,
    }),
  /** "I signed in over there — look again." Re-reads one account's identity. */
  accountRefresh: (accountId?: string) =>
    post<{ account: AccountView }>('/api/accounts/refresh', { accountId }),
};
