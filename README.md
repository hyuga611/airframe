# airframe

**One machine, made of parts** — a frame, whatever is bolted to it, and a person flying it.

```bash
npx @hyuga/airframe install
```

That writes the hooks for every part it finds into your `settings.json`, leaves the hooks you
already had alone, and starts a sortie the next time Claude Code opens.

## Why a machine and not four more tools

A verification gate, a limiter, a corrections log, a draft keeper — each of these exists, and
each ships its own CLI, its own config, its own report shape and its own exit code. Installing
the fourth costs what the third cost, because nothing holds them together. You end up with a bag
of tools, not something you can be in.

Here the frame is the product. Parts bolt onto it, are replaceable, and none of them know about
each other.

## The parts

| | | |
|---|---|---|
| [**spar**](packages/spar) | the member everything bolts to | one mode, one phase set, one finding shape, one ledger |
| [**redline**](packages/redline) | the mark on the gauge | counts the session, not the call — and tells you, rather than stopping you |
| [**carbon**](packages/carbon) | the copy taken as it is written over | the draft nothing else is keeping, kept only while you diverge |
| [**groundtruth**](packages/groundtruth) | the completion gate | re-fetches real state at the moment "done" is claimed |
| [**habit**](packages/habit) | what you keep fixing by hand | learns the corrections and hands them back next session |
| [**llm-safe-sql**](packages/llm-safe-sql) | runs the write, measures it, rolls back | so a human approves a measured fact, not a claim |
| [**airframe**](packages/airframe) | the assembled machine | one install, one status screen, one sortie |

Every part is published on its own and works on its own. `spar` is the only thing they share.

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

## What none of this buys

**It does not make the agent correct.** Every part is about what happens around the work — what
gets recorded, what gets refused, what reaches you and when. None of them read your code.

**redline is a gauge, not a guard.** Its number is summed out of a ledger the agent can write to.
That is not a hole waiting to be closed — anything running commands on your behalf is already
inside the boundary. It is built for the agent that has lost count, not the one trying to get
past you.

**carbon matches names, not contents.** `.env` is never copied; a draft with a key pasted into
the third paragraph is copied like any other draft.

## Working on this

```bash
npm install     # one command: npm workspaces links every part to every other
npm test        # all seven, 475 tests
```

Node 18+. No daemon, no network, no LLM, and no dependency outside this repository.

Releases are a tag per package (`spar-v0.1.0`) — see [RELEASING.md](RELEASING.md).

MIT.
