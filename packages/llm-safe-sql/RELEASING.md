# Releasing

Releases are made by pushing a tag. The workflow in
[`.github/workflows/release.yml`](.github/workflows/release.yml) runs the whole
suite against both databases, refuses to continue if the version numbers disagree,
publishes with provenance, and creates the GitHub release.

## One-time setup: trusted publishing

On npmjs.com, under the package's **Settings → Trusted publisher**, add a GitHub
Actions publisher for `hyuga611/llm-safe-sql` with the workflow file
`release.yml`.

This is worth doing rather than storing a token. A long-lived npm token in a
GitHub secret is a credential that can publish as you from anywhere, forever, and
it only has to leak once — from a log, a fork's pull-request workflow, a
compromised action. With trusted publishing there is no such credential: npm
verifies the workflow's short-lived OIDC identity at publish time. For a package
whose entire subject is not trusting things you have not checked, the alternative
would be hard to defend in the README.

If you would rather use a token, add `NPM_TOKEN` as a repository secret and set
`NODE_AUTH_TOKEN` from it in the publish step.

## Each release

1. Update `CHANGELOG.md`: move the unreleased notes under a new version heading
   with today's date, and add the link at the bottom.
2. Bump the version in **both** places — CI fails the release if they disagree,
   but finding out here is cheaper:
   - `package.json`
   - `src/version.ts` (`VERSION`) — the MCP server reports this to its client, and
     a stale value is a lie that is very hard to notice
3. Commit, then tag and push:

   ```bash
   git commit -am "release: v0.1.1"
   git tag -a v0.1.1 -m "v0.1.1"
   git push && git push --tags
   ```

4. Watch the run: `gh run watch`. It publishes only if every check passed.

To rehearse without publishing, run the workflow manually from the Actions tab
with **dry run** left on.

## What the workflow will not let through

- A tag whose version does not match `package.json` and `src/version.ts`.
- A failing test on either database.
- A tarball containing a `*.config.json`, a `.sql` dump, or a `.env` file. The
  published tarball is a security surface of its own: a config file naming real
  tables would be republished to everyone who installs.

## After a release with a security fix

Update the advisory, and say in the changelog what an affected user should check
in **their own data** — not only what changed in the code. Someone who ran the
broken version needs to know which of their approvals may have been incomplete.
