# narai

**習い** — when you fix something your coding agent wrote, the agent has no idea. Next time it
writes that file, it writes its version again and your fix is gone. `narai` closes that loop.

```
narai: report.md was edited after you last wrote it (2026-07-31T03:06:27Z).
Someone — most likely the user — changed it by hand.

What you wrote → what is there now:
- ## 🎉 Great news everyone
- We're thrilled to share some amazing results!
+ ## Monthly figures
+ Traffic rose 12% month over month. The breakdown follows.

That edit was deliberate. Read it before writing, and do not quietly revert it.
If you believe it should be undone, say why and ask first.
```

That text is injected into the agent's context *before* it writes, so the revert never happens.

## Corrections come in two shapes

Some people fix the file themselves. Many never touch it — they say *"no, drop the emoji"* and let
the agent do the editing. **No hand edit ever happens, but a correction certainly did.** narai
catches both.

| What you did | How it is detected |
|---|---|
| edited the file yourself | the file no longer matches what the agent last wrote |
| told the agent to change it | the agent rewrote its own output **across a turn boundary** |

The second is the stronger signal: it comes with *your reason, in your own words*. The turn
boundary is structural, not guessed — a rewrite under the same `prompt_id` is the agent still
working; a rewrite under a new one means you spoke in between.

```json
{
  "kind": "instructed",
  "askedFor": "drop the emoji, and give the figure instead of an adjective",
  "removed": ["## 🎉 Great news everyone"],
  "added":   ["## Monthly figures"]
}
```

## How it works

Hooks only. No daemon, no watcher, no LLM in the hot path.

| Hook | When | What it does |
|---|---|---|
| `PostToolUse` on `Write`/`Edit` | right after the agent writes | records hash and contents; notices a cross-turn rewrite of its own output |
| `PreToolUse` on `Write`/`Edit` | right before it writes again | compares against disk. Different? You edited it. Show the diff. |
| `PermissionDenied` | a call was blocked | records what was refused (program name only, never arguments) |
| `PostToolUseFailure` | a call failed | records the shape of the failure |
| `SubagentStart` | a subagent spawns | hands it what has been learned, so it doesn't repeat what you already corrected |

A hash comparison is microseconds, so this costs nothing per edit.

It works on **any file the agent writes** — source, Markdown, HTML, CSV, config. The problem
isn't specific to code, and neither is this.

## Install

```bash
npm i -g narai
```

Then add both hooks to your Claude Code `settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [{ "matcher": "Write|Edit", "hooks": [
      { "type": "command", "command": "npx narai hook post", "timeout": 10 }]}],
    "PreToolUse":  [{ "matcher": "Write|Edit", "hooks": [
      { "type": "command", "command": "npx narai hook pre",  "timeout": 10 }]}]
  }
}
```

Both hooks always exit 0. If `narai` breaks, your editing session does not.

## What it keeps, and where

Everything stays on your machine, under `~/.claude/narai/` (`narai where` prints the path).

Nothing here makes a network call — not the hooks, not the learning half, not to Anthropic,
not anywhere. You can check that yourself, and it is worth checking before you let anything
watch your files:

- `src/narai.mjs` imports only Node built-ins (`fs`, `path`, `crypto`, `os`, `url`,
  `child_process`) and has **zero runtime dependencies**
- the one subprocess it starts is `git check-ignore`, which reads and returns an exit code
- there is no `fetch`, no HTTP client, and no API key anywhere in the package — not in the
  hooks, not in the learning half. Grep for it.

To show a diff, the previous contents have to be kept. Some files should never be kept, so
they aren't:

- anything matching `.env*`, `*.pem`, `*.key`, `id_rsa*`, `.npmrc`, `.netrc`, or a path
  containing `secret` / `credential` / `password` / `token` / `apikey`
- anything `git check-ignore` says is ignored — usually local config and build output
- anything over 512 KB

Those files are **still watched**: the hash is recorded, so an edit is still detected. You just
get "the contents were not kept, read the file before writing over it" instead of a diff. Set
`NARAI_HASH_ONLY=1` to get that behaviour for every file.

## Seeing what it has learned

```bash
narai log
```

```
narai: 23 hand-edit(s) recorded (showing the last 20)

2026-07-31 03:06  report.md  (−2 +2)
    − ## 🎉 Great news everyone
    + ## Monthly figures
...

Corrected most often:
   9x  report.md
   5x  index.html
```

## Turning edits into rules

Every detected edit is a small piece of evidence about how you actually want things done. Once
enough accumulate, the **narai-learn** skill turns them into rules you can put in `AGENTS.md`.

The agent you already have does the reading. There is no API key and no second subscription:

```bash
narai corpus                      # the corrections, laid out for reading
narai validate rules.json         # exits 1 if a rule cannot be backed up
narai validate rules.json --save  # only once it exits 0
```

One constraint is enforced in code rather than in the instructions: **a rule must cite at
least two corrections that produced it, by id.** A rule backed by one correction is dropped.
A rule citing an id that does not exist is dropped. You get "removes emoji from headings
(3 corrections)", never "prefers a concise style" — because the second kind cannot be checked,
so nothing can ever catch it being wrong.

That check is the reason `validate` exists as a command. An agent asked to cite its evidence
will usually comply, and the times it does not are exactly the times the rule was invented.

## What it is not

It does not judge your edit, and it does not stop the agent. It makes the agent aware that a
human changed something, and leaves the decision where it belongs.

## License

MIT
