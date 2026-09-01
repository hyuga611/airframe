# spar

**The member everything bolts to** — laid down first, and the reason the parts add up to one structure.

The frame. Not a part. If you want the assembled machine, install
[`airframe`](https://github.com/hyuga611/airframe) instead — this is what it is built on.

## What a frame is for

Before the movable frame, armour *was* the structure: every variant meant designing the whole
thing again. Tools that watch a coding agent are built the same way. A verification gate, a
limiter, a corrections log — each carries its own store, its own config, its own report shape,
its own idea of what counts as an error. The fourth one costs what the third one cost.

`spar` is the skeleton those bolt onto. It owns six things and refuses to own anything else:

| | |
|---|---|
| **mode** | `strike` (converge) or `cruise` (diverge). Switched by the pilot, never inferred |
| **range** | inside strike: `fire` (discrete shots) or `melee` (committed, uninterruptible) |
| **phase** | `brief` / `pre` / `post` / `claim` |
| **finding** | one record shape every part emits |
| **ledger** | one append-only file per repo. Its polarity flips with the mode |
| **verdict** | who may stop what, and when |

It never acts. Parts act; spar decides what their findings mean and writes them down.

The full spec is [FRAME.ja.md](./FRAME.ja.md) (Japanese).

## Writing a part

```js
import { finding, report } from '@hyuga/spar';

const { show, verdict } = report(finding({
  phase: 'claim',
  source: 'my-part',
  severity: 'stop',
  subject: 'insert 45 rows',
  observed: 0,
  expected: 45,
}));

if (show) console.error(verdict);   // 'refuse-shot' — this claim does not get made
```

That is the whole contract. What a part does **not** write:

- where any of it is stored
- whether to interrupt (cruise and melee both mean *not now*, and that is not the part's call)
- how severity becomes a stop
- anything about sessions

The first part built on this, [`redline`](https://github.com/hyuga611/airframe/tree/main/packages/redline), came to 286 lines —
smaller than any tool it sits beside, and it carries the most policy of any of them. A melee case
written into it turned out to be unreachable: the frame had already handled it.

## Who may stop what

```
refuse-shot   a part declines its own shot. A completion gate refusing to report "done" is this
halt          the sortie stops. Only when nobody is in the seat
advise        everything else. A pilot who is flying gets told, and decides
```

A part never halts a machine that has someone in it. Advice you can overrule is a different thing
from a machine that stopped itself, and collapsing the two is how a guardrail becomes something
people turn off.

## Melee

`enterMelee()` refuses to close without two things, and checks them **before** contact, because
after contact there is nothing left to check:

```js
enterMelee({
  action: 'migrate orders table',
  exit:   'pg_dump at 09:00, restore path tested',   // no exit route → refused
  state:  await db.count(),                          // a reading taken now, not earlier → refused if stale
});
```

Inside, every finding is held rather than shown; `leaveMelee()` pulls the gate once, on the whole
swing. Past the propellant's bingo point, closing is refused outright — a swing is the one thing
that cannot be broken off halfway, so starting one you cannot finish and land is the worst
available move.

From a terminal it is `spar melee --action "..." --exit "..." --state "..."`, and
`spar melee leave` on the way out. **Which sortie that closes on is decided by the working
directory** — `SPAR_HOME`, or `.spar` beside you — so both commands print the one they used.
A directory with nothing launched in it is refused rather than committed: typing this in the
wrong folder used to write a phantom swing next to a session that was still being watched.

## Propellant

```js
launch({ mode: 'strike', budget: 200 });
burn(30);            // → { spent, remaining, pastBingo }
```

A limiter counts danger; this counts what is left. Both failures are real and they are not the
same one. `bingo` is not "nearly empty" — it is "still able to get home and land", because the
return leg costs more than the outbound one.

## The ledger

`.spar/ledger.jsonl`, per repository, append-only, one JSON object per line.

In **strike** it proves a thing was finished. In **cruise** it keeps what was put down and why —
which is the material the next attempt is built from, and the reason `brief()` exists.

```js
discard('the linter version of this', 'wrong shape — nobody wants to lint their taste');
// next session:
brief();  // → "Put down on purpose (kept, in case it is worth picking up): ..."
```

Findings raised inside a melee are read back out of the ledger by where it stood at contact, not
copied onto the sortie — hooks fire in parallel, and a lost update to a second copy is a finding
that silently never reaches the gate.

## Install

```bash
npm i @hyuga/spar
```

That gives you `spar` inside the project. To type it anywhere — which is what closing to melee
during a run actually needs — install it globally, or link it if you are running from a checkout:

```bash
npm i -g @hyuga/spar          # or, from a clone: npm link -w packages/spar
```

Mounting the whole machine with `@hyuga/airframe` does **not** put `spar` on your path: they are
separate packages with separate binaries, and linking one links one.

Node 18+. Zero dependencies, no daemon, no network, no LLM.

MIT.
