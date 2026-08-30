/**
 * habit doctor — what the store actually contains.
 *
 * habit is a pile of couplings to fields another program decides to send. When one of them
 * stops arriving, nothing breaks: the hook still runs, still exits 0, still writes a record.
 * It just writes a record with a hole in it, and the tool gets quietly worse at its job. A
 * crash announces itself; this does not.
 *
 * So this command reports what has been observed rather than what is expected. "34 failures
 * recorded, 0 carried an error" is not something that can be reasoned to from the source —
 * the source looks correct. It can only be counted. Everything here is a pure read; doctor
 * never records anything, which is what lets it be run on a hunch.
 */
import { existsSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { listCorrections, listSignals, listArtifacts, loadRules, STORE } from './habit.mjs';

const kb = (n) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`);

const pct = (n, d) => (d ? `${n}/${d}` : '0/0');

/** n out of d, with a verdict when the field has never once arrived. */
function coupling(label, n, d, { owner, meaning }) {
  const line = `  ${label.padEnd(34)} ${pct(n, d)}`;
  if (d === 0) return `${line}   (nothing recorded yet)`;
  if (n === 0) return `${line}   DEAD — ${meaning} [${owner}]`;
  if (n < d) return `${line}   partial`;
  return line;
}

function top(items, n = 5) {
  return [...items.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

export function doctor() {
  const out = [];
  const corrections = listCorrections();
  const signals = listSignals();
  const artifacts = listArtifacts();
  const rules = loadRules();

  out.push(`habit store: ${STORE}`);
  out.push(`  ${artifacts.length} artifact(s), ${corrections.length} correction(s), ${signals.length} signal(s)`);

  // The stored bodies are the only thing here that grows without bound, so they get a number.
  const bodies = artifacts.filter((a) => typeof a.text === 'string');
  const bodyBytes = bodies.reduce((n, a) => n + Buffer.byteLength(a.text), 0);
  const orphaned = bodies.filter((a) => !a.file || !existsSync(a.file)).length;
  if (bodies.length) {
    out.push(`  ${bodies.length} of them keep a file body — ${kb(bodyBytes)} in total`);
    if (orphaned) out.push(`  ${orphaned} body/bodies belong to files that no longer exist — see \`habit prune\``);
  }
  out.push('');

  // ---- what the hooks are actually capturing ----
  const failures = signals.filter((s) => s.kind === 'failure');
  const denials = signals.filter((s) => s.kind === 'denial');
  const instructed = corrections.filter((c) => c.kind === 'instructed');

  out.push('Fields the hooks depend on, as actually delivered:');
  out.push(coupling('artifacts carry prompt_id', artifacts.filter((a) => a.promptId).length, artifacts.length, {
    owner: 'harness',
    meaning: 'hookPre cannot tell a human edit from the agent\'s own script',
  }));
  out.push(coupling('corrections carry prompt_id', corrections.filter((c) => c.promptId).length, corrections.length, {
    owner: 'habit — fixed in 0.3.0, older records stay anonymous',
    meaning: 'two corrections from one sentence still count as two observations',
  }));
  out.push(coupling('instructed ones carry askedFor', instructed.filter((c) => c.askedFor).length, instructed.length, {
    owner: 'harness (transcript_path)',
    meaning: 'the reason in the user\'s own words is being lost; only the diff survives',
  }));
  out.push(coupling('failures carry an error', failures.filter((s) => s.error).length, failures.length, {
    owner: 'harness',
    meaning: 'a failure signal records that something failed and nothing about what',
  }));
  out.push(coupling('denials carry a summary', denials.filter((s) => s.summary).length, denials.length, {
    owner: 'harness',
    meaning: 'a blocked call is recorded with nothing to identify it',
  }));
  out.push(coupling('denials carry a reason', denials.filter((s) => s.reason).length, denials.length, {
    owner: 'habit — captured from 0.3.0, older denials have none',
    meaning: 'only the command shape survives, so which objection it was is lost',
  }));

  // Text dropped on the way in because it looked like a credential. Worth showing: it is the
  // one place habit silently keeps less than it could, and a run of these means someone is
  // typing secrets into the chat.
  const saidHeld = corrections.filter((c) => c.askedForWithheld).length;
  const errHeld = signals.filter((s) => s.errorWithheld).length;
  const rsnHeld = signals.filter((s) => s.reasonWithheld).length;
  if (saidHeld || errHeld || rsnHeld) {
    out.push('');
    out.push('Withheld as credential-shaped (the diff was kept either way):');
    if (saidHeld) out.push(`  ${saidHeld} sentence(s) the user typed`);
    if (errHeld) out.push(`  ${errHeld} failure message(s)`);
    if (rsnHeld) out.push(`  ${rsnHeld} denial reason(s)`);
  }

  const keys = new Set();
  for (const s of signals) for (const k of s.payloadKeys || []) keys.add(k);
  if (keys.size) {
    out.push('');
    out.push(`  signal payloads have carried: ${[...keys].sort().join(', ')}`);
    out.push('  (names only. If the error text is in one of these, that is the field to read.)');
  } else if (failures.length) {
    out.push('');
    out.push('  no signal records the payload shape yet — those predate 0.3.0. The next few will.');
  }
  out.push('');

  // ---- corrections ----
  if (corrections.length) {
    const kinds = new Map();
    const files = new Map();
    const dirs = new Map();
    for (const c of corrections) {
      const k = c.kind || 'edited';
      kinds.set(k, (kinds.get(k) || 0) + 1);
      const f = basename(c.file || '');
      files.set(f, (files.get(f) || 0) + 1);
      const d = basename(dirname(c.file || ''));
      if (d) dirs.set(d, (dirs.get(d) || 0) + 1);
    }
    const dates = corrections.map((c) => c.detectedAt).filter(Boolean).sort();
    out.push(`Corrections — ${[...kinds].map(([k, n]) => `${k} ${n}`).join(', ')}`);
    if (dates.length) out.push(`  from ${dates[0].slice(0, 10)} to ${dates.at(-1).slice(0, 10)}`);
    out.push(`  corrected most: ${top(files).map(([f, n]) => `${f} (${n})`).join(', ')}`);
    out.push(`  spread over ${dirs.size} folder(s): ${top(dirs, 3).map(([d, n]) => `${d} (${n})`).join(', ')}`);
    out.push('');
  }

  // ---- has any of it become anything ----
  const cited = new Set();
  for (const r of rules) for (const e of r.evidence || []) cited.add(e);
  const pending = corrections.filter((c) => !cited.has(c.id)).length;

  out.push('Distillation:');
  if (!rules.length) {
    out.push(`  no rules written yet — ${pending} correction(s) are waiting`);
    out.push('  Corrections only become rules when the habit-learn skill is run. Nothing runs it');
    out.push('  on its own; from 0.3.0 the session-start hook raises it once the pile is deep enough.');
  } else {
    out.push(`  ${rules.length} rule(s) in force, ${pending} correction(s) not yet distilled`);
  }
  out.push(`  ledger: ${existsSync(`${STORE}/ledger.json`) ? 'present — run `habit score`' : 'absent (no rule has ever been proposed)'}`);

  return out.join('\n');
}
