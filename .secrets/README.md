# .secrets/ — local token drop-point

**Everything in this directory except this README is gitignored.** Files here are read by tooling
on THIS machine and must never be committed, pasted into a doc, or echoed into a log. The scrub
gate cannot see gitignored files — the protection is that they never enter git at all.

CI needs no file from here: npm publishing is OIDC trusted publishing, and the GitHub Packages
mirror uses the workflow's own `GITHUB_TOKEN`.

## The one token worth creating: `tap-github.token`

Used once to arm the release workflow's automatic Homebrew bump PR (the `TAP_GITHUB_TOKEN`
Actions secret). Create it like this:

1. Open <https://github.com/settings/personal-access-tokens/new> (fine-grained tokens).
2. **Token name**: `phase-console-tap-bump` · **Expiration**: 1 year.
3. **Resource owner**: `zsarir` · **Repository access**: *Only select repositories* →
   `zsarir/homebrew-tap`.
4. **Permissions → Repository permissions**: `Contents: Read and write`,
   `Pull requests: Read and write`. Nothing else.
5. Generate, copy the `github_pat_…` value, and save it here:

   ```bash
   printf '%s' 'github_pat_…' > .secrets/tap-github.token
   ```

6. Tell the agent it exists (or run it yourself):

   ```bash
   gh secret set TAP_GITHUB_TOKEN --repo zsarir/phased-execution < .secrets/tap-github.token
   ```

Without this secret the release still works end to end — the tap-bump job just skips cleanly and
the formula's `url`/`sha256` get bumped by hand.
