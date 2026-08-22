/**
 * The sweep guard — the assertions that keep the 3.0 rebuild from growing its
 * predecessor back.
 *
 * Phases 6–11 moved every page out of `views/` into a `features/<destination>/`
 * module, and the last of them deleted the directory. None of that is
 * expressible as a type: nothing stops a future surface from adding
 * `views/thing.tsx` back, or from re-importing the adapter that let a 2.x view
 * render under the new shell. Both would work, and both would quietly restore
 * the two-worlds arrangement the rebuild existed to end.
 *
 * So the guard is a source walk, in the same shape (and for the same reasons)
 * as `features/run-setup/single-source.test.ts`. When one fails, the fix is to
 * put the file where it belongs — never to widen the list.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
/** This file sits AT the root of the tree it guards. */
const SRC = HERE;

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      sources(path, out);
      continue;
    }
    if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) continue;
    out.push(path);
  }
  return out;
}

const decommented = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const FILES = sources(SRC).map((path) => ({
  path: relative(SRC, path),
  text: decommented(readFileSync(path, 'utf8')),
}));

function offenders(pattern: RegExp, allowed: readonly string[] = []): string[] {
  return FILES.filter(({ path, text }) => pattern.test(text) && !allowed.includes(path)).map(
    ({ path }) => path,
  );
}

describe('the 3.0 sweep', () => {
  it('has no src/views directory at all', () => {
    // Not "is empty" — absent. An empty directory is an invitation, and the
    // last three files in it (settings, mcp, notifications) each arrived
    // because the one before it was still there.
    expect(existsSync(join(SRC, 'views'))).toBe(false);
  });

  it('has no file importing from @/views or ./views', () => {
    expect(offenders(/from '(@\/views|\.\.?\/+views)/)).toEqual([]);
  });

  it('has no legacy-route adapter left', () => {
    // It was the boundary that let a 2.x view render under the 3.0 shell. The
    // Suspense boundary it carried is permanent and lives on as
    // `app/shell/route-frame.tsx`; the adapter it was named for is not.
    expect(existsSync(join(SRC, 'app', 'legacy-route.tsx'))).toBe(false);
    expect(offenders(/\bLegacyRoute\b/)).toEqual([]);
  });

  it('imports the router from @/app/router, never a bare @/router', () => {
    // `@/router` was the 2.x path. It resolves to nothing now, but a stale
    // import in a lazily-loaded chunk is a runtime failure on ONE route, which
    // is exactly the kind that ships.
    expect(offenders(/from '@\/router'/)).toEqual([]);
  });

  it('gives every destination a features/ module of its own', () => {
    for (const destination of ['now', 'plans', 'runs', 'sessions', 'insights', 'settings']) {
      expect(existsSync(join(SRC, 'features', destination, 'index.tsx')), destination).toBe(true);
    }
  });
});
