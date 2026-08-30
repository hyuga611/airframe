# Security Policy

`groundtruth` runs locally / in CI with **zero runtime dependencies**. The library itself makes **no network calls, runs no LLM, and needs no API key**.

Note: the **probes you provide** are what re-fetch real state — a probe (JS function or the `--probe` shell command) runs exactly what you tell it to. Treat probe commands like any other command you run, and never embed secrets in `.groundtruth` contract files.

**The Claude Code Stop hook is a different case, because there the probe is not one you wrote.** `adapters/claude-code/groundtruth-stop-hook.mjs` executes every `probe` line in `.groundtruth/pending.jsonl` as a shell command, and that file is written by the agent during its turn. A command that would have needed your approval as a `Bash` call does not need it here: the hook runs it at Stop, under whatever permissions the hook process has. This is inherent to verifying a claim from outside the claim, and it is not a boundary the gate can enforce for you — an agent that can write files in your repository is already inside it. If you would rather not have that path open, do not wire the Stop hook, and call `verify()` from your own code, where the probe is a function you control.

If you find a security issue, please open a private security advisory on the GitHub repository rather than a public issue.
