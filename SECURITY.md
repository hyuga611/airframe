# Security Policy

`genchi` runs locally / in CI with **zero runtime dependencies**. The library itself makes **no network calls, runs no LLM, and needs no API key**.

Note: the **probes you provide** are what re-fetch real state — a probe (JS function or the `--probe` shell command) runs exactly what you tell it to. Treat probe commands like any other command you run, and never embed secrets in `.genchi` contract files.

If you find a security issue, please open a private security advisory on the GitHub repository rather than a public issue.
