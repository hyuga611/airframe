# carbon

**The copy taken as it is written over** — the one nothing else is keeping.

Your agent is about to write over a draft. `carbon` keeps what was there.

```bash
$ carbon list
2026-08-30T05-24-25-819Z-fbf1883f.md       24 bytes

$ carbon show 2026-08-30T05
the paragraph you liked
```

Part of the [`airframe`](https://github.com/hyuga611/airframe) machine, and the one that flies while
you are **diverging** rather than finishing.

## Why only drafts

Committed code is safe: git has every version of it, and a bad rewrite is a `git diff` away from
being noticed. Drafts are not. An outline, a spec you are still arguing with yourself about, the
paragraph that finally said the thing — those sit untracked next to the tracked work, get
rewritten by an agent that has no memory of its own previous output, and are simply gone.

carbon keeps a copy at the moment before that write, and only then:

| it keeps | it does not |
|---|---|
| in **cruise** — while you are diverging | in strike: git and review are behind you there |
| files git does not have | tracked files: `git show` already keeps those |
| a file that already exists | a new file is not being overwritten |
| prose-sized things | over 512 KB, it keeps the fact and not the body |
| files inside the working directory | anything outside it, and any symlink, whatever it points at |
| | files *named* like credentials — `.env`, `.git-credentials`, keys, `.ssh/`, `secrets/` |

## What it does not read

The refusal list matches **names, not contents**. `.env` is never copied; a draft called
`notes.md` with an API key pasted into the third paragraph is copied like any other draft,
because carbon does not open a file to decide whether to keep it.

That is a choice and not an oversight — a paragraph about a password is not a password, and a
part that reads every draft to judge it is a part that reads every draft. What it costs you is
real: **if you paste secrets into prose, carbon keeps them**, in `.spar/carbon/`, in plain text.

They stay out of git: the frame writes `.spar/.gitignore` when it first creates the directory,
so `git add -A` does not sweep the copies into your history. Nothing keeps them off your disk —
`carbon list` shows what is there, and deleting a copy is deleting a file.

## It never says anything

No message, no warning, no summary. Interrupting a draft is the exact failure the cruise form
exists to prevent, so carbon writes to disk and stays silent. You find out it was there when you
go looking, which is the only time you want it.

## Install

```bash
npm i -D @hyuga/carbon
```

```json
"PreToolUse": [{ "matcher": "Write|Edit", "hooks": [
  { "type": "command", "command": "npx @hyuga/carbon hook pre", "timeout": 10 }]}]
```

Or let the machine do it: `npx @hyuga/airframe install`.

Cruise is a mode you switch on purpose — `airframe mode cruise` — because nothing should be
guessing whether you are drafting or shipping.

## Where the copies go

`.spar/carbon/`, beside the ledger, per repository. Each copy also files one line in the
ledger, so what got superseded and when is part of the same record as everything else.

They are never cleaned up automatically. Deleting them is a decision, and a tool that quietly
throws away the thing it exists to keep would be worse than not having it.

## What this does not buy

**It is not undo.** It keeps a copy of the previous file; putting it back is yours to do, with
your eyes on both versions.

**It only sees writes that go through a hook.** A shell command that rewrites the file —
`sed -i`, a formatter, a codemod — is not a `Write`, and nothing is kept.

Node 18+. One dependency, [the frame](https://github.com/hyuga611/airframe/tree/main/packages/spar). No daemon, no
network, no LLM.

MIT.
