import DashboardView from '@/views/dashboard';

/**
 * **Now** — the home page, v1.
 *
 * Six destinations replaced thirteen nav entries, and Now is the one that
 * answers *does anything need me?* For this phase its body is the 2.x
 * dashboard, unchanged, rendered inside the new shell: the route, the default
 * head, the aliases (`#/`, `#/dashboard`) and the tab-bar slot are all real and
 * testable now, and Phase 8 replaces what is inside without touching any of it.
 *
 * That split is deliberate. Building the shell and the home page in one phase
 * would mean nothing could be verified until both were finished; building the
 * shell against a page that already works means every route, every overlay and
 * every deep link in the plan's exit criteria is provable today.
 *
 * Phase 8 replaces this file with the needs-you inbox, the live lanes with
 * heartbeat/cost/ETA, next up, and plans in flight — and deletes
 * `views/dashboard/`, `views/ready/`, `views/pulse/` and the notifications inbox
 * with it.
 */
export default function NowView() {
  return <DashboardView />;
}
