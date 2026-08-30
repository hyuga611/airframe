# Releasing

This package is released from the monorepo, by the workflow described in
[`../../RELEASING.md`](../../RELEASING.md). Read that first; what follows is only
what is particular to `llm-safe-sql`.

- **The tag is `llm-safe-sql-v<version>`.** A bare `v<version>` will not start a
  release run.
- **The version lives in two places** and both have to agree with the tag:
  `package.json` and `src/version.ts` (`VERSION`). The MCP server reports the
  second to its client, so a stale value there is a lie that is very hard to
  notice from the outside. 0.10.0 was tagged with `src/version.ts` still reading
  `0.9.0`; the workflow's version check exists for exactly that.
- **The release runs against real databases.** MySQL and Postgres services are
  started for the verify job, and `test:integration` has to pass on both. A unit
  suite that only ever saw SQLite would not tell you whether a savepoint rolls
  back what you think it does.
- **`prepublishOnly` builds and tests again** before the tarball is made, so the
  published `dist/` is always compiled from the commit being published.

## After a release with a security fix

Update the advisory, and say in the changelog what an affected user should check
in **their own data** — not only what changed in the code. Someone who ran the
broken version needs to know which of their approvals may have been incomplete.
