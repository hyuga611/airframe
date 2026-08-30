#!/usr/bin/env node
// groundtruth CLI — the gate from a shell, for the agents and scripts that do not write JS.
// After "it went in", hand groundtruth a command that RE-FETCHES the real state and let it
// decide; exit non-zero when nothing is behind the claim. The raw probe output is always
// printed as the evidence, so what you read is never something this invented.
//
//   groundtruth verify --probe "<shell command that re-fetches real state>" <expectation>
//     the expectation, one of:
//       --nonempty            the output is not empty (the default)
//       --count N             the output, read as a number, equals N
//       --at-least N          the output, read as a number, is at least N
//       --contains STR        the output contains STR
//       --equals STR          the output, trimmed, equals STR
//       --matches REGEX       the output matches a regular expression
//     --json                  print the Verdict as JSON
//   exit: 0=verified / 1=empty or mismatched / 3=the probe itself failed (non-zero command)
//
//   groundtruth guard <contracts.jsonl>
//     One contract per line: {action, probe, expect:{type,value}}. Every one is re-fetched.
//     A single unmet contract exits 2 — the shape a Claude Code Stop hook blocks on.
//
// No LLM and no API key at runtime. Zero dependencies.

import { readFileSync } from 'node:fs';
import { verify, expect as X } from './index.mjs';
import { shellProbe, expectFromSpec } from './contract.mjs';

// Read from package.json. Held as a constant, this CLI once answered with a number one release
// out of date — the thing reflint 0.10.0's CHANGELOG names. A constant is a place a person has
// to remember at every release, and nothing goes red when they do not.
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return 'unknown';
  }
})();

function parse(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out.flags[key] = next; i++; }
      else out.flags[key] = true;
    } else out._.push(a);
  }
  return out;
}

// The flags verify accepts. Anything absent from this set is a usage error, not something to
// pass over in silence.
const VERIFY_FLAGS = new Set(['probe', 'action', 'json', 'nonempty', 'count', 'at-least', 'contains', 'equals', 'matches']);

/** Die on a usage error. A gate running on a guess about what was meant stops nothing. */
function usage(msg) {
  process.stderr.write(`groundtruth: ${msg}\n`);
  process.exit(64);
}

/**
 * Refuse a flag this command does not know.
 *
 * `--bogus value` matched no expectation and fell through to the default, nonempty. One typo in
 * a CI file and a gate written to mean `--count 45` quietly becomes "anything that printed
 * something passes". It is the shape reflint 0.10.0 closed: a plausible-but-wrong flag that
 * silences a check, and stays green, is the defect that survives longest.
 */
function rejectUnknownFlags(flags, known, cmd) {
  const bad = Object.keys(flags).filter((k) => !known.has(k));
  if (bad.length > 0) usage(`unknown option${bad.length === 1 ? '' : 's'} for ${cmd}: ${bad.map((b) => `--${b}`).join(', ')}`);
}

/** A flag that needs a value must have one. Bare `--count` used to come out as Number(true)===1. */
function flagValue(flags, key) {
  const v = flags[key];
  if (v === true) usage(`--${key} needs a value`);
  return String(v);
}

/** A count threshold. NaN and negatives compare fine and cannot be what anybody meant. */
function threshold(flags, key) {
  const raw = flagValue(flags, key);
  const n = Number(raw);
  if (!Number.isFinite(n)) usage(`--${key} needs a number, got "${raw}"`);
  if (n < 0) usage(`--${key} cannot be negative, got ${n}`);
  return n;
}

// Pick one expect function from the flags. The label belongs to the function itself and is not
// assembled here, so what the CLI prints and what --json reports as verdict.expectation cannot
// disagree. With no expectation flag at all, no expect is passed — that is how verify is told
// "nobody asked a question", and the verdict then names itself nonEmpty (default).
function pickExpect(flags) {
  if ('count' in flags) return X.count(threshold(flags, 'count'));
  if ('at-least' in flags) return X.atLeast(threshold(flags, 'at-least'));
  if ('contains' in flags) return X.contains(flagValue(flags, 'contains'));
  if ('equals' in flags) return X.equals(flagValue(flags, 'equals'));
  if ('matches' in flags) return X.matches(new RegExp(flagValue(flags, 'matches')));
  return undefined;
}

async function cmdVerify(p) {
  rejectUnknownFlags(p.flags, VERIFY_FLAGS, 'verify');
  const cmd = p.flags.probe;
  if (!cmd || cmd === true) {
    process.stderr.write('groundtruth verify: --probe "<command that re-fetches real state>" is required\n');
    process.exit(64);
  }
  const fn = pickExpect(p.flags);
  const action = p.flags.action ? String(p.flags.action) : cmd;
  const v = await verify({ action, probe: shellProbe(String(cmd)), expect: fn });
  const label = v.expectation;

  if (p.flags.json) {
    const { error, ...rest } = v;
    process.stdout.write(JSON.stringify(error ? { ...rest, error: String(error.message || error) } : rest) + '\n');
  } else if (v.ok) {
    // With no expectation chosen, what was not asked matters more than the pass.
    const weak = !fn ? '\n  Note: no expectation was given, so any non-empty output passes. Pass --count/--contains/--matches to ask a real question.' : '';
    process.stdout.write(`✓ verified [${label}] — the probe returned: ${v.evidence}${weak}\n`);
  } else if (v.reason === 'probe-error') {
    process.stderr.write(`✗ probe failed — ${v.evidence}\n  Real state could not be read, so this cannot be reported as done.\n`);
  } else {
    process.stderr.write(`✗ ${v.reason} [${label}]${v.detail ? ' — ' + v.detail : ''}\n  the probe returned: ${v.evidence}\n`);
  }

  if (v.ok) process.exit(0);
  process.exit(v.reason === 'probe-error' ? 3 : 1);
}

async function cmdGuard(p) {
  const file = p._[0];
  if (!file) { process.stderr.write('groundtruth guard <contracts.jsonl> is required\n'); process.exit(64); }
  let lines;
  try {
    lines = readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  } catch (e) {
    process.stderr.write(`groundtruth guard: cannot read ${file}: ${e.message}\n`);
    process.exit(64);
  }
  // A file holding no contracts is not "everything confirmed". An empty file, a file of
  // whitespace and a file nothing had written yet all exited 0. Reporting "nothing was checked"
  // as "checked" is the exact shape this gate exists to prevent.
  if (lines.length === 0) {
    process.stderr.write(
      `✗ groundtruth guard: ${file} holds no contracts — nothing was checked, so nothing can be reported as done.\n` +
        '  Write one contract per line, or do not run the gate at all.\n',
    );
    process.exit(2);
  }
  const failures = [];
  let weakOnly = 0; // how many contracts asked only for non-empty output
  for (const line of lines) {
    let c;
    try { c = JSON.parse(line); } catch { failures.push({ action: line.slice(0, 40), reason: 'bad-json', evidence: line }); continue; }
    if (!c.probe) { failures.push({ action: c.action || '(no action)', reason: 'no-probe', evidence: '' }); continue; }
    let expectFn;
    try { expectFn = expectFromSpec(c.expect); } catch (e) {
      failures.push({ action: c.action || '(no action)', reason: 'bad-expect', detail: e.message, evidence: '' });
      continue;
    }
    if (expectFn.groundtruthLabel === 'nonEmpty') weakOnly++;
    const v = await verify({ action: c.action || c.probe, probe: shellProbe(String(c.probe)), expect: expectFn });
    if (!v.ok) failures.push(v);
  }
  // Do not flatten what "all confirmed" contains. A nonempty-only contract established that
  // something printed and nothing more, so the count of those is said out loud.
  const weakNote = weakOnly
    ? ` (${weakOnly} of them only asked for non-empty output — that confirms something ran, not that it was right)`
    : '';
  if (failures.length === 0) {
    process.stderr.write(`✓ groundtruth guard: all ${lines.length} contract${lines.length === 1 ? '' : 's'} confirmed against real state${weakNote}\n`);
    process.exit(0);
  }
  process.stderr.write(`✗ groundtruth guard: ${failures.length}/${lines.length} contracts unmet — blocking completion${weakNote}\n`);
  for (const f of failures) {
    const x = f.expectation ? ` [${f.expectation}]` : '';
    process.stderr.write(`  - "${f.action}"${x} — ${f.reason}${f.detail ? ': ' + f.detail : ''}\n    the probe returned: ${f.evidence ?? ''}\n`);
  }
  process.exit(2); // Claude Code hook: exit 2 is what blocks the stop
}

const HELP = `groundtruth ${VERSION} — completion verification gate

  groundtruth verify --probe "<command that re-fetches real state>" [expectation]
    --nonempty | --count N | --at-least N | --contains STR | --equals STR | --matches REGEX
    --json
    exit 0=ok / 1=empty or mismatched / 3=probe failed

  groundtruth guard <contracts.jsonl>
    One contract per line: {action, probe, expect:{type,value}}. Re-fetches every
    one of them; exits 2 if any is unmet.

  What this buys: an empty result, a probe error and a mismatch are all refused,
  and the evidence printed is what the probe returned — never something invented.

  What it does not buy: whether the probe read the world at all. A probe is a
  command, and nothing here can make one do I/O — \`--probe "echo 45" --count 45\`
  passes. The separation is yours to keep; point it at the thing that reads the
  actual state.
`;

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') { process.stdout.write(HELP); process.exit(0); }
  if (argv[0] === '--version' || argv[0] === '-v') { process.stdout.write(VERSION + '\n'); process.exit(0); }
  const sub = argv[0];
  const p = parse(argv.slice(1));
  if (sub === 'verify') return cmdVerify(p);
  if (sub === 'guard') return cmdGuard(p);
  process.stderr.write(`groundtruth: unknown subcommand "${sub}"\n\n${HELP}`);
  process.exit(64);
}

main().catch((e) => { process.stderr.write(`groundtruth: ${e && e.message ? e.message : e}\n`); process.exit(70); });
