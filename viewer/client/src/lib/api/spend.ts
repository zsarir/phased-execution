/**
 * Spend — `GET /api/spend` lands in Phase 4 (server A); this is the agreed
 * shape so the client can be built against it. Nothing calls it yet.
 *
 * `today` is the day cap's view (settled runs plus what the ladder spent,
 * against `ladderPerDayUsd` — `null` when no cap is set); `runs` is each run
 * against its own budget; `series` is the per-day history a chart draws.
 */

import { request } from './client';

export type SpendView = {
  today: { settledUsd: number; ladderUsd: number; capUsd: number | null };
  runs: { runId: string; slug: string; spentUsd: number; budgetUsd: number | null }[];
  series: { day: string; settledUsd: number; ladderUsd: number }[];
};

/** The spend fetcher — merged into `api` by `./index`. Nothing calls it yet. */
export const spendApi = {
  spend: () => request<SpendView>('/api/spend'),
};
