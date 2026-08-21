/**
 * The barrel over the domain modules — what `@/lib/api` (through `../api.ts`)
 * resolves to.
 *
 * Every type and fetcher the one-file `lib/api.ts` used to export comes through
 * here under the same name, and `api` is the one object every view already
 * calls (`api.plan(…)`, `api.runStart(…)`), merged from one `<domain>Api`
 * object per module. A key lives in exactly one domain: a spread lets the last
 * module win silently, so keep the domain objects disjoint.
 */

import { stateApi } from './state';
import { plansApi } from './plans';
import { runsApi } from './runs';
import { sessionsApi } from './sessions';
import { accountsApi } from './accounts';
import { mcpApi } from './mcp';
import { notificationsApi } from './notifications';
import { policyApi } from './policy';
import { systemApi } from './system';
import { inboxApi } from './inbox';
import { spendApi } from './spend';

export * from './client';
export * from './state';
export * from './plans';
export * from './runs';
export * from './sessions';
export * from './accounts';
export * from './mcp';
export * from './notifications';
export * from './policy';
export * from './system';
export * from './inbox';
export * from './spend';

export const api = {
  ...stateApi,
  ...plansApi,
  ...runsApi,
  ...sessionsApi,
  ...accountsApi,
  ...mcpApi,
  ...notificationsApi,
  ...policyApi,
  ...systemApi,
  ...inboxApi,
  ...spendApi,
};
