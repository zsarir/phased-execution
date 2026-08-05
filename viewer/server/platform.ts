/**
 * Where this process is actually running, for the few places it matters.
 *
 * WSL looks exactly like Linux to Node — same `process.platform`, same
 * syscalls — until something tries to reach the desktop: there is no display,
 * `xdg-open` is usually absent, and the browser lives on the Windows side.
 * The one reliable tell is the kernel identifying itself as Microsoft's.
 */

import { readFileSync } from 'node:fs';

let wsl: boolean | null = null;

export function isWSL(): boolean {
  if (wsl == null) {
    try {
      wsl = process.platform === 'linux'
        && /microsoft/i.test(readFileSync('/proc/version', 'utf8'));
    } catch {
      wsl = false;
    }
  }
  return wsl;
}

/** Test seam: forget the cached answer. */
export function resetWSLCache(): void {
  wsl = null;
}

/**
 * Commands that can hand a URL or file to whatever desktop is nearby, best
 * first. On WSL that desktop is Windows: `wslview` (ships with Ubuntu's WSL
 * images) translates and forwards; `xdg-open` stays as the fallback for a WSL
 * distro that actually runs a Linux desktop. An empty list means "print the
 * URL and let the person click it" — never an error.
 */
export function openerCandidates(): string[] {
  if (process.platform === 'darwin') return ['open'];
  if (isWSL()) return ['wslview', 'xdg-open', 'explorer.exe'];
  if (process.platform === 'linux') return ['xdg-open'];
  return [];
}
