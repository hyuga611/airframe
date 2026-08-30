#!/usr/bin/env node
// groundtruth — a reference Stop hook for Claude Code.
//
// During a turn the agent appends the completion contracts it declares to
// .groundtruth/pending.jsonl. On Stop this hook re-fetches every one of their probes and checks
// them. A single unmet contract exits 2, which blocks the stop, and the reasons go to stderr —
// Claude reads them and can carry on. When they all pass, pending is cleared and it exits 0.
//
// .claude/settings.json:
//   { "hooks": { "Stop": [ { "hooks": [ { "type": "command",
//       "command": "node ./node_modules/@hyuga/groundtruth/adapters/claude-code/groundtruth-stop-hook.mjs" } ] } ] } }
//
// One contract per line in .groundtruth/pending.jsonl:
//   {"action":"insert 45 rows","probe":"psql -tAc 'select count(*) ...'","expect":{"type":"count","value":45}}

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { verify } from '../../src/index.mjs';
import { checkContract } from '../../src/contract.mjs';

const PENDING = process.env.GROUNDTRUTH_PENDING || '.groundtruth/pending.jsonl';

async function main() {
  if (!existsSync(PENDING)) process.exit(0); // nothing was declared, so there is nothing to check
  const lines = readFileSync(PENDING, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) process.exit(0);

  const failures = [];
  for (const line of lines) {
    const f = await checkContract(line, verify);
    if (f) failures.push(f);
  }

  if (failures.length === 0) {
    writeFileSync(PENDING, ''); // they all passed, so the slate is clean
    process.exit(0);
  }

  // Claude Code: stderr plus exit 2 blocks the stop and hands the reasons back to the agent.
  let msg = `groundtruth: ${failures.length}/${lines.length} completion contract(s) could not be confirmed against real state. Deal with these before claiming to be done:\n`;
  for (const f of failures) {
    const x = f.expectation ? ` [${f.expectation}]` : '';
    msg += `  - "${f.action}"${x} — ${f.reason}${f.detail ? ': ' + f.detail : ''}\n    the probe returned: ${f.evidence ?? ''}\n`;
  }
  process.stderr.write(msg);
  process.exit(2);
}

// Exiting 0 because the hook itself broke is precisely the act of treating the unconfirmed as
// confirmed. If the gate did not run, nothing gets to be reported as done either.
main().catch((e) => {
  process.stderr.write(
    `groundtruth stop-hook error: ${e && e.message ? e.message : e}\n` +
      'The completion contracts could not be verified. Unverified is not confirmed.\n',
  );
  process.exit(2);
});
