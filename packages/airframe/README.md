# airframe

**The assembled machine** — what the parts bolt onto, and what carries the person flying it.

```bash
npx @hyuga/airframe install
```

That writes the hooks for every part it finds into your `settings.json`, leaving the hooks you
already had alone. Restart Claude Code and you are flying it.

## Why a machine and not another tool

A verification gate, a limiter, a corrections log — each of these exists, and each ships its own
CLI, its own config, its own report shape and its own exit code. Installing the fourth costs what
the third cost, because nothing holds them together. You end up with a bag of tools, not
something you can be in.

airframe is the assembled thing. Underneath, [`spar`](https://github.com/hyuga611/airframe/tree/main/packages/spar) is the
frame every part bolts onto and [`redline`](https://github.com/hyuga611/airframe/tree/main/packages/redline) is the first part
mounted on it; more can be mounted without the frame changing shape.

## Two forms, and the pilot switches them

The failure this exists to prevent is a verification gate firing at a draft. Converging and
diverging are opposite jobs, and a machine that does both at once always lets the converging half
win — which is how a good idea gets closed early.

|  | **strike** | **cruise** |
|---|---|---|
| the work | narrow it, finish it | widen it, keep it open |
| parts | active | quiet |
| the ledger | proves a thing was done | keeps what you put down, and why |
| unattended | allowed | never |

```bash
airframe mode cruise      # drafting, designing, deciding what to build
airframe mode strike      # doing it
```

Nothing infers the form from your work. Guessing it is the same bug as never having the two.

## The ledger keeps what you dropped

```bash
airframe discard "the linter version of this" "wrong shape — nobody wants to lint their taste"
```

An idea abandoned with its reason intact gets picked up again. One abandoned silently is lost
twice. The next session opens with it:

```
Put down on purpose (kept, in case it is worth picking up):
  - the linter version of this — wrong shape — nobody wants to lint their taste
```

## Who may stop what

A part may refuse **its own shot** — that is what a completion gate does when it declines to
report "done".

Stopping **the machine** is different, and depends on whether anyone is in the seat:

- **you are flying it** — parts advise, you decide. Nothing is denied on your behalf
- **nobody is** — a part may deny the call outright

Unattended is never assumed from the fact that nobody has typed anything. It is on only when you
say so:

```bash
AIRFRAME_AUTONOMY="nightly deploy loop" claude -p "..."
```

That is the whole switch. With it set, `redline` past its limit denies the tool call instead of
narrating a warning at a model that can talk itself out of one.

## Propellant

```bash
AIRFRAME_BUDGET=200 claude
```

A limiter counts danger. This counts what is **left** — context, money, your attention. They are
different failures: a sortie can be perfectly safe and still run out halfway, and the worst way to
lose is to be unable to report what you already did. Past 70% the machine will not commit to
anything it cannot finish and land.

## Melee

Some work cannot be interrupted halfway: a deploy, a migration, a history rewrite, a refactor
whose intermediate states are all broken. Findings raised inside one are **held**, and the gate is
pulled once, on the way out. Closing to that range has two preconditions, both checked before
contact, because after contact there is no aborting:

- an **exit route** — a rollback, a backup, a revert path
- a **reading taken now** — reconnaissance from earlier in the session describes a target that has
  since moved

## Status

```
$ airframe status
sortie   2026-08-30T04-55-17-629Z-f376c0
form     strike / fire
spent    2
fuel     140/200
mounted
  + airframe        the vessel
  + redline          limiter — counts the sortie, not the call
  + habit         learns from the corrections you make by hand
  + carbon         keeps the draft about to be written over — cruise only
  + yubisashi      points at the target before a write — the same contract groundtruth checks after
  + groundtruth        completion gate — called from your code, not from a hook
  - llm-safe-sql  runs the write, measures it, rolls back — from your code
```

A `-` is a part that is not installed. Install it and run `airframe install` again; nothing else
changes.

## Mounting something that has never heard of this

A linter, a build, a test run, a check somebody else wrote — none of them know this frame
exists, and none of them need to. What they have is an exit code and something they printed,
which is a finding already:

```bash
airframe mount --as tenken -- tenken .
```

```
strike/brief  note  tenken → tenken .  {"exit":0,"said":["tenken: 2 files, all clean"]}
```

Filed as `brief` because that is ground inspection: it happens around the sortie, not inside
one. A non-zero exit is a `warn` and never a `stop` — a linter has no business halting a
machine.

## Adding a part with hooks of its own

`mount` covers anything that runs and exits. A part that needs its own hooks wired by `install`
has to be in the `PARTS` list in `src/airframe.mjs` — a literal array, not a discovery
mechanism. Write the part against [`spar`](https://github.com/hyuga611/airframe/tree/main/packages/spar) (the contract is
one function call), then open a PR that adds the entry.

A list is the honest shape while the answer to "how many people have built a part" is *nobody
yet*. A plugin protocol designed before its first plugin gets built around a guess about what
plugins need, and then it is the thing that cannot change. When someone turns up with a part,
that is the moment the list has earned replacing.

## What this does not buy

**It does not make the agent correct.** Every part here is about what happens around the work —
what gets recorded, what gets refused, what reaches you and when. None of them read the code.

**Advice is advice.** While you are flying, a part's warning is text the model can reason its way
past, and sometimes it will. Only the unattended case is enforced, and only by denying the call.

**The tariff is arguable.** What `redline` charges for which action is a judgement, and the first
week of using it is spent disagreeing with it. That is the intended use — the numbers are meant
to be edited, and the structure is what is being claimed.

## Install

```bash
npm i -D @hyuga/airframe && npx airframe install
```

Node 18+. No daemon, no network, no LLM. The ledger is one append-only file in
`.spar/ledger.jsonl`, per repository, and it outlives the session — losing the machine should
not cost you what was learned in it.

MIT.
