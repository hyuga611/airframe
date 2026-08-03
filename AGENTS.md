# narai — notes for agents working on this repository

`narai` tells a coding agent when a human edited what it wrote, so it stops reverting those
edits. Two Claude Code hooks and a local store; no daemon, no network.

## Layout

- `src/narai.mjs` — the hooks, the store, the diff, the CLI
- `src/learn.mjs` — distilling accumulated edits into rules (the only part that calls a model)
- `test/narai.test.mjs` — unit tests

## Working on it

Run `npm run test`. The suite points the store at a temporary directory and never touches the
real one, and it never reaches the network — `distill()` takes its client as an argument.

## Rules of the house

- **A hook must never break the session.** Both entry points swallow every error and exit 0. A
  crash here would stop the user from editing files, which is far worse than missing a diff.
- **Keep the hot path free of a model.** `PreToolUse` runs before every write. It compares
  hashes and nothing more. Interpretation belongs in the learn half, run separately.
- **Withhold contents by default when in doubt.** The store exists to produce diffs, but a diff
  is never worth keeping a secret on disk. When a path looks like it holds credentials, record
  the hash and drop the body — detection still works, and that is the part that matters.
- **A rule must cite the corrections that produced it, at least two, by id.** This is enforced
  in `validate()`, not asked for in the prompt, because a model will happily assert a personality
  trait it cannot support. Claims about the user have to be checkable or they do not ship.
- **Say what happened, not what it means.** The text injected into the agent reports the diff and
  stops there. Deciding what the edit implies is the agent's job, and undoing it is the user's.
