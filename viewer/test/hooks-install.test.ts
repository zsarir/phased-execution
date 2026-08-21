/**
 * The session-presence hook installer — merge, never clobber.
 *
 * The file it edits is the operator's `~/.claude/settings.json`: every key that
 * is not ours survives byte-for-byte (its order, its indentation, its line
 * ending), a second install changes nothing, uninstall gives back what was
 * there, an entry pointing at another checkout is refreshed rather than
 * duplicated, and a file that does not parse is refused. Everything runs
 * against a temp directory — no real `~/.claude` is touched.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  HOOK_EVENTS, HOOK_TIMEOUT_SECONDS, defaultSettingsPath, hookCommand, hooksStatus, installHooks, uninstallHooks,
} = await import('../server/hooks-install.ts');

const SKILL = '/opt/skills/phased-execution';
const OTHER = '/home/someone/.claude-b/skills/phased-execution';

function scratch(): { dir: string; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'pc-hooks-'));
  return { dir, path: join(dir, 'settings.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A settings file like a real operator's: unrelated keys, other tools' hooks, 2-space indent. */
const EXISTING = `{
  "model": "opus",
  "permissions": {
    "allow": ["Bash(git status)"],
    "deny": []
  },
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/home/me/.claude/skills/other/bin/other-session-update"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/home/me/.claude/hooks/notify.sh \\"Claude finished\\" \\"Glass\\""
          }
        ]
      }
    ],
    "Notification": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/home/me/.claude/hooks/notify.sh \\"Attention\\" \\"Ping\\""
          }
        ]
      }
    ]
  },
  "enabledPlugins": {
    "phased-execution@local": true
  }
}
`;

test('a fresh install creates the file with exactly the three entries, 2-space indent, trailing newline', () => {
  const { path, cleanup } = scratch();
  try {
    const status0 = hooksStatus({ settingsPath: path, skillDir: SKILL });
    assert.equal(status0.exists, false);
    assert.equal(status0.installed, false);
    const out = installHooks({ settingsPath: path, skillDir: SKILL });
    assert.equal(out.changed, true);
    assert.equal(out.status.installed, true);
    const raw = readFileSync(path, 'utf8');
    assert.ok(raw.endsWith('\n'));
    const json = JSON.parse(raw) as { hooks: Record<string, { hooks: { type: string; command: string; timeout: number }[] }[]> };
    assert.deepEqual(Object.keys(json), ['hooks']);
    assert.deepEqual(Object.keys(json.hooks), [...HOOK_EVENTS]);
    for (const event of HOOK_EVENTS) {
      assert.equal(json.hooks[event].length, 1);
      assert.deepEqual(json.hooks[event][0], {
        hooks: [{ type: 'command', command: `bash "${SKILL}/scripts/session-hook.sh"`, timeout: HOOK_TIMEOUT_SECONDS }],
      });
    }
    assert.equal(hookCommand(SKILL), `bash "${SKILL}/scripts/session-hook.sh"`);
    assert.match(raw, /^ {2}"hooks": \{/m);
  } finally { cleanup(); }
});

test('an existing file keeps every unrelated key, every other tool\'s hook and their order; uninstall restores the bytes', () => {
  const { path, cleanup } = scratch();
  try {
    writeFileSync(path, EXISTING, 'utf8');
    const before = JSON.parse(EXISTING) as Record<string, unknown>;
    const out = installHooks({ settingsPath: path, skillDir: SKILL });
    assert.equal(out.changed, true);
    assert.equal(out.status.installed, true);
    const after = JSON.parse(readFileSync(path, 'utf8')) as typeof before & { hooks: Record<string, unknown[]> };
    // Unrelated keys: identical, same order.
    assert.deepEqual(Object.keys(after), Object.keys(before));
    for (const key of Object.keys(before)) if (key !== 'hooks') assert.deepEqual(after[key], before[key]);
    // Other tools' hook groups: identical, first, untouched; ours appended.
    const beforeHooks = before.hooks as Record<string, unknown[]>;
    assert.deepEqual(after.hooks.SessionStart[0], beforeHooks.SessionStart[0]);
    assert.deepEqual(after.hooks.Stop[0], beforeHooks.Stop[0]);
    assert.deepEqual(after.hooks.Notification, beforeHooks.Notification);
    assert.equal(after.hooks.SessionStart.length, 2);
    assert.equal(after.hooks.Stop.length, 2);
    assert.equal(after.hooks.SessionEnd.length, 1);
    // Event order: the file's own events first, the new one after.
    assert.deepEqual(Object.keys(after.hooks), ['SessionStart', 'Stop', 'Notification', 'SessionEnd']);
    // Uninstall: byte-identical to what was there.
    const back = uninstallHooks({ settingsPath: path, skillDir: SKILL });
    assert.equal(back.changed, true);
    assert.equal(readFileSync(path, 'utf8'), EXISTING);
    assert.equal(back.status.installed, false);
    assert.equal(back.status.partial, false);
  } finally { cleanup(); }
});

test('install is idempotent: the second run writes nothing and the bytes are unchanged', () => {
  const { path, cleanup } = scratch();
  try {
    writeFileSync(path, EXISTING, 'utf8');
    installHooks({ settingsPath: path, skillDir: SKILL });
    const once = readFileSync(path, 'utf8');
    const mtime = statSync(path).mtimeMs;
    const again = installHooks({ settingsPath: path, skillDir: SKILL });
    assert.equal(again.changed, false);
    assert.equal(readFileSync(path, 'utf8'), once);
    assert.equal(statSync(path).mtimeMs, mtime);
  } finally { cleanup(); }
});

test('an entry pointing at another checkout reads stale and is refreshed in place, never duplicated', () => {
  const { path, cleanup } = scratch();
  try {
    installHooks({ settingsPath: path, skillDir: OTHER });
    const stale = hooksStatus({ settingsPath: path, skillDir: SKILL });
    assert.equal(stale.installed, false);
    assert.equal(stale.stale, true);
    assert.equal(stale.partial, true);
    assert.deepEqual(stale.events, { SessionStart: true, SessionEnd: true, Stop: true });
    const out = installHooks({ settingsPath: path, skillDir: SKILL });
    assert.equal(out.changed, true);
    assert.equal(out.status.installed, true);
    assert.equal(out.status.stale, false);
    const json = JSON.parse(readFileSync(path, 'utf8')) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    for (const event of HOOK_EVENTS) {
      assert.equal(json.hooks[event].length, 1, `${event}: one group, not two`);
      assert.equal(json.hooks[event][0].hooks[0].command, hookCommand(SKILL));
    }
  } finally { cleanup(); }
});

test('a partial install (one event missing) reads partial and install completes it', () => {
  const { path, cleanup } = scratch();
  try {
    writeFileSync(path, JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: hookCommand(SKILL), timeout: 3 }] }] },
    }, null, 2) + '\n', 'utf8');
    const status = hooksStatus({ settingsPath: path, skillDir: SKILL });
    assert.equal(status.installed, false);
    assert.equal(status.partial, true);
    assert.deepEqual(status.events, { SessionStart: true, SessionEnd: false, Stop: false });
    const out = installHooks({ settingsPath: path, skillDir: SKILL });
    assert.equal(out.status.installed, true);
  } finally { cleanup(); }
});

test('the file\'s own indentation (tabs, 4 spaces) and CRLF line endings are kept', () => {
  const { path, cleanup } = scratch();
  try {
    writeFileSync(path, '{\n\t"model": "opus",\n\t"permissions": {\n\t\t"allow": []\n\t}\n}\n', 'utf8');
    installHooks({ settingsPath: path, skillDir: SKILL });
    const tabbed = readFileSync(path, 'utf8');
    assert.match(tabbed, /^\t"model": "opus",\n/m);
    assert.match(tabbed, /^\t"hooks": \{\n\t\t"SessionStart"/m);
    uninstallHooks({ settingsPath: path, skillDir: SKILL });
    assert.equal(readFileSync(path, 'utf8'), '{\n\t"model": "opus",\n\t"permissions": {\n\t\t"allow": []\n\t}\n}\n');

    writeFileSync(path, '{\r\n    "model": "opus"\r\n}\r\n', 'utf8');
    installHooks({ settingsPath: path, skillDir: SKILL });
    const crlf = readFileSync(path, 'utf8');
    assert.ok(crlf.includes('\r\n    "hooks": {\r\n        "SessionStart"'));
    assert.ok(!/[^\r]\n/.test(crlf), 'no bare LF');
    uninstallHooks({ settingsPath: path, skillDir: SKILL });
    assert.equal(readFileSync(path, 'utf8'), '{\r\n    "model": "opus"\r\n}\r\n');
  } finally { cleanup(); }
});

test('a settings file that does not parse is refused untouched, by install and by uninstall', () => {
  const { path, cleanup } = scratch();
  try {
    writeFileSync(path, '{ "model": "opus", ', 'utf8');
    const status = hooksStatus({ settingsPath: path, skillDir: SKILL });
    assert.equal(status.installed, false);
    assert.ok(status.parseError);
    assert.throws(() => installHooks({ settingsPath: path, skillDir: SKILL }), /does not parse/);
    assert.throws(() => uninstallHooks({ settingsPath: path, skillDir: SKILL }), /does not parse/);
    assert.equal(readFileSync(path, 'utf8'), '{ "model": "opus", ');
    assert.ok(!existsSync(`${path}.tmp.${process.pid}`));
  } finally { cleanup(); }
});

test('uninstall on a file that never had our entries (or does not exist) changes nothing', () => {
  const { path, dir, cleanup } = scratch();
  try {
    const none = uninstallHooks({ settingsPath: path, skillDir: SKILL });
    assert.equal(none.changed, false);
    assert.ok(!existsSync(path));
    writeFileSync(path, EXISTING, 'utf8');
    const out = uninstallHooks({ settingsPath: path, skillDir: SKILL });
    assert.equal(out.changed, false);
    assert.equal(readFileSync(path, 'utf8'), EXISTING);
    // And the default path follows CLAUDE_CONFIG_DIR like the CLI does.
    const conf = join(dir, 'conf'); mkdirSync(conf);
    assert.equal(defaultSettingsPath({ CLAUDE_CONFIG_DIR: conf }), join(conf, 'settings.json'));
  } finally { cleanup(); }
});
