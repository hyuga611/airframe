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

The number never goes down inside a sortie. What is per-call is *which* call gets stopped: one
that adds nothing to the total is not stopped for the last one that did. Otherwise a scheduled
task that deletes a single temporary file spends the rest of its run being refused permission to
write to a scratch directory, and cannot even hand back.

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

## A run that was always going to cost this much

Writing a page into a production tree is two points. Uploading it is two more. So a run that does
the whole job crosses the limit on its last step — **every time** — and a batch is that shape
multiplied: ten clients is twenty points, and from the second one onwards every publish is past
the edge.

Raising the limit for long sorties would not fix this; it would just mean the limit grows with
whatever the agent happens to be doing, which is not a limit. Charging a repeated destination
only once would not fix it either — there is no such thing as half a publish, and the tenth
client's page is not free because the first one's was charged.

What is actually wrong there is the question. "Is this call past the edge" is the wrong thing to
ask, per call, about a sequence whose cost was known before it started. Ask it once, in front:

```bash
spar melee --action "monthly karte for all clients" \
           --exit   "yesterday's backup at X:/backup/20260901" \
           --state  "$(curl -sI https://example.com/report/ | head -1)"
```

A swing needs an exit route and a reading taken at contact, and it refuses to close without
either. Inside one, findings accumulate instead of interrupting, and the gate is pulled **once**,
on `spar melee leave`. For an unattended run that is the operator's line to write in the runner,
before the loop — not something the agent argues its way through call by call.

## Which paths are production

Yours to say, in `.redline.json`:

```json
{ "production": ["X:/01-client/", "/var/www/"] }
```

Looked for from every tree a call touches at once: the directory the session was started in, the
directory of the file being written, and up to four absolute paths a shell command names — each
walking upwards, then falling back to your home directory.

Both, because a hook's working directory is not where the work is. It is where the *session*
started, and an agent started in a home directory writes to a client tree on a network share all
day without ever changing it. A config at the top of that share would never be reached, and a
config that is not found fails silently: the most exposed write of the day gets charged as an
ordinary one. Which paths are production is a property of the tree the file lives in, the way
`.gitignore` is, and that tree is the one that knows.

What they say is **added together, never ranked**. Ranking would let a config anywhere in the
write path shorten the list the session started with — a quieter limiter, chosen by the directory
being written to. A union can only make more things count as production, which is the direction a
limiter is allowed to be wrong in.

**A shell command gets one too**, from the absolute paths it names — because the last step of
publishing anything is a shell command, and it was the one call whose charge depended on where
you had filed the config. Staging a file into a client tree was priced; the upload that put it in
front of the public was free.

Taking a path out of a string is a guess, and the reason a wrong guess is tolerable here is the
union: anything found this way can only *add* to what counts as production. A guess that lands
nowhere costs a few `existsSync` calls and changes no number. Read-only segments are dropped
first, so `grep /var/www -r` is not asked about the tree it is reading.

Or, as well, `REDLINE_PRODUCTION`, semicolon-separated — it is unioned with whatever the files say, never ignored because a file exists. A substring match, on the path for a write tool and on
the command line for a shell call — so `cp build/index.html /var/www/site/` is charged too.

## "Unnamed" needs to know what you asked for

The `UserPromptSubmit` hook records the filenames you mentioned in your own words. A write to
something else is the agent's own idea — written down, and free.

Naming nothing is recorded too, and is not the same as the hook being absent. "`/karte <client>`"
names a task and no files, so everything the run writes is the agent's own idea — which is when
the record is worth most, and was the one case that used to leave none.

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
