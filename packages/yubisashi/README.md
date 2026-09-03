# yubisashi

**Point at it, and say what it is, before you move.**

The part that runs *before* a write. It takes the completion contract
[`groundtruth`](https://github.com/hyuga611/airframe/tree/main/packages/groundtruth) will check at the
end of the turn and runs its probe once *now*, before the call that changes the world.

```
yubisashi: "publish the page" — the probe does not run: exit 1: 'lang' is not recognized as a command
  A probe that fails now fails at the end too, after the write. Fix it here, where it is cheap.
```

Part of the [`airframe`](https://github.com/hyuga611/airframe) machine — `npx @hyuga/airframe install`
wires it up along with everything else. It works on its own too.

## Why before

`groundtruth` is the gate at the end: nothing gets to report "done" until a probe has re-fetched real
state and the reading matches. That catches the fabricated completion. What it catches too late is the
**fabricated probe** — a contract whose command was never going to run.

On the machine that built this, the last five unmet contracts were:

| unmet | cause |
|---|---|
| 4 | the probe could not be run — a quoting mistake, a missing command |
| 1 | the work was actually not done |

Four of five were not failed work. They were failed *pointing*, discovered at the one moment where
fixing it is most expensive: after the write, with the turn blocked and the world already changed.

Japanese railways solved the same shape of error with 指差喚呼 — *pointing and calling*. Before the
train moves, the driver points at the signal and says its state out loud. Pointing is what makes a wrong
target visible before the train does. Here the finger is the probe and the call is the expectation, and
both are the line `groundtruth` will read back afterwards. **Declared once, checked twice.**

## What it does

Before a call `redline` would charge as **irreversible**, **outward** or **production**, yubisashi reads the
pending contracts and points at each one it has not yet pointed at this sortie: the probe runs once, and
what it returned is filed to the ledger as the reading before the write.

Then it speaks only when the finger finds nothing:

- **no contract** — you are about to write with nothing pointed at. Write the contract first, then call.
- **the probe does not run** — a non-zero exit, a command that is not there, a line that is not JSON, an
  `expect.type` groundtruth would reject. Fix it now.
- **the expectation is already true** — a contract the world meets *before* the write confirms nothing
  about the write. Point at something the write will change. Said once, not at every write.

When the finger is on something real, it says nothing. A contract is pointed at once per sortie, not before
every write: you point at the signal and go, you do not point at every sleeper.

With a pilot in the seat, all of this is advice. With nobody in the seat — `AIRFRAME_AUTONOMY` set — a write
with nothing pointed at is denied. That is the frame's rule, not this part's.

## Install

```bash
npx @hyuga/airframe install        # wires every mounted part, this one included
```

or by hand, in `.claude/settings.json`:

```json
"PreToolUse": [{ "hooks": [
  { "type": "command", "command": "npx @hyuga/yubisashi hook pre", "timeout": 10 }
]}]
```

Where the contracts are is `groundtruth`'s decision, and yubisashi follows it: `.groundtruth/pending.jsonl`
under the session root, or `GROUNDTRUTH_PENDING`, or `~/.claude/groundtruth/<session_id>.jsonl` when a
hand-wired gate keeps one file per session. Both of the last two are read when both exist.

One contract per line, the same line groundtruth reads:

```json
{"action":"upload three pages","probe":"ssh host ls /var/www/site | wc -l","expect":{"type":"count","value":3}}
```

### By hand

```bash
npx @hyuga/yubisashi point                 # every pending contract, probed now
npx @hyuga/yubisashi point contracts.jsonl
```

```
→ "upload three pages" [count(3)] — before: "0"
✗ "publish the note" — probe-error: exit 1: curl: (6) Could not resolve host
```

Exits 1 if any probe does not run. What it pointed at is filed, so the hook does not point at it again.

## What it costs

One probe run per contract per sortie, on the first write after the contract appears. A probe gets four
seconds; a call gets eight. A probe that cannot answer inside that is reported as one that does not run,
and the pilot decides whether the probe or the clock is wrong.

## What this does not buy

**It does not check that the finger points at the thing you are about to touch.** A pending contract about
the database lets a write to the web server through. Whether the contract covers the write is the pilot's
to judge before, and groundtruth's to settle after.

**It does not run the probe again before every write.** The reading is from the first pointing this sortie.
If the world moves between that and the write, the end-of-turn check is where that shows.

**It does not decide what is a write.** That is `redline`'s tariff, and its production paths come from
`.redline.json` or `REDLINE_PRODUCTION`. With neither set, only irreversible and outward calls are pointed at.
