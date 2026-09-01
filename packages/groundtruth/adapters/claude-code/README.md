# groundtruth × Claude Code (the Stop hook)

A reference implementation that stops an agent ending its turn on an unverified "done".

## How it works

1. Whenever the agent causes a side effect, it appends one completion contract to
   `.groundtruth/pending.jsonl`: an `action`, a `probe` command that re-fetches the real state,
   and an `expect`.
2. At the end of the turn, the Stop hook `groundtruth-stop-hook.mjs` runs every probe and checks
   what came back.
3. A single unmet contract exits **2**, which blocks the stop, and the reasons go to stderr. The
   agent reads them, deals with them, and tries to finish again.
4. When they all pass, `pending.jsonl` is cleared and the hook exits 0.

## Setting it up

```jsonc
// .claude/settings.json
{
  "hooks": {
    "Stop": [
      { "hooks": [
        { "type": "command",
          "command": "node ./node_modules/@hyuga/groundtruth/adapters/claude-code/groundtruth-stop-hook.mjs" }
      ] }
    ]
  }
}
```

### Its own entry, not a pipe

Where other hooks are already wired to `Stop`, add this one **beside** them. Do not chain it
onto the end of an existing command with `|`:

```jsonc
"Stop": [
  { "hooks": [{ "type": "command", "command": "node ./other-stop-hook.mjs" }] },
  { "hooks": [{ "type": "command", "command": "node ./node_modules/@hyuga/groundtruth/adapters/claude-code/groundtruth-stop-hook.mjs" }] }
]
```

A pipeline reports the **last** command's exit status, so a gate anywhere but the end has its
`2` discarded and the turn ends on an unverified claim. Claude Code hands each command the hook
payload on stdin, and a pipe replaces that with the previous command's output — so a gate that
reads the payload (for the session id, say) gets the wrong bytes instead. Both failures are
silent, and both leave a gate that appears to be installed.

**Add it by hand.** On a locked-down machine an agent cannot edit `settings.json` for you: one
reported four separate refusals — a deny rule on `Edit(**/.claude/settings.json)`, and a
classifier that stopped the `Write`, the `cp` backup and even the generation of a script that
would have done it. That is the right outcome. A gate whose own installation the agent can
perform is a gate the agent can remove, so this is one edit worth typing yourself.

## What a contract looks like (`.groundtruth/pending.jsonl`)

```jsonl
{"action":"insert 45 rows with batch=123","probe":"psql -tAc 'select count(*) from t where batch=123'","expect":{"type":"count","value":45}}
{"action":"publish out.png","probe":"curl -sI https://example.com/out.png","expect":{"type":"contains","value":"200"}}
```

`expect.type` is one of `nonempty` / `count` / `at-least` / `contains` / `equals` / `matches`.
Omitted, it is `nonempty` — and a `type` this hook does not recognise is refused rather than
quietly read as the weakest of them.

## Notes

- `GROUNDTRUTH_PENDING` moves the contract file somewhere else.
- A probe is run as the command it says. **Nothing secret belongs in `.groundtruth`** — see
  `SECURITY.md` at the package root. A command that would have needed approval as a tool call
  does not need it here.
- If the hook itself falls over it exits 2, not 0. Treating the unverified as verified is the
  one thing this cannot do, including when the failure is its own.
- This is an adapter. The core — `verify` and `gate` in `src/index.mjs` — is framework-agnostic
  and knows nothing about Claude Code.
