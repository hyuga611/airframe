# Releasing

1. `npm run db:up && npm test && npm run test:integration` — both suites green.
2. Update `CHANGELOG.md`: move the unreleased notes under a new version heading
   with today's date, and add the link at the bottom.
3. Bump the version in **two** places, which must agree:
   - `package.json`
   - `src/version.ts` (`VERSION`) — the MCP server reports this to the client,
     and a stale value is a lie that is very hard to notice
4. `npm pack --dry-run` and read the file list. The published tarball is a
   security surface: a config file naming real tables, or a dump, would be
   republished to everyone. CI checks this too.
5. Commit, tag, push:
   ```bash
   git commit -am "release: v0.1.0"
   git tag -a v0.1.0 -m "v0.1.0"
   git push && git push --tags
   ```
6. `npm publish --access public` — scoped packages are private by default, and
   the flag is required every time. This prompts for 2FA.
7. Create the GitHub release from the tag, with the changelog section as the body.

## After a release with a security fix

Also update the advisory, and say in the changelog what an affected user should
check in their own data — not only what changed in the code. Someone who ran the
broken version needs to know which of their approvals may have been incomplete.
