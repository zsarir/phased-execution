/**
 * The one-click desktop launcher: the artifact per platform, with nobody's
 * machine layout in the template and everybody's in their own copy.
 *
 * What must hold: the repo template keeps its placeholder ROOT (a public file
 * carries no one's layout); a written copy carries THIS console's root as
 * `$HOME/…` and its port, with all five capability switches on; the Linux
 * artifact is a valid XDG entry whose Exec is absolute (Exec expands no env
 * vars); win32 is refused with the WSL story rather than a shortcut that
 * breaks; and both artifacts come out executable, because GNOME will not even
 * offer "Allow Launching" without the bit.
 */

// Redirects XDG_STATE_HOME/XDG_CONFIG_HOME before anything resolves them.
import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FULL_FLAGS, installDesktopLauncher, launcherPlan, renderCommandFile, renderDesktopEntry,
} from '../server/launcher.ts';

const TEMPLATE = readFileSync(
  fileURLToPath(new URL('../deploy/desktop-launcher.command', import.meta.url)),
  'utf8',
);

test('the shipped template carries a placeholder, never a machine layout', () => {
  assert.match(TEMPLATE, /^ROOT="\$HOME\/code\/your-repo"$/m);
  assert.equal(TEMPLATE.match(/^ROOT=/mg)?.length, 1, 'exactly one ROOT line — the placeholder');
  // Split so this file passes the same scrub it is enforcing.
  assert.ok(!TEMPLATE.includes('/Use' + 'rs/'), 'no absolute home path in the public file');
});

test('a written copy bakes in the root as $HOME-relative, the port, and every switch', () => {
  const patched = renderCommandFile(TEMPLATE, {
    root: '/home/someone/code/my-repo', port: 4199, home: '/home/someone',
  });
  assert.match(patched, /^ROOT="\$HOME\/code\/my-repo"$/m, 'the username never lands in the file');
  assert.match(patched, /^PORT=4199$/m);
  for (const knob of ['WRITES="--allow-writes"', 'RUNS="--allow-run"', 'TERM_FLAG="--allow-terminal"',
    'AGENT="--allow-agent"', 'ACCOUNTS="--allow-accounts"']) {
    assert.ok(patched.includes(knob), knob);
  }
  assert.match(patched, /^LAUNCHER_REV=\d+$/m, 'the staleness check survives the patch');
  // A plain console leaves the rev-7 knobs empty — the copy composes exactly
  // the line a rev-6 one did, so nothing churns for the common case.
  assert.match(patched, /^REMOTE=""$/m);
  assert.match(patched, /^REMOTE_USERS=""$/m);
  assert.match(patched, /^MAX_SESSIONS=""$/m);
  assert.match(patched, /^DEFAULT_SKILLS=""$/m);

  // A root OUTSIDE home stays absolute — $HOME-relative would point at the
  // wrong disk on the very machine it was written for.
  const elsewhere = renderCommandFile(TEMPLATE, { root: '/srv/repo', port: 4123, home: '/home/someone' });
  assert.match(elsewhere, /^ROOT="\/srv\/repo"$/m);
});

test('PIN: the template is at LAUNCHER_REV 7 — bump it whenever the argv changes', () => {
  // The rev is what tells an installed copy it is stale. Adding a knob or a
  // flag without bumping this leaves every Desktop copy silently behind.
  assert.match(TEMPLATE, /^LAUNCHER_REV=7$/m);
});

test('the rev-7 knobs bake this console\'s remote, session and skills settings', () => {
  const patched = renderCommandFile(TEMPLATE, {
    root: '/home/someone/code/my-repo', port: 4199, home: '/home/someone',
    remoteHosts: ['console.tail1234.ts.net'], remoteUsers: ['op@github'],
    maxSessions: 5, defaultSkills: ['qa', 'design-review'],
  });
  assert.match(patched, /^REMOTE="console\.tail1234\.ts\.net"$/m);
  assert.match(patched, /^REMOTE_USERS="op@github"$/m);
  assert.match(patched, /^MAX_SESSIONS="5"$/m);
  assert.match(patched, /^DEFAULT_SKILLS="qa,design-review"$/m);

  // The default ceiling is not pinned: the console's own default keeps ruling,
  // including a future one.
  const plain = renderCommandFile(TEMPLATE, {
    root: '/home/someone/code/my-repo', port: 4199, home: '/home/someone', maxSessions: 3,
  });
  assert.match(plain, /^MAX_SESSIONS=""$/m);
});

test('a template without the rev-7 knobs is refused rather than silently dropping them', () => {
  const old = TEMPLATE.replace(/^REMOTE=.*\n/m, '');
  assert.throws(
    () => renderCommandFile(old, { root: '/r', port: 1, home: '/h' }),
    /REMOTE knob/,
  );
});

test('a template with no LAUNCHER_REV is refused rather than copied blind', () => {
  assert.throws(
    () => renderCommandFile('ROOT=x\nPORT=1\n', { root: '/r', port: 1, home: '/h' }),
    /LAUNCHER_REV/,
  );
});

test('the Linux entry is a terminal XDG launcher with absolute paths and the full flag set', () => {
  const entry = renderDesktopEntry({ skillDir: '/opt/phased-execution', root: '/home/dev/repo', port: 4123 });
  assert.match(entry, /^\[Desktop Entry\]$/m);
  assert.match(entry, /^Terminal=true$/m, 'the console is a terminal program');
  assert.match(entry, /^Exec=bash -lc "/m);
  assert.ok(!entry.includes('$HOME'), 'Exec expands no env vars — paths must be absolute');
  assert.ok(entry.includes('/opt/phased-execution/start'));
  assert.ok(entry.includes('/home/dev/repo'));
  for (const flag of FULL_FLAGS) assert.ok(entry.includes(flag), flag);
});

test('the Linux entry carries the extras and names its instance', () => {
  const entry = renderDesktopEntry({
    skillDir: '/opt/pe', root: '/srv/repo', port: 4125,
    remoteHosts: ['console.tail1234.ts.net'], remoteUsers: ['op@github'],
    maxSessions: 5, defaultSkills: ['qa'],
    instanceName: 'hub', isDefault: false,
  });
  assert.ok(entry.includes('--remote console.tail1234.ts.net'));
  assert.ok(entry.includes('--remote-user op@github'));
  assert.ok(entry.includes('--max-sessions 5'));
  assert.ok(entry.includes('--default-skills qa'));
  // Two projects must not put two identically-labelled icons on one desktop.
  assert.match(entry, /^Name=Phase Console — hub$/m);

  const plain = renderDesktopEntry({ skillDir: '/opt/pe', root: '/srv/repo', port: 4123 });
  assert.match(plain, /^Name=Phase Console$/m);
  assert.ok(!plain.includes('--remote '), 'a plain console composes the plain line');
  assert.ok(!plain.includes('--max-sessions'));
});

test('the plan per platform: mac gets a .command, linux a .desktop, windows the WSL story', () => {
  const mac = launcherPlan({ platform: 'darwin', home: '/home/a' });
  assert.equal(mac.supported, true);
  assert.equal(mac.kind, 'command');
  assert.equal(mac.path, '/home/a/Desktop/Phase Console.command');

  const linux = launcherPlan({ platform: 'linux', home: '/home/a' });
  assert.equal(linux.supported, true);
  assert.equal(linux.kind, 'desktop-entry');
  assert.match(linux.note, /Allow Launching/);

  const win = launcherPlan({ platform: 'win32', home: 'C:/home/a' });
  assert.equal(win.supported, false);
  assert.match(win.note, /WSL/);

  // A second project's launcher must not overwrite the default one's.
  const second = launcherPlan({ platform: 'darwin', home: '/home/a', isDefault: false, instanceName: 'hub' });
  assert.equal(second.path, '/home/a/Desktop/Phase Console — hub.command');
});

test('installing writes an EXECUTABLE artifact into the given home, per platform', () => {
  const home = mkdtempSync(join(tmpdir(), 'pc-launcher-'));
  try {
    const mac = installDesktopLauncher({
      root: join(home, 'code', 'repo'), port: 4123, home, platform: 'darwin', source: TEMPLATE,
    });
    assert.equal(statSync(mac.path).mode & 0o111, 0o111, 'a .command without +x is a text file');
    assert.match(readFileSync(mac.path, 'utf8'), /^ROOT="\$HOME\/code\/repo"$/m);

    const linux = installDesktopLauncher({
      root: '/srv/repo', port: 4124, home, platform: 'linux', skillDir: '/opt/pe',
    });
    assert.equal(statSync(linux.path).mode & 0o111, 0o111, 'GNOME offers Allow Launching only with the bit');
    assert.match(readFileSync(linux.path, 'utf8'), /--allow-accounts/);

    assert.throws(
      () => installDesktopLauncher({ root: '/r', port: 1, home, platform: 'win32' }),
      /WSL/,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
