/**
 * What a phase touches, and whether two phases can run at the same time.
 *
 * The old rule was "one session at a time, always". It is a safe rule and a
 * wasteful one: two phases that touch different repositories have no way to
 * collide, and serialising them buys nothing. The rule that replaces it needs
 * to know what each phase touches — and the plan already says so, in the
 * **Repos** column of the Phase-graph table. That column is the SSOT; this
 * module is the one reading of it.
 *
 * Both sides of the system have to agree on that reading, or the doctrine is
 * decoration: `phase-lock.sh` decides in bash whether a claim collides, and the
 * console decides in JavaScript what to draw and what to admit. So the rules
 * here are deliberately small enough to reimplement in awk without drifting —
 * lowercase, a fixed character set, split on the separators plans actually use
 * — and `engine-parity.test.ts` holds the two readings against every real plan.
 *
 * Plain ESM with JSDoc rather than TypeScript because it is imported three
 * ways: by the server, by the Vite client, and directly by node's test runner.
 *
 * The intersection rule:
 *   - `all` (and `*`) touches everything — the conservative default for a
 *     phase that never said.
 *   - equal tokens intersect.
 *   - a token that is a *path prefix* of another intersects it, segment-wise:
 *     `packages` ∩ `packages/cart-api`. Segment-wise is the whole point —
 *     `api` ∩ `api-gateway` is disjoint, and a naive `startsWith` would have
 *     said otherwise and serialised two unrelated repos forever.
 *
 * Every ambiguity resolves toward *intersecting*. A false conflict costs
 * parallelism; a missed one lets two sessions write the same working tree.
 */

/** Characters a scope token may contain. Everything else is dropped. */
const ALLOWED = /[^a-z0-9._/-]+/g;

/**
 * Separators between tokens in a Repos cell.
 *
 * Whitespace is one of them, which is what lets `and` be handled as a *token*
 * below rather than as a `\band\b` alternation here. That is not a style
 * choice: awk has no `\b`, and the bash half has to split identically or the
 * two readings disagree the first time someone writes "api and web".
 */
const SEPARATORS = /[,+]|\s+/;

/** Shortest and longest a token may be. Below: noise like `1`. Above: prose. */
const MIN_LEN = 2;
const MAX_LEN = 64;

/**
 * One already-split token, normalised — or `''` if nothing usable is left.
 *
 * `parseScope` is the entry point for a whole cell; this handles a single token
 * and does not split, so callers must not hand it `"hub docs"`.
 */
export function normalizeToken(raw) {
  let t = String(raw ?? '').trim().toLowerCase();
  if (t === '*') return 'all';                 // the wildcard survives as `all`
  if (t === 'and') return '';                  // a conjunction between repos
  t = t.replace(ALLOWED, '');                  // markdown, `#`, `~`, `×`, …
  t = t.replace(/\/{2,}/g, '/');               // `a//b` is `a/b`
  t = t.replace(/^[^a-z0-9]+/, '').replace(/[^a-z0-9]+$/, '');
  if (t.length < MIN_LEN || t.length > MAX_LEN) return '';
  return t;
}

/**
 * A Repos cell as scope tokens, in the order they appear, deduped.
 *
 * Parentheticals come off first: `api-server (+web snapshot)` is one repo, and
 * splitting on the `+` inside it would invent a second. Whitespace separates
 * too, so `docs-repo docs` reads as `docs-repo` and `docs` — that keeps it
 * intersecting with a plain `docs-repo`, which is the truth (same working tree)
 * and the safe direction. `/` never separates, so `packages/cart-api` survives
 * as the one path it is.
 */
export function parseScope(cell) {
  const stripped = String(cell ?? '').replace(/\([^)]*\)?/g, ' ');
  const out = [];
  for (const part of stripped.split(SEPARATORS)) {
    const token = normalizeToken(part);
    if (token && !out.includes(token)) out.push(token);
  }
  return out;
}

/**
 * The scope of a Phase-graph row — `parseScope`, but never empty.
 *
 * A phase that declares no repos gets `['all']`: it might touch anything, so it
 * runs alone. Saying nothing must not read as "collides with nothing".
 */
export function scopeOfRow(cell) {
  const tokens = parseScope(cell);
  return tokens.length ? tokens : ['all'];
}

/** Do two single tokens overlap? See the intersection rule at the top. */
export function tokensIntersect(a, b) {
  if (!a || !b) return false;
  if (a === 'all' || b === 'all' || a === '*' || b === '*') return true;
  // Segment-wise prefix in both directions. The trailing `/` on both sides is
  // what makes it segment-wise: `aws-cdk/` does not start with `aws/`.
  return `${b}/`.startsWith(`${a}/`) || `${a}/`.startsWith(`${b}/`);
}

/** Do two scopes overlap — i.e. must these two phases be serialised? */
export function scopesIntersect(a, b) {
  const left = Array.isArray(a) ? a : parseScope(a);
  const right = Array.isArray(b) ? b : parseScope(b);
  if (!left.length || !right.length) return true;   // unknown ⇒ assume collision
  return left.some((x) => right.some((y) => tokensIntersect(x, y)));
}

/** The csv form written to a lock file and passed to `--scope`. */
export function formatScope(tokens) {
  const list = Array.isArray(tokens) ? tokens : parseScope(tokens);
  return list.join(',');
}

/** Which tokens of `a` and `b` actually collided — for saying *why* in a message. */
export function intersectingTokens(a, b) {
  const left = Array.isArray(a) ? a : parseScope(a);
  const right = Array.isArray(b) ? b : parseScope(b);
  const hits = [];
  for (const x of left) {
    for (const y of right) {
      if (!tokensIntersect(x, y)) continue;
      const label = x === y ? x : `${x}~${y}`;
      if (!hits.includes(label)) hits.push(label);
    }
  }
  return hits;
}
