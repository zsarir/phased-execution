# 🏷️ Versioning and releasing

One tree, four ways out. Each channel has its own cadence, and a change is not "released" until it
has reached the channels its users are on — this page is the contract for getting it there.

| Channel | Name | Cadence | Updated by |
|---|---|---|---|
| Claude Code plugin | `phased-execution@mobin` | **every push to `main`** | the push itself — this repo *is* the marketplace |
| npm registry | [`phase-console`](https://www.npmjs.com/package/phase-console) | `vX.Y.Z` tags | `release.yml`, with OIDC provenance |
| GitHub Packages | `@zsarir/phase-console` | `vX.Y.Z` tags | the same workflow — a mirror publish (reads require GitHub auth, so npm stays the user-facing registry) |
| Homebrew | `zsarir/homebrew-tap/phase-console` | follows npm | a bump PR the workflow opens on the tap (needs the `TAP_GITHUB_TOKEN` secret), merged by a person |

A GitHub Release with the tarball attached is created for every tag, from the matching
[CHANGELOG](../CHANGELOG.md) section.

## How a change becomes an update

**Every merge to `main` IS a plugin release.** There is no version number on that channel by
design — Claude Code refreshes installed plugins from `main` in the background. So the bar for
pushing `main` is "this is releasable", always; the scrub and CI gates exist to hold that bar.

**A package release is a deliberate second step:**

1. Bump `version` in the **root** `package.json` (semver — the console and skill release together).
2. Add the matching `## [X.Y.Z] - date` section at the top of `CHANGELOG.md`.
3. Commit, then tag and push — the push is always a human decision, never automated:

   ```bash
   git tag vX.Y.Z
   git push origin main vX.Y.Z
   ```

4. `release.yml` reruns every CI gate, packs, **asserts the tarball's contents**, scrubs the
   artifact itself, publishes to npm (trusted publishing — no token exists to leak) and to GitHub
   Packages, creates the GitHub Release, and opens the tap bump PR. A tag whose version disagrees
   with `package.json` refuses to publish.

## What a change must carry with it

| If you change… | You must also update, in the same commit |
|---|---|
| Anything the server needs at runtime (a new `server/` import, a new `scripts/*.sh` it shells, a new `templates/`/`references/` file a prompt names) | the root `package.json` `files` allowlist **and** `.github/scripts/assert-tarball.sh` — the tarball assertions are the backstop, never trust the allowlist alone |
| A setup prompt in `viewer/shared/setup-prompts.js` | its verbatim carriers (README.md, docs/install.md, the in-app guide) — `viewer/test/setup-prompts.test.ts` fails otherwise |
| The Node floor | all five gates: root + viewer `package.json` engines, `viewer/run`, `bin/phase-console.mjs`, `viewer/deploy/agent.sh`, `desktop-launcher.command` (bump `LAUNCHER_REV`) — plus the docs that state it |
| English docs | the Persian mirror (`README.fa.md`, `USAGE.fa.md`, `viewer/README.fa.md`) |
| Anything user-visible | a `CHANGELOG.md` line (open an `## [Unreleased]` section if none exists) |

Before **every** commit: `bash .github/scripts/scrub.sh` — run it bare, not piped (failures are on
stderr and a pipe eats the exit code). It scans tracked ∪ staged files, so another workstream's
untracked files never block you.

## Secrets

Tokens live in **`.secrets/`** (gitignored — see its README for exactly which token to create and
how) or in GitHub Actions secrets — never in the tree, never in a commit. CI needs no long-lived
npm token at all: npm publishing is OIDC trusted publishing, GitHub Packages uses the workflow's
own `GITHUB_TOKEN`, and only the optional tap bump wants a fine-grained PAT (`TAP_GITHUB_TOKEN`).

## One-time setup (already done, recorded for the next repo)

- npmjs.com → the `phase-console` package → *Trusted Publisher*: repository `zsarir/phased-execution`,
  workflow `release.yml`. If npm requires the package to exist first, one manual
  `npm publish --access public` with a granular token bootstraps it; OIDC takes over from the next tag.
- `zsarir/homebrew-tap` holds `Formula/phase-console.rb`; its `sha256` must always be of the tarball
  **as served by the registry** (`curl -sL <registry tgz url> | shasum -a 256`), never a local pack.
