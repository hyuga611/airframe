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
