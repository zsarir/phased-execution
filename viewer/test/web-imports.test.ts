/**
 * The client's missing link check.
 *
 * `web/` has no build step and no bundler, which is the point — a fresh clone
 * runs it — but it also means nothing verifies that an import resolves until a
 * browser tries it and shows a blank page. A misspelt export or a helper that
 * was never actually written is invisible to `node --check`, because the syntax
 * is perfectly valid either way.
 *
 * So this walks the real module graph: every relative import must point at a
 * file that exists and must name something that file actually exports. Bare
 * specifiers are checked against the import map in index.html, since that is
 * the only thing resolving them at runtime.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'web');

function modules(dir: string, found: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'vendor') continue; // third-party, not ours to police
    const full = join(dir, name);
    if (statSync(full).isDirectory()) modules(full, found);
    else if (name.endsWith('.js')) found.push(full);
  }
  return found;
}

/** Named exports a module offers, including `export { a, b } from './x.js'`. */
function exportsOf(file: string): Set<string> {
  const source = readFileSync(file, 'utf8');
  const names = new Set<string>();

  for (const m of source.matchAll(/^export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(m[1]);
  }
  // `export { a, b as c }` and `export { a } from './x.js'`
  for (const m of source.matchAll(/^export\s*\{([^}]*)\}/gms)) {
    for (const part of m[1].split(',')) {
      const alias = part.trim().split(/\s+as\s+/);
      const name = (alias[1] ?? alias[0]).trim();
      if (name) names.add(name);
    }
  }
  if (/^export\s+default/m.test(source)) names.add('default');
  return names;
}

type Import = { line: number; names: string[]; source: string; star: boolean };

function importsOf(file: string): Import[] {
  const text = readFileSync(file, 'utf8');
  const found: Import[] = [];
  for (const m of text.matchAll(/^import\s+([^;]+?)\s+from\s+['"]([^'"]+)['"]/gms)) {
    const clause = m[1].trim();
    const line = text.slice(0, m.index).split('\n').length;
    if (clause.startsWith('*')) { found.push({ line, names: [], source: m[2], star: true }); continue; }
    const braced = /\{([^}]*)\}/.exec(clause);
    const names = braced
      ? braced[1].split(',').map((p) => p.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean)
      : ['default'];
    found.push({ line, names, source: m[2], star: false });
  }
  return found;
}

const files = modules(WEB);

test('the client has modules to check at all', () => {
  assert.ok(files.length > 5, `expected a handful of client modules, found ${files.length}`);
});

test('every relative import points at a file that exists', () => {
  const missing: string[] = [];
  for (const file of files) {
    for (const entry of importsOf(file)) {
      if (!entry.source.startsWith('.')) continue;
      const target = resolve(dirname(file), entry.source);
      if (!existsSync(target)) missing.push(`${relative(WEB, file)}:${entry.line} → ${entry.source}`);
    }
  }
  assert.deepEqual(missing, [], `imports pointing at nothing:\n${missing.join('\n')}`);
});

test('every imported name is actually exported by the module it comes from', () => {
  const broken: string[] = [];
  for (const file of files) {
    for (const entry of importsOf(file)) {
      if (!entry.source.startsWith('.') || entry.star) continue;
      const target = resolve(dirname(file), entry.source);
      if (!existsSync(target)) continue; // reported by the test above
      const available = exportsOf(target);
      for (const name of entry.names) {
        if (!available.has(name)) {
          broken.push(`${relative(WEB, file)}:${entry.line} imports { ${name} } from ${entry.source}, which does not export it`);
        }
      }
    }
  }
  // This is the check that catches a helper referenced from a comment that
  // describes it but code that never defined it.
  assert.deepEqual(broken, [], `\n${broken.join('\n')}`);
});

test('bare specifiers are all declared in the import map', () => {
  const html = readFileSync(join(WEB, 'index.html'), 'utf8');
  const map = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(map, 'index.html must carry the import map — nothing else resolves bare specifiers');
  const declared = new Set(Object.keys(JSON.parse(map[1]).imports ?? {}));

  const unresolved: string[] = [];
  for (const file of files) {
    for (const entry of importsOf(file)) {
      if (entry.source.startsWith('.') || entry.source.startsWith('/')) continue;
      if (!declared.has(entry.source)) unresolved.push(`${relative(WEB, file)}:${entry.line} → ${entry.source}`);
    }
  }
  assert.deepEqual(unresolved, [], `bare imports with no import-map entry:\n${unresolved.join('\n')}`);
});

test('every view the app routes to is a real export', () => {
  const app = readFileSync(join(WEB, 'app.js'), 'utf8');
  const used = [...app.matchAll(/<\$\{([A-Z][\w$]*)\}/g)].map((m) => m[1]);
  const imported = new Set(importsOf(join(WEB, 'app.js')).flatMap((entry) => entry.names));
  const defined = exportsOf(join(WEB, 'app.js'));
  const local = [...app.matchAll(/^function\s+([A-Z][\w$]*)/gm)].map((m) => m[1]);

  const unknown = [...new Set(used)].filter(
    (name) => !imported.has(name) && !defined.has(name) && !local.includes(name),
  );
  assert.deepEqual(unknown, [], `app.js renders components it never imported or defined: ${unknown.join(', ')}`);
});
