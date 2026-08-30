// Reading a completion contract out of JSONL: {action, probe, expect:{type,value}}.
//
// This is its own module because the same reading was copied into two places — the CLI's
// `groundtruth guard` and the Claude Code Stop hook — and 0.4.1 fixed only the CLI. The old,
// looser behaviour stayed in the hook, which is the side the README tells people to wire up.
// There is one way to read a contract, so there is one place it is read.

import { spawnSync } from 'node:child_process';
import { expect as X } from './index.mjs';

// A probe that runs a shell command and returns its stdout. A non-zero exit throws, which is
// how it is reported as a probe failure rather than as an answer.
export function shellProbe(cmd) {
  return () => {
    const r = spawnSync(cmd, { shell: true, encoding: 'utf8' });
    if (r.error) throw r.error;
    if (typeof r.status === 'number' && r.status !== 0) {
      throw new Error(`exit ${r.status}${r.stderr ? `: ${r.stderr.trim()}` : ''}`);
    }
    return (r.stdout ?? '').trim();
  };
}

export function expectFromSpec(spec) {
  // A contract with no expectation is not a contract. This used to fall through to nonempty in
  // silence, so a line that simply forgot `expect` became "met if the output is not empty" and
  // was counted among the confirmed.
  if (!spec || typeof spec !== 'object' || !spec.type) {
    throw new Error('contract has no expect.type — a contract without an expectation confirms nothing');
  }
  switch (String(spec.type).toLowerCase()) {
    case 'nonempty': return X.nonEmpty();
    case 'count': return X.count(Number(spec.value));
    case 'at-least': return X.atLeast(Number(spec.value));
    case 'contains': return X.contains(String(spec.value));
    case 'equals': return X.equals(String(spec.value));
    case 'matches': return X.matches(new RegExp(String(spec.value)));
    // A misspelling is not silently read as "passes if non-empty". `nonEmpty` is the library's
    // own API name, so the most likely typo of all was turning into the weakest question.
    default: throw new Error(
      `unknown expect.type: ${spec.type} `+
        '(expected one of: nonempty, count, at-least, contains, equals, matches)',
    );
  }
}

// Verify one contract, returning the failure when it is unmet and null when it is met.
// A failure rather than a throw, so that one bad line does not end the run with the remaining
// contracts never checked.
export async function checkContract(line, verify) {
  let c;
  try {
    c = JSON.parse(line);
  } catch {
    return { action: line.slice(0, 60), reason: 'bad-json', evidence: line };
  }
  if (!c.probe) return { action: c.action || '(no action)', reason: 'no-probe', evidence: '' };
  let expectFn;
  try {
    expectFn = expectFromSpec(c.expect);
  } catch (e) {
    return { action: c.action || '(no action)', reason: 'bad-expect', detail: e.message, evidence: '' };
  }
  const v = await verify({ action: c.action || c.probe, probe: shellProbe(String(c.probe)), expect: expectFn });
  return v.ok ? null : v;
}
