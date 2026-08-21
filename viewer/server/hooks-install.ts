/**
 * The session-presence hook installer.
 *
 * `scripts/session-hook.sh` only helps once Claude Code runs it, and Claude
 * Code runs what `~/.claude/settings.json` names under `hooks`. This writes the
 * three entries — SessionStart, SessionEnd, Stop — into that file and takes
 * them out again, from Settings ▸ Automation (behind `--allow-writes`, since
 * it is a write outside the console's own state) and from
 * `phase-console install-hooks` / `uninstall-hooks`.
 *
 * The file is the operator's, not ours, so the rules are the launcher's:
 * **merge, never clobber** — the `hooks` value is the ONLY span of the file
 * that is rewritten; every other byte (every other key, its order, its
 * formatting, the indentation unit, the line ending, the trailing newline) is
 * carried through untouched, and a file that does not parse is refused
 * rather than replaced; **idempotent** — a second install changes nothing,
 * and an entry that points at another checkout of the skill is refreshed in
 * place rather than duplicated; **ours are recognisable** — by the script's
 * name in the command, which is how uninstall finds exactly the entries
 * install wrote and nothing else. Everything filesystem-shaped is a
 * parameter, so tests never touch a real `~/.claude`.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const HOOK_EVENTS = ['SessionStart', 'SessionEnd', 'Stop'] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** The script, relative to the skill root. */
export const HOOK_SCRIPT_REL = 'scripts/session-hook.sh';
/** How an entry of ours is recognised in somebody else's settings file. */
export const HOOK_MARKER = 'session-hook.sh';
/**
 * Seconds. SessionEnd hooks share a 1.5 s budget unless one asks for more,
 * and the script's own network timeout is 2 s — so 3, which is also what it
 * costs a session at most when the console is unreachable.
 */
export const HOOK_TIMEOUT_SECONDS = 3;

type HookCommand = { type: 'command'; command: string; timeout?: number; [key: string]: unknown };
type HookGroup = { matcher?: string; hooks?: HookCommand[]; [key: string]: unknown };
type Settings = Record<string, unknown> & { hooks?: Record<string, HookGroup[] | unknown> };

export type HooksStatus = {
  /** The settings file consulted. */
  path: string;
  exists: boolean;
  /** Every event has an entry of ours pointing at THIS checkout's script. */
  installed: boolean;
  /** Some events have one, some do not — or one points elsewhere. */
  partial: boolean;
  /** Per event: an entry of ours exists (pointing anywhere). */
  events: Record<HookEvent, boolean>;
  /** The command the entries name (or would name). */
  command: string;
  /** An entry of ours points at a script other than this checkout's. */
  stale: boolean;
  /** The file could not be parsed; nothing will be written to it. */
  parseError?: string;
};

export type HooksOptions = {
  /** Absolute path of the skill checkout (where `scripts/session-hook.sh` lives). */
  skillDir: string;
  /** The settings file; defaults to `$CLAUDE_CONFIG_DIR/settings.json`, else `~/.claude/settings.json`. */
  settingsPath?: string;
  env?: NodeJS.ProcessEnv;
};

/** Claude Code's user-scope settings file, honouring `CLAUDE_CONFIG_DIR` the way the CLI does. */
export function defaultSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude');
  return join(dir, 'settings.json');
}

export function hookScriptPath(skillDir: string): string {
  return join(skillDir, HOOK_SCRIPT_REL);
}

/** The command string the entry runs: bash on the absolute script path, quoted for a path with spaces. */
export function hookCommand(skillDir: string): string {
  return `bash "${hookScriptPath(skillDir)}"`;
}

export function hookEntry(skillDir: string): HookCommand {
  return { type: 'command', command: hookCommand(skillDir), timeout: HOOK_TIMEOUT_SECONDS };
}

function isOurs(command: unknown): boolean {
  return typeof command === 'string' && command.includes(HOOK_MARKER);
}

function groupIsOurs(group: unknown): group is HookGroup {
  if (!group || typeof group !== 'object') return false;
  const hooks = (group as HookGroup).hooks;
  return Array.isArray(hooks) && hooks.some((hook) => hook && typeof hook === 'object' && isOurs((hook as HookCommand).command));
}

/* ------------------------------------------------------------------ *
 * Reading, and a scanner that finds the byte span of one top-level key
 * ------------------------------------------------------------------ */

type ReadSettings = {
  exists: boolean;
  raw: string;
  json: Settings;
  /** The indentation unit (the first indented line's leading whitespace). */
  indent: string;
  eol: '\n' | '\r\n';
  trailingNewline: boolean;
  mode?: number;
  parseError?: string;
};

/** Read the file and what it would take to write it back looking the same. */
export function readSettingsFile(path: string): ReadSettings {
  if (!existsSync(path)) return { exists: false, raw: '', json: {}, indent: '  ', eol: '\n', trailingNewline: true };
  const raw = readFileSync(path, 'utf8');
  let mode: number | undefined;
  try { mode = statSync(path).mode & 0o777; } catch { mode = undefined; }
  const eol: '\n' | '\r\n' = raw.includes('\r\n') ? '\r\n' : '\n';
  const indentMatch = /\n([ \t]+)\S/.exec(raw);
  const indent = indentMatch?.[1] ?? '  ';
  const trailingNewline = /\r?\n$/.test(raw) || raw.trim() === '';
  let json: Settings = {};
  let parseError: string | undefined;
  if (raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parseError = 'the settings file is not a JSON object';
      else json = parsed as Settings;
    } catch (error) {
      parseError = (error as Error).message;
    }
  }
  return { exists: true, raw, json, indent, eol, trailingNewline, mode, ...(parseError ? { parseError } : {}) };
}

type TopLevel = {
  open: number;
  close: number;
  entries: { key: string; keyStart: number; valueStart: number; valueEnd: number }[];
};

const WS = new Set([' ', '\t', '\r', '\n']);

function skipWs(raw: string, i: number): number {
  while (i < raw.length && WS.has(raw[i])) i++;
  return i;
}

/** Past a JSON string starting at `i` (the opening quote); -1 when unterminated. */
function skipString(raw: string, i: number): number {
  i++;
  while (i < raw.length) {
    const c = raw[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '"') return i + 1;
    i++;
  }
  return -1;
}

/** Past one JSON value starting at `i`; -1 when it cannot be delimited. */
function skipValue(raw: string, i: number): number {
  const c = raw[i];
  if (c === '"') return skipString(raw, i);
  if (c === '{' || c === '[') {
    let depth = 0;
    while (i < raw.length) {
      const ch = raw[i];
      if (ch === '"') { i = skipString(raw, i); if (i < 0) return -1; continue; }
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') { depth--; if (depth === 0) return i + 1; }
      i++;
    }
    return -1;
  }
  while (i < raw.length && !WS.has(raw[i]) && raw[i] !== ',' && raw[i] !== '}' && raw[i] !== ']') i++;
  return i;
}

/**
 * The top-level object's keys with their byte spans, so one value can be
 * replaced, inserted or removed without touching any other byte. Null when
 * the text is not a plain object this can walk (the caller then re-renders
 * the whole file — correct JSON, merely reformatted).
 */
export function scanTopLevel(raw: string): TopLevel | null {
  let i = skipWs(raw, 0);
  if (raw[i] !== '{') return null;
  const open = i;
  i++;
  const entries: TopLevel['entries'] = [];
  for (;;) {
    i = skipWs(raw, i);
    if (raw[i] === '}') return { open, close: i, entries };
    if (raw[i] !== '"') return null;
    const keyStart = i;
    const keyEnd = skipString(raw, i);
    if (keyEnd < 0) return null;
    let key: string;
    try { key = JSON.parse(raw.slice(keyStart, keyEnd)) as string; } catch { return null; }
    i = skipWs(raw, keyEnd);
    if (raw[i] !== ':') return null;
    i = skipWs(raw, i + 1);
    const valueStart = i;
    const valueEnd = skipValue(raw, i);
    if (valueEnd < 0) return null;
    entries.push({ key, keyStart, valueStart, valueEnd });
    i = skipWs(raw, valueEnd);
    if (raw[i] === ',') { i++; continue; }
    if (raw[i] === '}') return { open, close: i, entries };
    return null;
  }
}

/** `JSON.stringify` at the file's unit, every line after the first prefixed by the key's own indentation. */
function renderValue(value: unknown, unit: string, base: string, eol: string): string {
  return JSON.stringify(value, null, unit).split('\n').map((line, idx) => (idx === 0 ? line : base + line)).join(eol);
}

/** The whitespace run that precedes `at` on its own line. */
function lineIndentBefore(raw: string, at: number): string {
  let i = at;
  while (i > 0 && (raw[i - 1] === ' ' || raw[i - 1] === '\t')) i--;
  return raw.slice(i, at);
}

/**
 * The file's text with its `hooks` value replaced (`value` an object),
 * inserted as the last key when absent, or removed (`value` null) — every
 * other byte unchanged. Falls back to a whole-file render when the text
 * cannot be walked, which a file that JSON.parse accepted practically never is.
 */
export function spliceHooks(file: ReadSettings, value: Record<string, unknown> | null): string {
  const { raw, indent: unit, eol } = file;
  if (!file.exists || !raw.trim()) {
    if (value === null) return raw;
    return `${JSON.stringify({ hooks: value }, null, unit).replace(/\n/g, eol)}${file.trailingNewline ? eol : ''}`;
  }
  const scan = scanTopLevel(raw);
  if (!scan) {
    const json: Settings = { ...file.json };
    if (value === null) delete json.hooks; else json.hooks = value;
    return `${JSON.stringify(json, null, unit).replace(/\n/g, eol)}${file.trailingNewline ? eol : ''}`;
  }
  const idx = scan.entries.findIndex((entry) => entry.key === 'hooks');
  const entry = idx >= 0 ? scan.entries[idx] : null;
  if (value !== null) {
    if (entry) {
      const base = lineIndentBefore(raw, entry.keyStart);
      return raw.slice(0, entry.valueStart) + renderValue(value, unit, base, eol) + raw.slice(entry.valueEnd);
    }
    const rendered = renderValue(value, unit, unit, eol);
    if (!scan.entries.length) {
      return `${raw.slice(0, scan.open + 1)}${eol}${unit}"hooks": ${rendered}${eol}${raw.slice(scan.close)}`;
    }
    const last = scan.entries[scan.entries.length - 1];
    const base = lineIndentBefore(raw, last.keyStart);
    return `${raw.slice(0, last.valueEnd)},${eol}${base}"hooks": ${renderValue(value, unit, base, eol)}${raw.slice(last.valueEnd)}`;
  }
  if (!entry) return raw;
  if (scan.entries.length === 1) return `${raw.slice(0, scan.open + 1)}${raw.slice(scan.close)}`;
  if (idx === scan.entries.length - 1) {
    const prev = scan.entries[idx - 1];
    return raw.slice(0, prev.valueEnd) + raw.slice(entry.valueEnd);
  }
  const next = scan.entries[idx + 1];
  return raw.slice(0, entry.keyStart) + raw.slice(next.keyStart);
}

function writeAtomic(path: string, text: string, mode: number | undefined): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, text, 'utf8');
  if (mode != null) { try { chmodSync(tmp, mode); } catch { /* keep the default */ } }
  renameSync(tmp, path);
}

/* ------------------------------------------------------------------ *
 * Status, install, uninstall
 * ------------------------------------------------------------------ */

function statusOf(file: ReadSettings, path: string, skillDir: string): HooksStatus {
  const command = hookCommand(skillDir);
  const events = {} as Record<HookEvent, boolean>;
  let stale = false;
  let current = 0;
  const hooks = (file.json.hooks && typeof file.json.hooks === 'object' ? file.json.hooks : {}) as Record<string, unknown>;
  for (const event of HOOK_EVENTS) {
    const groups = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    const ours = groups.filter(groupIsOurs);
    events[event] = ours.length > 0;
    const exact = ours.some((group) => (group.hooks ?? []).some((hook) => hook.command === command));
    if (exact) current++;
    else if (ours.length) stale = true;
  }
  const have = HOOK_EVENTS.filter((event) => events[event]).length;
  const installed = current === HOOK_EVENTS.length && !stale;
  return {
    path, exists: file.exists, installed,
    partial: !installed && (have > 0 || stale),
    events, command, stale,
    ...(file.parseError ? { parseError: file.parseError } : {}),
  };
}

/** What is installed, without writing anything. */
export function hooksStatus(options: HooksOptions): HooksStatus {
  const path = options.settingsPath ?? defaultSettingsPath(options.env);
  return statusOf(readSettingsFile(path), path, options.skillDir);
}

export type HooksWrite = { ok: true; path: string; changed: boolean; status: HooksStatus };

function refuseUnparsed(path: string, file: ReadSettings): void {
  if (file.parseError) {
    throw new Error(`${path} does not parse as JSON (${file.parseError}) — fix or move it; nothing was written.`);
  }
}

/**
 * Add (or refresh) the three entries. Every other key and every other hook
 * group is carried through unchanged; an entry of ours that already points at
 * this checkout is left alone, one that points elsewhere is rewritten in place.
 * A file that does not parse is refused — the one thing worse than a missing
 * hook is a settings file the operator has to restore from memory.
 */
export function installHooks(options: HooksOptions): HooksWrite {
  const path = options.settingsPath ?? defaultSettingsPath(options.env);
  const file = readSettingsFile(path);
  refuseUnparsed(path, file);
  const hooks = (file.json.hooks && typeof file.json.hooks === 'object' && !Array.isArray(file.json.hooks)
    ? { ...(file.json.hooks as Record<string, unknown>) }
    : {}) as Record<string, unknown>;
  const wanted = hookEntry(options.skillDir);
  let changed = false;
  for (const event of HOOK_EVENTS) {
    const groups = Array.isArray(hooks[event]) ? [...(hooks[event] as unknown[])] : [];
    let placed = false;
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      if (!groupIsOurs(group)) continue;
      // Refresh in place: the path of this checkout, the timeout we ship.
      const next = {
        ...group,
        hooks: (group.hooks ?? []).map((hook) => (isOurs(hook.command) && !placed
          ? (placed = true, { ...hook, ...wanted })
          : hook)),
      };
      if (JSON.stringify(next) !== JSON.stringify(group)) { groups[i] = next; changed = true; }
    }
    if (!placed) { groups.push({ hooks: [wanted] }); changed = true; }
    hooks[event] = groups;
  }
  if (changed || !file.exists) writeAtomic(path, spliceHooks(file, hooks), file.mode);
  return { ok: true, path, changed: changed || !file.exists, status: statusOf(readSettingsFile(path), path, options.skillDir) };
}

/**
 * Remove every group of ours. An event left with no groups loses its key; a
 * `hooks` object left empty is removed — so install → uninstall on a file that
 * had no hooks gives back the bytes it started with.
 */
export function uninstallHooks(options: HooksOptions): HooksWrite {
  const path = options.settingsPath ?? defaultSettingsPath(options.env);
  const file = readSettingsFile(path);
  if (!file.exists) return { ok: true, path, changed: false, status: statusOf(file, path, options.skillDir) };
  refuseUnparsed(path, file);
  const hooks = (file.json.hooks && typeof file.json.hooks === 'object' && !Array.isArray(file.json.hooks)
    ? { ...(file.json.hooks as Record<string, unknown>) }
    : null);
  let changed = false;
  if (hooks) {
    for (const event of Object.keys(hooks)) {
      const groups = hooks[event];
      if (!Array.isArray(groups)) continue;
      const kept = groups.filter((group) => !groupIsOurs(group));
      if (kept.length !== groups.length) {
        changed = true;
        if (kept.length) hooks[event] = kept; else delete hooks[event];
      }
    }
    if (changed) writeAtomic(path, spliceHooks(file, Object.keys(hooks).length ? hooks : null), file.mode);
  }
  return { ok: true, path, changed, status: statusOf(readSettingsFile(path), path, options.skillDir) };
}
