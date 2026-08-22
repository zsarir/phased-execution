/**
 * The guide's PROSE — eleven markdown files, imported with Vite's `?raw`.
 *
 * Its own module so that `sections.ts` (which the help sheet's tab strip needs
 * on every page, because the sheet is mounted in the composition root) carries
 * only the metadata. The text itself is ~40 KB of string that nobody reads
 * until they open the guide, and it used to ride in the entry chunk.
 *
 * Imported only by `section.tsx`, which is itself behind the sheet's `lazy()`.
 */

import concepts from '@/content/guide/concepts.md?raw';
import running from '@/content/guide/running.md?raw';
import run from '@/content/guide/run.md?raw';
import autopilot from '@/content/guide/autopilot.md?raw';
import sessions from '@/content/guide/sessions.md?raw';
import notifications from '@/content/guide/notifications.md?raw';
import permissions from '@/content/guide/permissions.md?raw';
import mcp from '@/content/guide/mcp.md?raw';
import mobile from '@/content/guide/mobile.md?raw';
import troubleshooting from '@/content/guide/troubleshooting.md?raw';
import reference from '@/content/guide/reference.md?raw';

/** Section id → its markdown body. Keyed by the same ids `sections.ts` declares. */
export const BODIES: Readonly<Record<string, string>> = Object.freeze({
  concepts,
  running,
  run,
  autopilot,
  sessions,
  notifications,
  permissions,
  mcp,
  mobile,
  troubleshooting,
  reference,
});
