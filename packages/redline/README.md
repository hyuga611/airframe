# redline

**The mark on the gauge** — you may cross it. It is here so that you know you did.

A limiter for a coding agent. It counts the **session**, not the call.

```
redline: 4 — production +2, irreversible +3
Past 3 with nobody in the seat. Stopping here: hand back to a human.
```

Part of the [`airframe`](https://github.com/hyuga611/airframe) machine — `npx @hyuga/airframe install`
wires it up along with everything else. It works on its own too.

## Why counting, and not asking

A permission prompt asks about one call at a time, and answers it in isolation. Every single call
can be defensible while the session as a whole goes somewhere nobody agreed to: a write to
production, then another, then a cleanup that deletes something, then a push. Nobody approved
*that*. They approved four things.

redline keeps one number per sortie. It only ever goes up.

| | |
|---|---|
| 1 | recorded |
| 2 | advised |
| 3 | **stopped** — but only when nobody is in the seat |

While you are flying it, past the edge you get told and you decide. Unattended, the tool call is
denied.

## The tariff

| | |
|---|---|
| irreversible — `rm -rf`, force push, hard reset, `DELETE FROM`, `DROP`, `TRUNCATE` | **+3** |
| outward — `npm publish`, `git push`, `gh pr create`, a POST, sending mail | **+3** |
| production — a write to a path you called production | **+2** |
| dependency — new code entering the tree | **+1** |
| unnamed — a file nobody asked for | **+0**, recorded only |

Irreversible and outward sit at the limit on their own, because the first instance is already the
whole event: there is no such thing as half a publish.

**Unnamed is written down and not charged.** A skill is handed a task and knows its own filenames,
so a file the prompt never mentions is the normal case, not the runaway — measured over a day,
19 of 22 charges were a skill writing its own declared output, and one skill crossed the limit in
41 seconds. The finding is still filed, so the question is still answerable; it just no longer
moves the number.

Charges are **not exclusive**. `git push --force` is irreversible and outward at once, and
pricing it as one of those would be the cheaper reading of the two.

**Reading production is free.** Charging for it would make the careful thing cost the same as the
dangerous one, which teaches skipping the read.

**Quoting is not doing.** A command is cut into the things it actually runs before the tariff is
applied: `grep "npm publish" README.md` costs nothing, `grep "npm publish" README.md && npm
publish` costs 3, and what a heredoc writes into a file is not read as commands at all. This
limiter learned that on itself — a session that only ever *searched* for the words reached 20
against a limit of 3, and a number that is mostly noise gets read as noise.

The numbers are meant to be argued with — spend a week disagreeing with them and change them. The
structure is what is being claimed, not the weights.

## Which paths are production

Yours to say, in `.redline.json`:

```json
{ "production": ["X:/01-client/", "/var/www/"] }
```

or `REDLINE_PRODUCTION`, semicolon-separated. A substring match, on the path for a write tool and on
the command line for a shell call — so `cp build/index.html /var/www/site/` is charged too.

## "Unnamed" needs to know what you asked for

The `UserPromptSubmit` hook records the filenames you mentioned in your own words. A write to
something else is the agent's own idea, and costs a point.

Without that hook redline **does not guess** — it charges nothing for scope rather than pricing every
file in the repo as unasked-for. It matches on filename only, so two files with the same basename
in different directories look alike to it.

## Install

```bash
npm i -D @hyuga/redline
```

Then, in `settings.json`:

```json
"PreToolUse":       [{ "hooks": [{ "type": "command", "command": "npx @hyuga/redline hook pre",    "timeout": 10 }] }],
"UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "npx @hyuga/redline hook prompt", "timeout": 10 }] }]
```

```bash
redline score      # what this sortie has spent so far
```

## Where the number lives

Nowhere in this package. redline has no store: it sums its own findings back out of the
[`spar`](https://github.com/hyuga611/airframe/tree/main/packages/spar) ledger, which is also what resets it when a new
sortie launches, keeps it quiet while you are drafting, and holds it silent inside a committed
deploy.

That is the point of the frame. A melee case was written into this file and turned out to be
unreachable, because the frame had already handled it — so it was deleted.

## This is a gauge, not a guard

**redline is not a security boundary, and it cannot be made into one.** Its number comes from
the ledger, and the ledger is a file in your repository that the agent can write to with the
same tools it uses for everything else. An agent that wanted a lower score could edit it. So
could a stray `sed`.

That is not a hole waiting to be closed. Move the ledger out of the repository and an agent with
a shell still reaches it; sign every line and the key has to live somewhere the same agent can
read. Anything that runs commands on your machine on your behalf is inside the boundary already,
and a limiter that pretends otherwise is worse than one that does not, because you would trust
the number.

What it is for is the case that actually happens: **not an agent trying to get past you, but one
that has no idea it is on its fourth irreversible operation, and a human who has lost count
too.** For that, a number summed from the record is exactly right, and its being editable costs
nothing.

Read the gauge the way a pilot reads one. It tells you where you are. It is not holding the
aircraft together.

## What this does not buy

**It does not know what is dangerous.** It knows what you told it to charge for, plus a list of
command shapes. A destructive thing spelled in a way the tariff does not match is free.

**It still over-charges, in one place on purpose.** A verb that prints — `grep`, `cat`, `echo` —
has its arguments treated as text, and so does a heredoc body. A verb that takes another command
does not: `node -e "…rm -rf…"`, `sed`, `awk`, `xargs` and `find -exec` are charged on what they
contain, because nothing here can tell whether that string is about to run or about to be
printed. Erring toward charging is deliberate where the answer is genuinely unknown. Erring
toward it where the answer was obvious is what cost this limiter 20 points for reading a README.

**Advice is advice.** With you in the seat, the message is text the model can reason its way past,
and sometimes it will. Only the unattended case is enforced.

Node 18+. One dependency, the frame. No daemon, no network, no LLM.

MIT.
