# Releasing

Seven packages, one repository, one workflow. A release is a tag; everything else
is done by [`.github/workflows/release.yml`](.github/workflows/release.yml), which
runs that package's tests, refuses to continue if the version numbers disagree,
publishes with provenance and creates the GitHub release.

## The tag says which package

```
<package>-v<version>
```

`spar-v0.1.0`, `habit-v0.4.1`, `llm-safe-sql-v0.10.0`. A bare `v0.1.0` cannot work
here: two packages can be at the same version, and the workflow would have no way
to know whose `package.json` to check the tag against.

## One-time setup: trusted publishing

On npmjs.com, per package, under **Settings → Trusted publisher**, add a GitHub
Actions publisher for `hyuga611/airframe` with the workflow file `release.yml`.

This is worth doing rather than storing a token. A long-lived npm token in a
GitHub secret is a credential that can publish as you from anywhere, forever, and
it only has to leak once — from a log, a fork's pull-request workflow, a
compromised action. With trusted publishing there is no such credential: npm
verifies the workflow's short-lived OIDC identity at publish time.

A package name that has never been published has nothing for npm to attach that
setting to, so **the first version of a new name goes up by hand once**:

```bash
npm publish --workspace=packages/spar --access public
```

After that, configure the trusted publisher and never publish by hand again.

## Order

`airframe` depends on `spar` and `redline`, so those two go first. The rest are
independent of each other; `groundtruth` and `llm-safe-sql` take `spar` as an
*optional* peer, which means they install and behave exactly as before without it.

```
spar → redline → carbon, habit, groundtruth → airframe → llm-safe-sql
```

## Each release

1. Update that package's `CHANGELOG.md`.
2. Bump the version in `packages/<name>/package.json` — and, for two packages, in
   the second place that carries it. CI fails the release if they disagree, but
   finding out here is cheaper:
   - `llm-safe-sql`: `src/version.ts` (`VERSION`), which the MCP server reports to
     its client. A stale value there is a lie that is very hard to notice.
   - `groundtruth`: nothing to bump — the CLI reads `package.json` — but the
     workflow checks that `--version` really answers with it rather than
     `unknown`, which is what a broken read produces.
3. Commit, then tag and push:

   ```bash
   git commit -am "release: spar 0.1.1"
   git tag -a spar-v0.1.1 -m "spar-v0.1.1"
   git push && git push --tags
   ```

4. Watch the run: `gh run watch`. It publishes only if every check passed.

To rehearse without publishing, run the workflow manually from the Actions tab
with **dry run** left on, naming the package.

## The check that runs against a real install

Everything else in the release runs against the working tree, where npm workspaces
has linked every part to every other and node resolves anything. That is not the
machine the package lands on.

```bash
node scripts/smoke-install.mjs <package>   # one
node scripts/smoke-install.mjs --all       # every package, in dependency order
```

It packs the package, installs the tarball into an empty project, lets npm resolve
its dependencies **from the registry**, then imports every subpath the package
claims to export and starts every bin it declares.

This is not a formality. redline, carbon and airframe were one command away from
being published importing `@hyuga/spar/cli` while declaring `@hyuga/spar: ^0.1.0`
— a version whose `exports` are `{ ".": "./src/spar.mjs" }` and nothing else.
Tests passed, typecheck passed, the tarball contents passed. On anybody else's
machine all three would have thrown `ERR_PACKAGE_PATH_NOT_EXPORTED` inside a hook,
where nothing reports an error.

It is also what makes the order above real rather than advisory: releasing
`redline` before `spar` is on the registry fails here with `ETARGET`, instead of
succeeding and breaking every install. So run it locally after bumping, and expect
a dependent package to fail until what it depends on is actually published.

## Renames

`groundtruth` was published as `@hyuga/genchi` and `habit` as `@hyuga/narai`. npm
has no rename, so the old names are separate packages that still resolve. After
the new name's first release, point the old one at it:

```bash
npm deprecate @hyuga/genchi "renamed to @hyuga/groundtruth"
npm deprecate @hyuga/narai "renamed to @hyuga/habit"
```

## What the workflow will not let through

- A tag whose version does not match the package's `package.json`.
- A tag naming a directory that is not there.
- A failing test — for `llm-safe-sql`, on both databases.
- A tarball containing a `*.config.json`, a `.sql` dump, or a `.env` file. The
  published tarball is a security surface of its own: a config file naming real
  tables would be republished to everyone who installs.

## After a release with a security fix

Update the advisory, and say in the changelog what an affected user should check
in **their own data** — not only what changed in the code. Someone who ran the
broken version needs to know which of their approvals may have been incomplete.
