#!/usr/bin/env node
/**
 * yubisashi — 指差 ("point at it, and say what it is, before you move")
 *
 * The part that runs before a write, on the spar frame.
 *
 * groundtruth is the gate at the end: nothing gets to report done until a probe has re-fetched
 * the world and the reading matches the contract. This is the same contract, pulled forward.
 * Before the call that would change the world, yubisashi runs the probe once and files what it
 * returned — the reading before the write. Declared once, checked twice.
 *
 * Japanese railways call the ritual 指差喚呼: point at the signal, say its state out loud, then
 * move. The pointing is what makes a wrong target visible before the train does. Here the
 * finger is the probe and the call is the expectation, and both are the line groundtruth will
 * read back at the end.
 *
 * What it catches, in the order it happened on the machine that built it:
 *
 *   1. a probe that does not run. Four of the last five unmet contracts here were not failed
 *      work; they were probes that could not be run, discovered at the end, after the write,
 *      where the fix is the most expensive
 *   2. a contract that is already true. An expectation the world meets before the write
 *      confirms nothing about the write
 *   3. a write with nothing pointed at. The contract was going to be written afterwards, from
 *      memory of what was meant
 *
 * What counts as a write is redline's tariff — irreversible, outward, production. One list of
 * things worth pointing at, kept in one place.
 */
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { finding, report, ledger, sortie, root, quote } from '@hyuga/spar';
import { runDirectly, readStdin } from '@hyuga/spar/cli';
import { price } from '@hyuga/redline';
import { expectationLabel } from '@hyuga/groundtruth';
import { expectFromSpec } from '@hyuga/groundtruth/contract';

/** The charges that have to be pointed at first. A dependency is not one: nothing it changes is out of reach. */
export const POINTED_AT = ['irreversible', 'outward', 'production'];

/**
 * How long one probe gets, and how long one call gets.
 *
 * groundtruth gives a probe as long as the Stop hook allows, which is a minute. A PreToolUse
 * hook has ten seconds for everything, and a probe that cannot answer inside a few of them is
 * not one to build a gate on. It is reported as failing to run — which is what just happened —
 * and the pilot decides whether the probe or the clock is the thing to change.
 */
export const PROBE_TIMEOUT_MS = 4000;
export const CALL_BUDGET_MS = 8000;

const TOOLS = /^(Bash|Write|Edit|MultiEdit|NotebookEdit)$/;

/**
 * Where the contracts are.
 *
 * groundtruth's own hook reads `.groundtruth/pending.jsonl` under the session root, or
 * wherever GROUNDTRUTH_PENDING says. A gate wired by hand may keep one file per session under
 * `~/.claude/groundtruth` instead. Both are read when both exist: the finger has to find the
 * same lines groundtruth will, and choosing one convention here would leave the other pointed
 * at nothing.
 */
export function pendingFiles(payload = {}, cwd = root()) {
  if (process.env.GROUNDTRUTH_PENDING) return [resolve(process.env.GROUNDTRUTH_PENDING)];
  const out = [join(resolve(cwd), '.groundtruth', 'pending.jsonl')];
  const sid = String(payload.session_id || '');
  if (/^[A-Za-z0-9._-]{1,128}$/.test(sid)) {
    out.push(join(homedir(), '.claude', 'groundtruth', `${sid}.jsonl`));
  }
  return out;
}

/** The contract lines in these files, each with a key that is the line itself. */
export function contractsIn(files) {
  const out = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
      out.push({ file, line, key: createHash('sha1').update(line).digest('hex').slice(0, 12) });
    }
  }
  return out;
}

export const contracts = (payload, cwd = root()) => contractsIn(pendingFiles(payload, cwd));

/** Run one probe, once, with a clock on it. The same shell groundtruth will use at the end. */
export function probe(cmd, timeout = PROBE_TIMEOUT_MS) {
  const r = spawnSync(String(cmd), { shell: true, encoding: 'utf8', timeout, windowsHide: true });
  if (r.error) {
    if (r.error.code === 'ETIMEDOUT') return { error: `took longer than ${timeout}ms` };
    return { error: r.error.message };
  }
  if (typeof r.status === 'number' && r.status !== 0) {
    const err = (r.stderr || '').trim().replace(/\s+/g, ' ').slice(0, 200);
    return { error: `exit ${r.status}${err ? `: ${err}` : ''}` };
  }
  return { state: (r.stdout ?? '').trim() };
}

/**
 * Point at one contract: read the line, run the probe, say what is there now.
 *
 *   bad-json / no-probe / bad-expect   the line is not a contract groundtruth could read either
 *   probe-error                        the finger found nothing — the command does not run
 *   already-met                        the expectation is true before the write; it confirms nothing
 *   (none)                             a real target, not yet in the state the write should leave it
 *
 * The built-in expectations are synchronous, and those are the only ones a JSONL line can
 * name, so the check is too.
 */
export function point(c) {
  let spec;
  try { spec = JSON.parse(c.line); } catch {
    return { ...c, action: c.line.slice(0, 60), reason: 'bad-json', detail: 'the line is not JSON' };
  }
  const action = String(spec.action || spec.probe || '(no action)');
  if (!spec.probe) return { ...c, action, reason: 'no-probe', detail: 'the contract names no probe' };
  let expect;
  try { expect = expectFromSpec(spec.expect); } catch (e) {
    return { ...c, action, reason: 'bad-expect', detail: e.message };
  }
  const expectation = expectationLabel({ expect });
  const r = probe(spec.probe);
  if (r.error) return { ...c, action, expectation, reason: 'probe-error', detail: r.error };
  let res;
  try { res = expect(r.state); } catch (e) {
    return { ...c, action, expectation, before: r.state, reason: 'probe-error', detail: e.message };
  }
  const met = res === true || (res && typeof res === 'object' && res.ok === true);
  return { ...c, action, expectation, before: r.state, met, reason: met ? 'already-met' : null };
}

const BROKEN = ['bad-json', 'no-probe', 'bad-expect', 'probe-error'];

function file(p, cwd) {
  const severity = p.reason === 'already-met' ? 'warn' : p.reason ? 'stop' : 'note';
  const observed = { key: p.key };
  if (p.before !== undefined) observed.before = quote(p.before);
  if (p.met !== undefined) observed.met = p.met;
  if (p.reason) observed.reason = p.reason;
  return report(finding({
    phase: 'pre',
    source: 'yubisashi',
    severity,
    subject: p.action,
    observed,
    expected: p.expectation,
    note: p.detail,
  }), cwd);
}

/**
 * What this sortie has already pointed at, by contract key.
 *
 * A contract is pointed once, when it is first seen before a write — not before every write.
 * You point at the signal and go; you do not point at it again at every sleeper. Pointing
 * again would also re-run every probe on every call, which is a cost the ten-second hook
 * budget cannot carry.
 */
function pointed(cwd) {
  const s = sortie(cwd);
  const out = new Map();
  for (const f of ledger(cwd)) {
    if (f.source !== 'yubisashi' || f.phase !== 'pre' || f.sortie !== s.id) continue;
    if (f.observed && f.observed.key) out.set(f.observed.key, f);
  }
  return out;
}

const said = (p) => {
  if (p.reason === 'already-met') {
    return `"${p.action}" is already true before you act [${p.expectation}] — the probe returned ${quote(p.before)}.\n`
      + '  A contract met before the write confirms nothing about the write. Point at something the write will change.';
  }
  return `"${p.action}" — the probe does not run: ${p.detail}\n`
    + '  A probe that fails now fails at the end too, after the write. Fix it here, where it is cheap.';
};

export function check(payload, cwd = root()) {
  const tool = payload.tool_name || payload.toolName || '';
  if (!TOOLS.test(tool)) return null;
  const s = sortie(cwd);
  if (s.mode === 'cruise') return null; // nothing polices a cruise, and a probe run for nobody is only a cost

  const kinds = [...new Set(price(payload, cwd).map((c) => c.kind).filter((k) => POINTED_AT.includes(k)))];
  if (!kinds.length) return null;

  const all = contracts(payload, cwd);
  const seen = pointed(cwd);
  const lines = [];
  let halt = false;
  let standing = 0; // contracts this sortie has pointed at something that runs
  const started = Date.now();

  for (const c of all) {
    let rec = seen.get(c.key);
    if (!rec) {
      if (Date.now() - started > CALL_BUDGET_MS) break; // the rest get pointed on the next call
      const p = point(c);
      const r = file(p, cwd);
      rec = r.record;
      seen.set(c.key, rec);
      if (r.show) lines.push(said(p));
      if (r.verdict === 'halt') halt = true;
    }
    if (!BROKEN.includes(rec.observed && rec.observed.reason)) standing += 1;
  }

  if (standing === 0) {
    const input = payload.tool_input || payload.toolInput || {};
    const on = String(input.file_path || input.path || input.notebook_path || input.command || tool).slice(0, 120);
    const r = report(finding({
      phase: 'pre',
      source: 'yubisashi',
      severity: 'stop',
      subject: on,
      observed: { kinds, contracts: all.length },
      note: all.length ? 'contracts pending, none that run' : 'no contract',
    }), cwd);
    if (r.show) {
      const files = pendingFiles(payload, cwd);
      const where = files.find((f) => existsSync(f)) || files[0];
      const why = all.length ? `${all.length} contract(s) pending, none that run` : 'no contract';
      lines.push(`about to ${kinds.join(' + ')} with nothing pointed at (${why}).\n`
        + '  Write the completion contract first — {"action":"…","probe":"<re-fetches real state>","expect":{"type":"…","value":"…"}}'
        + ` — into ${where}, then make the call. groundtruth reads the same line back at the end.`);
    }
    if (r.verdict === 'halt') halt = true;
  }

  if (!lines.length) return null;
  let message = `yubisashi: ${lines.join('\n')}`;
  if (halt) message += '\nNobody is in the seat, so this call is denied rather than advised.';
  return { verdict: halt ? 'halt' : 'advise', message };
}

// ---------------- CLI ----------------

/** Advice is context the model reads. A halt is the call being denied. Same envelope rule as redline. */
function emit(out) {
  if (!out) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: out.verdict === 'halt'
      ? { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: out.message }
      : { hookEventName: 'PreToolUse', additionalContext: out.message },
  }));
}

export function main(argv) {
  const [cmd, sub] = argv;

  if (cmd === 'hook') {
    const raw = readStdin();
    if (!raw.trim()) return 0;
    let payload;
    try { payload = JSON.parse(raw); } catch { return 0; }
    try {
      if (sub === 'pre') emit(check(payload));
    } catch {
      // a part that breaks the session is worse than no part
    }
    return 0;
  }

  if (cmd === 'point') {
    // By hand: point at every pending contract now and print the reading. Filed to the ledger
    // like the hook does, so a contract pointed here is not pointed again before the write.
    const list = sub ? contractsIn([resolve(sub)]) : contracts({});
    if (!list.length) {
      console.log(`yubisashi: nothing to point at — no contracts in ${sub ? resolve(sub) : pendingFiles({}).join(' or ')}`);
      return 1;
    }
    let broken = 0;
    for (const c of list) {
      const p = point(c);
      file(p, root());
      if (BROKEN.includes(p.reason)) {
        broken += 1;
        console.log(`✗ "${p.action}" — ${p.reason}: ${p.detail}`);
      } else if (p.reason === 'already-met') {
        console.log(`! "${p.action}" [${p.expectation}] already true — the probe returned ${quote(p.before)}`);
      } else {
        console.log(`→ "${p.action}" [${p.expectation}] — before: ${quote(p.before)}`);
      }
    }
    return broken ? 1 : 0;
  }

  console.log(`yubisashi — 指差. Point at it, and say what it is, before you move.

  yubisashi point [contracts.jsonl]
                       run every pending contract's probe now and print the reading before
                       the write. Exits 1 if any probe does not run.

  Install as a hook, in your Claude Code settings.json:

    "PreToolUse": [{ "hooks": [
      { "type": "command", "command": "npx @hyuga/yubisashi hook pre", "timeout": 10 }]}]

  Before a call redline would charge as irreversible, outward or production, it reads the
  completion contracts groundtruth will check at the end — .groundtruth/pending.jsonl, or
  GROUNDTRUTH_PENDING, or ~/.claude/groundtruth/<session_id>.jsonl — and points at each one
  it has not yet pointed at this sortie: the probe runs once, and what it returned is filed.

  It speaks only when the finger finds nothing: no contract, a probe that does not run, or
  an expectation that is already true. With nobody in the seat those deny the call.
`);
  return 0;
}

if (runDirectly(import.meta.url)) process.exit(main(process.argv.slice(2)));
