---
name: narai-learn
description: Turn the corrections narai has recorded into rules for AGENTS.md / CLAUDE.md. Use when the user asks what narai has learned, wants rules distilled from their edits, asks "what are my habits", or says narai learn. Reads ~/.claude/narai/corrections and writes a validated rules file. Not for setting narai up, and not for reading a single diff — that is what `narai log` is for.
---

# narai-learn — put someone's habits into words they can hand to an agent

narai records the moments its user corrected an agent. This skill reads that pile and
writes the rules behind it.

There is no API key in this. You are the model. `narai` supplies the corrections and
throws out the rules whose evidence does not hold up.

## The loop

```bash
narai corpus                      # what has been recorded
# ...write rules.json...
narai validate rules.json         # exits 1 if a rule cannot be backed up
narai validate rules.json --save  # only once it exits 0
```

Run `narai corpus` first, every time. Do not read the correction files directly — the
corpus lays them out in a fixed shape, and the ids it prints are the ids `validate`
will check against.

If it prints `nothing recorded yet`, stop and say so. Do not invent a starting set.

## What a rule has to be

**Backed by at least two corrections, cited by id.** One correction is an incident. Two
is the beginning of a habit. `narai validate` enforces this — a rule citing one real id,
or an id that does not exist, is dropped and the command exits 1.

**Something an agent can act on.** Not "be careful with headings" but "do not put emoji
in headings". Next time the situation comes up, the sentence has to settle it.

**Observed, not inferred.** Write "removes emoji from headings (3 corrections)", never
"prefers a concise style". The second cannot be checked, so it cannot be dropped when
it is wrong.

**Their words beat the diff.** An entry with `the user said:` carries the reason in the
person's own words. The diff shows what changed; that line shows what they wanted. When
the two suggest different rules, follow the sentence.

## What to leave out

Typos. A number corrected for that one occasion. A change of subject matter. Anything
that happened once. These go in `skipped`, in a sentence — the user should be able to see
what you looked at and passed over, or they cannot tell a thin harvest from a lazy one.

An empty `rules` array is a fine answer. Say what was there and why none of it held.

## The file

```json
{
  "rules": [
    {
      "rule": "Write code comments in English.",
      "why": "Two corrections replaced Japanese comment blocks with English ones.",
      "scope": "**/*.mjs",
      "evidence": ["2026-07-31T04-16-22-486Z-00bd62fb", "2026-07-31T05-58-13-416Z-8a8c01de"],
      "confidence": "high"
    }
  ],
  "skipped": "One .smoke.md change was a test fixture, not a habit."
}
```

`scope` is a glob, or `*` when it applies everywhere. `confidence` is high / medium / low
— low is honest when two corrections agree but you can see another reading.

## Never leave a rejected file behind

If `narai validate` exits 1, fix the evidence and run it again. Try three times. Still
failing means the corrections do not support the rules you want to write — delete the
file and report what you found instead. **A rules file that validate rejects is never
left on disk**, and never pasted into AGENTS.md.

`--save` writes `~/.claude/narai/rules.json` and records each rule in the ledger as a
prediction: apply this, and corrections of this kind stop. That is checkable later, which
is the only reason to write it down.

## After it passes

Show the rules and say where they came from — how many corrections, over what span.
Then let the user decide whether they go in AGENTS.md. Do not edit AGENTS.md yourself
unless asked; a rule derived from someone's habits is still theirs to accept.
