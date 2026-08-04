/**
 * What a phase touches — the reading that decides whether two sessions may run.
 *
 * Two things are being pinned down here. The first is that a Repos cell written
 * by a human parses into the tokens a human meant: backticks, bold, parenthetical
 * asides and `+` separators all appear in real plans, and none of them are part
 * of a repository's name.
 *
 * The second is the shape of the intersection rule, and it matters more. Every
 * ambiguous case has to resolve toward *collides*: a false conflict costs one
 * session's parallelism, a missed one lets two sessions write the same tree.
 * The one place that is deliberately NOT conservative is the segment boundary —
 * `api` and `api-gateway` are different repositories, and a rule that called
 * them the same would serialise unrelated work forever.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  parseScope, normalizeToken, tokensIntersect, scopesIntersect, scopeOfRow, formatScope,
  intersectingTokens,
} = await import('../shared/scope.js');

test('a plain cell reads as its repos', () => {
  assert.deepEqual(parseScope('api-server, web-app'), ['api-server', 'web-app']);
  assert.deepEqual(parseScope('api-server'), ['api-server']);
});

test('the separators plans actually use all separate', () => {
  assert.deepEqual(parseScope('api-server + web-app'), ['api-server', 'web-app']);
  assert.deepEqual(parseScope('api-server+web-app'), ['api-server', 'web-app']);
  assert.deepEqual(parseScope('api-server and web-app'), ['api-server', 'web-app']);
  assert.deepEqual(parseScope('api-server, web-app + docs'), ['api-server', 'web-app', 'docs']);
});

test('markdown around a name is not part of the name', () => {
  assert.deepEqual(parseScope('`api-server`'), ['api-server']);
  assert.deepEqual(parseScope('**web-app**'), ['web-app']);
  assert.deepEqual(parseScope('`api-server`, **web-app**'), ['api-server', 'web-app']);
});

test('a parenthetical aside is an aside, not a second repo', () => {
  // The `+` inside the parentheses would otherwise invent a repo called "web".
  assert.deepEqual(parseScope('api-server (+web snapshot)'), ['api-server']);
  assert.deepEqual(parseScope('api-server (Lambda), web-app (Vercel)'), ['api-server', 'web-app']);
  assert.deepEqual(parseScope('api(-contracts), web-app'), ['api', 'web-app']);
  // An unclosed parenthetical still comes off — plans do write them.
  assert.deepEqual(parseScope('api-server (deploy only'), ['api-server']);
});

test('a cell that is nothing but an aside declares nothing', () => {
  assert.deepEqual(parseScope('(verification)'), []);
  assert.deepEqual(parseScope('—'), []);
  assert.deepEqual(parseScope(''), []);
});

test('a slash is a path, not a separator', () => {
  // The whole reason paths survive: `packages/cart-api` is one thing to lock.
  assert.deepEqual(parseScope('packages/cart-api'), ['packages/cart-api']);
  assert.deepEqual(parseScope('packages/cart-api, packages/web-app'),
    ['packages/cart-api', 'packages/web-app']);
});

test('whitespace inside a cell separates, so a two-word repo stays reachable', () => {
  // `docs-repo docs` must keep intersecting a plain `docs-repo` — same tree.
  assert.deepEqual(parseScope('docs-repo docs'), ['docs-repo', 'docs']);
  assert.equal(scopesIntersect(parseScope('docs-repo docs'), ['docs-repo']), true);
});

test('repeats collapse and order is kept', () => {
  assert.deepEqual(parseScope('api-server, api-server, web-app'), ['api-server', 'web-app']);
});

test('noise never becomes a token', () => {
  assert.equal(normalizeToken('#'), '');
  assert.equal(normalizeToken('×3'), '');      // one usable character is not a repo
  assert.equal(normalizeToken('a'), '');
  assert.equal(normalizeToken('-'), '');
  assert.equal(normalizeToken('x'.repeat(65)), '');
  assert.equal(normalizeToken('~/.config/skills'), 'config/skills');
  assert.equal(normalizeToken('  API-Server  '), 'api-server');
  assert.equal(normalizeToken('a//b'), 'a/b');
});

test('the wildcard survives as `all`', () => {
  assert.equal(normalizeToken('*'), 'all');
  assert.deepEqual(parseScope('*'), ['all']);
});

test('saying nothing means it might touch anything', () => {
  // The conservative default. "Declared no repos" must never read as
  // "collides with nothing" — that is the one mistake that corrupts a tree.
  assert.deepEqual(scopeOfRow(''), ['all']);
  assert.deepEqual(scopeOfRow('   '), ['all']);
  assert.deepEqual(scopeOfRow('(verification)'), ['all']);
  assert.deepEqual(scopeOfRow('api-server'), ['api-server']);
});

test('`all` touches everything', () => {
  assert.equal(tokensIntersect('all', 'api-server'), true);
  assert.equal(tokensIntersect('api-server', 'all'), true);
  assert.equal(tokensIntersect('all', 'all'), true);
  assert.equal(scopesIntersect(['all'], ['web-app']), true);
  assert.equal(scopesIntersect(scopeOfRow(''), ['web-app']), true);
});

test('equal tokens collide, different ones do not', () => {
  assert.equal(tokensIntersect('api-server', 'api-server'), true);
  assert.equal(tokensIntersect('api-server', 'web-app'), false);
});

test('a path prefix collides with what is under it', () => {
  assert.equal(tokensIntersect('packages', 'packages/cart-api'), true);
  assert.equal(tokensIntersect('packages/cart-api', 'packages'), true);
  assert.equal(tokensIntersect('packages/cart-api', 'packages/cart-api/src'), true);
  assert.equal(tokensIntersect('packages/cart-api', 'packages/web-app'), false);
});

test('the prefix is segment-wise — neighbouring names are not nested', () => {
  // The case a naive startsWith gets wrong, and the reason this is a rule and
  // not a one-liner: these are two separate repositories.
  assert.equal(tokensIntersect('api', 'api-gateway'), false);
  assert.equal(tokensIntersect('api-gateway', 'api'), false);
  assert.equal(tokensIntersect('web', 'web-app'), false);
});

test('two scopes collide when any pair of their tokens does', () => {
  assert.equal(scopesIntersect(['api-server', 'docs'], ['web-app', 'docs']), true);
  assert.equal(scopesIntersect(['api-server'], ['web-app']), false);
  assert.equal(scopesIntersect(['packages'], ['packages/cart-api']), true);
});

test('an unknown scope is treated as a collision', () => {
  assert.equal(scopesIntersect([], ['web-app']), true);
  assert.equal(scopesIntersect(['api-server'], []), true);
});

test('scopesIntersect accepts raw cells as well as token lists', () => {
  assert.equal(scopesIntersect('api-server, docs', 'docs'), true);
  assert.equal(scopesIntersect('api-server', '`web-app`'), false);
});

test('formatScope round-trips through parseScope', () => {
  const csv = formatScope(parseScope('`api-server` (Lambda), web-app + docs'));
  assert.equal(csv, 'api-server,web-app,docs');
  assert.deepEqual(parseScope(csv), ['api-server', 'web-app', 'docs']);
  assert.equal(formatScope('api-server, web-app'), 'api-server,web-app');
});

test('a conflict can name the tokens that caused it', () => {
  // A message that says "held by X" and not which repo collided sends the
  // reader back to the plan to work it out. Say it in the message.
  assert.deepEqual(intersectingTokens(['api-server', 'docs'], ['docs', 'web-app']), ['docs']);
  assert.deepEqual(intersectingTokens(['packages'], ['packages/cart-api']),
    ['packages~packages/cart-api']);
  assert.deepEqual(intersectingTokens(['api-server'], ['web-app']), []);
});
