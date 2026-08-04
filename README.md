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
| `SessionStart` | a session begins | hands the same thing to the main agent — the one that actually writes your files |

The comparison itself is microseconds. Measured end to end it is about **18 ms per write**, and
essentially all of that is one `git check-ignore` subprocess — the check that keeps git-ignored
files from being stored. `NARAI_HASH_ONLY=1` skips it (no bodies are kept at all, so there is
nothing to decide) and brings the hook back under a microsecond.

It works on **any file the agent writes** — source, Markdown, HTML, CSV, config. The problem
isn't specific to code, and neither is this.

## Install

```bash
npm i -g narai
```

Then add the hooks to your Claude Code `settings.json`. The first two are the product; the
rest are what makes it learn rather than only warn:

```json
{
  "hooks": {
    "PostToolUse": [{ "matcher": "Write|Edit", "hooks": [
      { "type": "command", "command": "npx narai hook post", "timeout": 10 }]}],
    "PreToolUse":  [{ "matcher": "Write|Edit", "hooks": [
      { "type": "command", "command": "npx narai hook pre",  "timeout": 10 }]}],
    "SessionStart": [{ "hooks": [
      { "type": "command", "command": "npx narai hook session", "timeout": 10 }]}],
    "SubagentStart": [{ "hooks": [
      { "type": "command", "command": "npx narai hook subagent", "timeout": 10 }]}],
    "PermissionDenied": [{ "hooks": [
      { "type": "command", "command": "npx narai hook denied", "timeout": 10 }]}],
    "PostToolUseFailure": [{ "hooks": [
      { "type": "command", "command": "npx narai hook failed", "timeout": 10 }]}]
  }
}
```

Every hook always exits 0. If `narai` breaks, your editing session does not.

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

### Two things narai keeps are not files

Those rules judge a path, which covers a file *named* for a credential and nothing else. But
narai also stores **the sentence you typed** (taken from the transcript, so a rule can cite the
reason in your own words) and **the text of a failed call**. Paste a key into the chat and no
path rule ever sees it.

So both go through a second check that matches the *shape* of a credential in free text —
`sk-…`, `ghp_…`, `AKIA…`, `Bearer …`, `password=`, `パスワード:`, `api_key=`, a private-key
header, a URL with `user:pass@`. When one matches, **the whole sentence is dropped** and the
record says why:

```json
{ "askedFor": null, "askedForWithheld": "secret-like", "removed": ["..."], "added": ["..."] }
```

The diff survives either way, so the correction is still usable evidence — just weaker. This
will sometimes drop a sentence that merely *discusses* a password, and that is the right way
to be wrong. `narai doctor` counts how often it has happened; a run of them means credentials
are being typed into the chat. `NARAI_NO_PROMPTS=1` drops every sentence, secret or not.

A file that holds a secret but isn't *named* like one — `config.js`, `docker-compose.yml` —
is still stored in full. Pattern matching has holes by construction; treat the store as
sensitive as the code it watches.

## Keeping it from growing forever

```bash
narai prune              # what could go
narai prune --apply      # drop it
narai prune --days 90 --apply
```

A stored body exists for exactly one purpose: to diff against the **next** write of that same
file. A body whose file has been deleted can never be used again, and one untouched for a month
probably won't be. `prune` drops those bodies and **keeps the hash**, so nothing stops being
detected — the next write to that path just reads the file first instead of showing a diff.

Nothing runs on a schedule and nothing deletes on its own. It is a command, it defaults to a
dry run, and `narai doctor` reports the total so you can see when it is worth running.

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

Once saved, the rules are handed to the agent at the start of every session — the same thing
`SubagentStart` already did for subagents, extended to the one that actually writes your files.
You can still paste them into `AGENTS.md`; you no longer have to for them to have any effect.

**The one thing narai says without being asked.** Distilling needs a model, and a model may
not run inside a hook, so something has to raise the subject — otherwise the corrections pile
up and nothing ever reads them. Once at least ten are waiting, the pile has grown since last
time, and a week has passed, one line appears at session start:

```
narai: 14 correction(s) recorded, not yet distilled. The narai-learn skill turns them into rules.
```

It is addressed to the agent, which can act on it, rather than to you, who would have to
remember. Those three gates are the whole design: an ambient line that repeats is an ambient
line you turn off.

## Checking it is still working

```bash
narai doctor
```

narai is a set of couplings to fields another program decides to send. When one stops
arriving nothing breaks — the hook still runs, still exits 0, still writes a record. It
writes a record with a hole in it, and the tool quietly gets worse at its job.

So `doctor` reports what has actually been observed, never what is expected:

```
Fields the hooks depend on, as actually delivered:
  artifacts carry prompt_id          65/68   partial
  instructed ones carry askedFor     11/11
  failures carry an error            0/34   DEAD — a failure signal records that something
                                             failed and nothing about what [harness]
```

That last line is the point. Nothing in the source looks wrong; the field name was simply
never the right one, and no amount of reading the code would say so. It can only be counted.
`doctor` writes nothing and reads everything, so it costs nothing to run on a hunch.

## Did the rules actually do anything

```bash
narai score
```

Every saved rule goes into a ledger as a prediction: *apply this and corrections of this kind
stop*. `score` checks it against the corrections that have arrived since.

A rule is only scorable when the corrections behind it share an actual repeated line — that
line becomes the marker to watch for. When they share nothing literal, which is common and
true of most style habits, the rule reports **unscorable**: it still applies, it just cannot
be graded. The alternative is fuzzy matching, which fires on unrelated edits and turns the
ledger into noise.

**No hit rate is printed, deliberately.** A rule with no recurrence may be working, or the
situation may never have come up — nothing in the data separates those. And since narai now
injects these same rules at session start, it is treating the behaviour it is measuring, so
any ratio would be pinned toward a perfect score by its own hand. You get the rows and the
dates. A scoreboard whose mistakes flatter it is a sales pitch.

## What it is not

It does not judge your edit, and it does not stop the agent. It makes the agent aware that a
human changed something, and leaves the decision where it belongs.

## License

MIT
