#!/usr/bin/env node
/**
 * habit — 習い ("the ways one picks up by repetition")
 *
 * Makes a coding agent aware that its output was corrected.
 *
 *   PostToolUse : record what I just wrote. Also notice when I am rewriting my own
 *                 output from an earlier turn — that means the user told me to.
 *   PreToolUse  : before writing the same file again, compare against what is on disk.
 *                 Different? A human edited it. Hand the diff back as context.
 *
 * Two purposes. Stop the agent from silently reverting a correction, and accumulate
 * those corrections — enough of them are simply how this person works.
 *
 * This file is the package entry point and the commands a person types. The parts underneath:
 *
 *   store    where things are kept, and how a path becomes a key
 *   diff     two versions of a file in, the changed lines out — the one pure module
 *   record   the three things written down, and every view that reads them back
 *   hooks    the four places habit is handed control, and what it says back
 *   secrets  what may be written down at all, in one auditable file
 *
 * Everything above is re-exported from here, because @hyuga/habit's public API is what a
 * consumer imports from this path. Moving a function into another file must not move it out of
 * the package.
 */
import { writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

export {
  NEVER_STORE, CREDENTIAL_NAME, SECRET_TEXT, namedForCredential,
  looksSecret, mayStoreBody, isGitIgnored,
} from './secrets.mjs';
export { STORE, readStdin, filePathOf } from './store.mjs';
export { lineDiff, storableLines, formatDiff } from './diff.mjs';
export {
  recordCorrection, listCorrections, buildExport, recordSignal, listSignals,
  summarizeToolInput, freeText, errorTextOf, reasonOf,
  artifactsDir, listArtifacts, loadRules, MAX_RULE,
} from './record.mjs';
export {
  hookSync, hookPost, hookPre, hookSubagent, hookSession,
  lastUserMessage, undistilled, distillNudge,
} from './hooks.mjs';

import { STORE, RULES, SAID, ensure, nowIso, readStdin } from './store.mjs';
import { buildExport, listCorrections, listSignals, recordSignal } from './record.mjs';
import { hookSync, hookPost, hookPre, hookSubagent, hookSession } from './hooks.mjs';

function cmdExport(args) {
  let as = null;
  let out = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--as') as = args[++i];
    else if (args[i] === '--out') out = args[++i];
  }
  const bundle = buildExport({ as });
  const target = out || join(process.cwd(), `habit-${bundle.who}.json`);
  writeFileSync(target, JSON.stringify(bundle, null, 1), 'utf8');
  console.log(`habit: ${bundle.count} correction(s) written to ${target}`);
  console.log('  included: changed lines, what you asked for, the file name');
  console.log('  excluded: the folder path, the file contents, anything git ignores');
  // The changed lines are your code. Whatever was on those lines is in the file.
  console.log('  open it before you hand it over — the changed lines are still your text');
  return 0;
}


// ---------------- reading the corrections back, for the learn skill ----------------

/**
 * `habit corpus`   — print the corrections in a fixed layout, for an agent to read.
 * `habit validate` — check a rules file against the corrections actually on disk.
 *
 * The second one is the point. An agent told to "cite at least two corrections" will
 * usually do it, and the times it does not are exactly the times the rule was invented.
 * So the ids are checked here, and a file with an unsupported rule exits non-zero.
 */
function cmdLearn(cmd, args) {
  // Returns a promise. main() hands it up, and the entry point waits for it — calling
  // process.exit() on a pending import would kill the command mid-flight.
  return import('./learn.mjs').then(({ buildCorpus, validate, propose }) => {
    const corrections = listCorrections();
    const signals = listSignals();

    if (cmd === 'corpus') {
      if (corrections.length === 0 && signals.length === 0) {
        console.log('habit: nothing recorded yet. Use the agent for a while first.');
        return 0;
      }
      console.log(`# ${corrections.length} correction(s)\n`);
      console.log(buildCorpus(corrections, { signals }));
      return 0;
    }

    const file = args.find((a) => !a.startsWith('--'));
    if (!file) {
      console.error('habit validate <rules.json> [--save]');
      return 2;
    }
    let obj;
    try {
      obj = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      console.error(`habit: cannot read ${file} — ${e.message}`);
      return 2;
    }

    const { rules, skipped, dropped } = validate(obj, corrections, signals);
    for (const d of dropped) {
      console.error(`  dropped: ${d.reason} (cited ${d.cited}, ${d.real} real) — ${d.rule}`);
    }
    console.log(`habit: ${rules.length} rule(s) kept, ${dropped.length} dropped`);

    if (dropped.length) {
      console.error('habit: fix the evidence and run again. Nothing was saved.');
      return 1;
    }

    if (args.includes('--save')) {
      ensure(STORE);
      writeFileSync(RULES(), JSON.stringify({ rules, skipped }, null, 2), 'utf8');
      const l = propose(rules, nowIso(), corrections);
      const fresh = l.proposals.slice(-rules.length);
      const scorable = fresh.filter((p) => p.scorable).length;
      console.log(`habit: saved to ${RULES()} and recorded in the ledger`);
      console.log(`  ${scorable} of ${rules.length} can be scored later; the rest share no repeated line to watch for`);
      // The pile has been distilled, so the nudge starts over from here.
      try {
        if (existsSync(SAID())) writeFileSync(SAID(), JSON.stringify({}), 'utf8');
      } catch { /* the nudge is not worth failing a save over */ }
    }
    return 0;
  }).catch((e) => {
    console.error(`habit: ${e.message}`);
    return 1;
  });
}

/**
 * `habit score`  — how the rules that were written have actually done.
 * `habit accept` / `habit reject` — whether a proposal was adopted.
 *
 * All three write ledger.json, and nothing else does. Keeping the only writer on the
 * command side means no hook can ever lose a write to it, or be delayed by one.
 */
function cmdLedger(cmd, args) {
  return import('./learn.mjs').then(({ score, setAccepted }) => {
    if (cmd === 'accept' || cmd === 'reject') {
      const id = args.find((a) => !a.startsWith('--'));
      if (!id) {
        console.error(`habit ${cmd} <proposal-id>   (see habit score)`);
        return 2;
      }
      const p = setAccepted(id, cmd === 'accept');
      if (!p) {
        console.error(`habit: no proposal matching ${id}`);
        return 1;
      }
      console.log(`habit: ${cmd}ed — ${p.rule}`);
      return 0;
    }

    const s = score(listCorrections());
    if (!s.proposed) {
      console.log('habit: no rules have been proposed yet, so there is nothing to score.');
      console.log('Run the habit-learn skill first — it writes rules and records them here.');
      return 0;
    }

    console.log(`habit: ${s.proposed} proposal(s) — ${s.scorable} scorable, ${s.unscorable} unscorable`);
    console.log(`${s.recurrences} correction(s) of a kind a rule was meant to stop have arrived since.\n`);

    for (const r of s.rows) {
      const state = r.accepted === true ? 'accepted' : r.accepted === false ? 'rejected' : 'undecided';
      console.log(`${r.id}  [${state}]  ${r.rule}`);
      if (!r.scorable) {
        console.log('    unscorable — the corrections behind it share no repeated line, so a');
        console.log('    recurrence cannot be recognised. It still applies; it just cannot be graded.');
        continue;
      }
      console.log(`    watching for: ${r.marker}`);
      if (!r.recurrences.length) {
        console.log(`    no recurrence since ${r.proposedAt.slice(0, 10)}`);
      } else {
        for (const h of r.recurrences) console.log(`    recurred ${h.at.slice(0, 10)}  ${h.id}`);
      }
    }

    console.log('\nNo hit rate is printed, on purpose. A rule with no recurrence may be working,');
    console.log('or the situation may simply not have come up — nothing here can tell those apart.');
    if (existsSync(RULES())) {
      console.log('These rules are also injected at session start, so habit is treating the very');
      console.log('behaviour it is measuring. Read the rows, not a score.');
    }
    return 0;
  }).catch((e) => {
    console.error(`habit: ${e.message}`);
    return 1;
  });
}


// ---------------- CLI ----------------

function emit(eventName, context) {
  if (!context) return;
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext: context } }),
  );
}

function cmdLog(argv) {
  const all = listCorrections();
  if (all.length === 0) {
    console.log('habit: nothing recorded yet.');
    console.log('Install the hooks, then edit a file the agent wrote — that is what gets recorded.');
    return 0;
  }
  const n = parseInt(argv.find((a) => /^\d+$/.test(a)) || '20', 10);
  const recent = all.slice(-n);
  console.log(`habit: ${all.length} hand-edit(s) recorded (showing the last ${recent.length})\n`);
  for (const c of recent) {
    const when = c.detectedAt.slice(0, 16).replace('T', ' ');
    console.log(`${when}  ${basename(c.file)}  (−${c.removedCount} +${c.addedCount})`);
    for (const l of c.removed.slice(0, 2)) console.log('    − ' + l.trim().slice(0, 100));
    for (const l of c.added.slice(0, 2)) console.log('    + ' + l.trim().slice(0, 100));
  }
  console.log('');
  const byFile = {};
  for (const c of all) byFile[basename(c.file)] = (byFile[basename(c.file)] || 0) + 1;
  const top = Object.entries(byFile).sort((a, b) => b[1] - a[1]).slice(0, 5);
  console.log('Corrected most often:');
  for (const [f, n2] of top) console.log(`  ${String(n2).padStart(3)}x  ${f}`);
  return 0;
}

export function main(argv) {
  const [cmd, sub] = argv;

  if (cmd === 'hook') {
    const raw = readStdin();
    if (!raw.trim()) return 0;
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return 0;
    }
    try {
      if (sub === 'post') hookPost(payload);
      else if (sub === 'sync') hookSync(payload);
      else if (sub === 'pre') emit('PreToolUse', hookPre(payload));
      else if (sub === 'denied') recordSignal('denial', payload);
      else if (sub === 'failed') recordSignal('failure', payload);
      else if (sub === 'subagent') emit('SubagentStart', hookSubagent());
      else if (sub === 'session') emit('SessionStart', hookSession());
    } catch {
      // a hook must never interrupt the user's work
    }
    return 0;
  }

  if (cmd === 'log') return cmdLog(argv.slice(1));

  if (cmd === 'export') return cmdExport(argv.slice(1));

  // corpus / validate / score load learn.mjs, and doctor loads doctor.mjs — none of which
  // the hooks ever touch. Kept behind dynamic imports so the hot path stays one file.
  if (cmd === 'corpus' || cmd === 'validate') return cmdLearn(cmd, argv.slice(1));

  if (cmd === 'score' || cmd === 'accept' || cmd === 'reject') return cmdLedger(cmd, argv.slice(1));

  if (cmd === 'doctor') {
    return import('./doctor.mjs')
      .then(({ doctor }) => {
        console.log(doctor());
        return 0;
      })
      .catch((e) => {
        console.error(`habit: ${e.message}`);
        return 1;
      });
  }

  if (cmd === 'prune') {
    const args = argv.slice(1);
    const di = args.indexOf('--days');
    const days = di >= 0 ? Number.parseInt(args[di + 1], 10) : 30;
    if (!Number.isFinite(days) || days < 0) {
      console.error('habit prune [--days N] [--apply]');
      return 2;
    }
    return import('./prune.mjs')
      .then(({ prune, report }) => {
        console.log(report(prune({ days, apply: args.includes('--apply') }), { days }));
        return 0;
      })
      .catch((e) => {
        console.error(`habit: ${e.message}`);
        return 1;
      });
  }

  if (cmd === 'where') {
    console.log(STORE);
    return 0;
  }

  console.log(`habit — tells the agent when you edited what it wrote

  habit log [n]     show the hand-edits it has recorded (default 20)
  habit doctor      what the store actually contains, and which couplings have gone quiet
  habit prune [--days N] [--apply]
                    drop stored file bodies whose file is gone or untouched for N days
                    (default 30). The hash stays, so edits are still detected. Dry run
                    unless --apply.
  habit export      write a bundle to hand over: changed lines only, no paths, no file bodies
                      --as <name>   label the bundle (default: a hash of the hostname)
                      --out <file>  where to write it
  habit corpus      print the corrections, laid out for reading
  habit validate <rules.json> [--save]
                    check a rules file against the corrections on disk. A rule citing
                    fewer than two real ones is dropped and the command exits 1.
  habit score       how the rules that were written have actually done since
  habit accept <id> | habit reject <id>
                    record whether a proposal was adopted (ids come from habit score)
  habit where       print the store location

  Turning corrections into rules is the habit-learn skill's job — no API key involved.

  Install as hooks, in your Claude Code settings.json. The first three are the product; the
  rest are what makes it learn rather than only warn:

    "PostToolUse":       [{ "matcher": "Write|Edit", "hooks": [
      { "type": "command", "command": "npx @hyuga/habit hook post", "timeout": 10 }]},
                          { "hooks": [
      { "type": "command", "command": "npx @hyuga/habit hook sync", "timeout": 10 }]}],
    "PreToolUse":        [{ "matcher": "Write|Edit", "hooks": [
      { "type": "command", "command": "npx @hyuga/habit hook pre",  "timeout": 10 }]}],

  The unmatched "hook sync" is not optional. Without it, an agent that edits a file
  through the shell instead of Write is reported to itself as the user editing by
  hand — and filed as a correction you never made.
    "SessionStart":      [{ "hooks": [
      { "type": "command", "command": "npx @hyuga/habit hook session", "timeout": 10 }]}],
    "SubagentStart":     [{ "hooks": [
      { "type": "command", "command": "npx @hyuga/habit hook subagent", "timeout": 10 }]}],
    "PermissionDenied":  [{ "hooks": [
      { "type": "command", "command": "npx @hyuga/habit hook denied", "timeout": 10 }]}],
    "PostToolUseFailure":[{ "hooks": [
      { "type": "command", "command": "npx @hyuga/habit hook failed", "timeout": 10 }]}]

  Set HABIT_HASH_ONLY=1 to never store file contents.
  Set HABIT_NO_PROMPTS=1 to keep the diffs but not what you said.
`);
  return 0;
}

/**
 * Was this run directly, or imported?
 *
 * argv[1] is the path as invoked, and both `npm i -g` and `npx` put a symlink
 * there. import.meta.url is the resolved real path, so the two never matched for
 * an installed copy and this did nothing at all: exit 0, no output. Every hook in
 * the README is spelled `npx @hyuga/habit hook ...`, so the product was inert
 * wherever it was actually installed — and a hook that returns 0 without speaking
 * is indistinguishable from one with nothing to say. Resolve the link first.
 */
function runDirectly() {
  const arg = process.argv[1];
  if (!arg) return false;
  if (import.meta.url === pathToFileURL(arg).href) return true;
  try {
    return import.meta.url === pathToFileURL(realpathSync(arg)).href;
  } catch {
    return false;
  }
}

if (runDirectly()) {
  const result = main(process.argv.slice(2));
  // corpus / validate settle asynchronously; the rest return a number straight away.
  if (result && typeof result.then === 'function') result.then((code) => process.exit(code ?? 0));
  else process.exit(result);
}
