#!/usr/bin/env node
/**
 * narai — 習い ("the ways one picks up by repetition")
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
 */
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync,
  openSync, readSync, closeSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, basename, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir, hostname } from 'node:os';
import { pathToFileURL } from 'node:url';

export const STORE = process.env.NARAI_HOME || join(homedir(), '.claude', 'narai');
const ARTIFACTS = () => join(STORE, 'artifacts');
const CORRECTIONS = () => join(STORE, 'corrections');
const SIGNALS = () => join(STORE, 'signals');
const RULES = () => join(STORE, 'rules.json');

const MAX_BYTES = 512 * 1024; // above this, keep the hash but not the contents
const EDIT_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit)$/;

// Paths whose contents are never stored. It costs the diff, which is a far better trade
// than accumulating secrets on disk — detecting *that* something changed only needs the hash.
export const NEVER_STORE = [
  /(^|[/\\])\.env(\.|$)/i,
  /(^|[/\\])\.npmrc$/i,
  /(^|[/\\])\.netrc$/i,
  /(^|[/\\])id_(rsa|dsa|ecdsa|ed25519)/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /(secret|credential|password|token|apikey|api_key)/i,
];

/** May this file's contents be kept? When in doubt, no. */
export function mayStoreBody(file) {
  if (process.env.NARAI_HASH_ONLY === '1') return false;
  const p = resolve(file);
  if (NEVER_STORE.some((re) => re.test(p))) return false;
  return !isGitIgnored(p);
}

/**
 * A git-ignored file is usually machine-local config or build output, so its contents
 * are not kept (the hash still is). False when git is absent or this is not a repository.
 */
export function isGitIgnored(file) {
  try {
    execFileSync('git', ['check-ignore', '-q', '--', file], {
      cwd: dirname(resolve(file)),
      stdio: 'ignore',
      timeout: 3000,
    });
    return true; // exit 0 = ignored
  } catch {
    return false; // exit 1 = not ignored, or no git at all
  }
}

const sha = (s) => createHash('sha256').update(s).digest('hex');
const keyOf = (p) => sha(resolve(p).toLowerCase()).slice(0, 32);
const nowIso = () => new Date().toISOString();

function ensure(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** Pull the target file path out of a hook payload. */
export function filePathOf(payload) {
  const p = payload?.tool_input?.file_path ?? payload?.tool_input?.notebook_path;
  return typeof p === 'string' && p.trim() ? p : null;
}

function loadRecord(file) {
  const f = join(ARTIFACTS(), keyOf(file) + '.json');
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}

function saveRecord(file, rec) {
  ensure(ARTIFACTS());
  writeFileSync(join(ARTIFACTS(), keyOf(file) + '.json'), JSON.stringify(rec), 'utf8');
}

function readFileSafe(file) {
  try {
    const st = statSync(file);
    if (st.size > MAX_BYTES) return { tooBig: true, text: null, hash: null, size: st.size };
    const text = readFileSync(file, 'utf8');
    return { tooBig: false, text, hash: sha(text), size: st.size };
  } catch {
    return null;
  }
}

// ---------------- diffing ----------------

/** A plain line diff. Set difference rather than LCS — enough granularity, and no dependency. */
export function lineDiff(before, after) {
  const b = before.split(/\r?\n/);
  const a = after.split(/\r?\n/);
  const bSet = new Map();
  for (const l of b) bSet.set(l, (bSet.get(l) || 0) + 1);
  const aSet = new Map();
  for (const l of a) aSet.set(l, (aSet.get(l) || 0) + 1);

  const removed = [];
  for (const [l, n] of bSet) {
    const keep = n - (aSet.get(l) || 0);
    for (let i = 0; i < keep; i++) if (l.trim()) removed.push(l);
  }
  const added = [];
  for (const [l, n] of aSet) {
    const keep = n - (bSet.get(l) || 0);
    for (let i = 0; i < keep; i++) if (l.trim()) added.push(l);
  }
  return { removed, added };
}

export function formatDiff({ removed, added }, limit = 12) {
  const out = [];
  for (const l of removed.slice(0, limit)) out.push('- ' + l.trim().slice(0, 160));
  if (removed.length > limit) out.push(`  … and ${removed.length - limit} more removed`);
  for (const l of added.slice(0, limit)) out.push('+ ' + l.trim().slice(0, 160));
  if (added.length > limit) out.push(`  … and ${added.length - limit} more added`);
  return out.join('\n');
}

// ---------------- recording ----------------

export function recordCorrection(entry) {
  ensure(CORRECTIONS());
  const f = join(CORRECTIONS(), nowIso().replace(/[:.]/g, '-') + '-' + keyOf(entry.file).slice(0, 8) + '.json');
  writeFileSync(f, JSON.stringify(entry, null, 2), 'utf8');
  return f;
}

export function listCorrections() {
  if (!existsSync(CORRECTIONS())) return [];
  return readdirSync(CORRECTIONS())
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      try {
        // The filename is the id, so a rule can cite the corrections it came from.
        return { id: f.replace(/\.json$/, ''), ...JSON.parse(readFileSync(join(CORRECTIONS(), f), 'utf8')) };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// ---------------- export: what leaves the machine ----------------

/**
 * Build the bundle handed over during an internal trial.
 *
 * Only the fields distillation actually reads are included. Two things are deliberately
 * dropped:
 *
 *   the directory — a rule has never once been derived from one, and on a work machine
 *                   that is where the client's name lives. The basename is enough.
 *   the artifacts — full file bodies are kept locally so the agent can show a diff.
 *                   Learning needs the changed lines, not the whole file.
 *
 * Nothing here is sent anywhere. It writes a file; moving it is a deliberate act.
 */
export function buildExport({ as } = {}) {
  const who = as || createHash('sha256').update(hostname()).digest('hex').slice(0, 6);
  const corrections = listCorrections().map((c) => ({
    id: `${who}/${c.id}`,        // keep ids unique once several people's bundles are merged
    kind: c.kind || 'edited',
    file: basename(c.file || ''),
    at: c.detectedAt || c.writtenAt || null,
    askedFor: c.askedFor || '',
    removed: c.removed || [],
    added: c.added || [],
    removedCount: c.removedCount ?? (c.removed || []).length,
    addedCount: c.addedCount ?? (c.added || []).length,
  }));
  return { version: 1, who, exportedAt: nowIso(), count: corrections.length, corrections };
}

function cmdExport(args) {
  let as = null;
  let out = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--as') as = args[++i];
    else if (args[i] === '--out') out = args[++i];
  }
  const bundle = buildExport({ as });
  const target = out || join(process.cwd(), `narai-${bundle.who}.json`);
  writeFileSync(target, JSON.stringify(bundle, null, 1), 'utf8');
  console.log(`narai: ${bundle.count} correction(s) written to ${target}`);
  console.log('  included: changed lines, what you asked for, the file name');
  console.log('  excluded: the folder path, the file contents, anything git ignores');
  // The changed lines are your code. Whatever was on those lines is in the file.
  console.log('  open it before you hand it over — the changed lines are still your text');
  return 0;
}

// ---------------- reading the corrections back, for the learn skill ----------------

/**
 * `narai corpus`   — print the corrections in a fixed layout, for an agent to read.
 * `narai validate` — check a rules file against the corrections actually on disk.
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

    if (cmd === 'corpus') {
      if (corrections.length === 0) {
        console.log('narai: nothing recorded yet. Use the agent for a while first.');
        return 0;
      }
      console.log(`# ${corrections.length} correction(s)\n`);
      console.log(buildCorpus(corrections));
      return 0;
    }

    const file = args.find((a) => !a.startsWith('--'));
    if (!file) {
      console.error('narai validate <rules.json> [--save]');
      return 2;
    }
    let obj;
    try {
      obj = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      console.error(`narai: cannot read ${file} — ${e.message}`);
      return 2;
    }

    const { rules, skipped, dropped } = validate(obj, corrections);
    for (const d of dropped) {
      console.error(`  dropped: ${d.reason} (cited ${d.cited}, ${d.real} real) — ${d.rule}`);
    }
    console.log(`narai: ${rules.length} rule(s) kept, ${dropped.length} dropped`);

    if (dropped.length) {
      console.error('narai: fix the evidence and run again. Nothing was saved.');
      return 1;
    }

    if (args.includes('--save')) {
      if (!existsSync(STORE)) mkdirSync(STORE, { recursive: true });
      writeFileSync(RULES(), JSON.stringify({ rules, skipped }, null, 2), 'utf8');
      propose(rules, nowIso());
      console.log(`narai: saved to ${RULES()} and recorded in the ledger`);
    }
    return 0;
  }).catch((e) => {
    console.error(`narai: ${e.message}`);
    return 1;
  });
}

// ---------------- the hooks ----------------

/**
 * PostToolUse: remember exactly what I wrote.
 *
 * Also check whether I am rewriting something I wrote in an *earlier turn*. Plenty of
 * people never edit the file themselves — they say "no, not like that" and the agent
 * does the editing. No hand edit ever occurs, yet a correction plainly did: the same
 * file gets rewritten across a turn boundary.
 *
 * The boundary is structural, not guessed. A new prompt_id means the user spoke in
 * between; repeated writes under the same one are the agent still working.
 */
export function hookPost(payload) {
  if (!EDIT_TOOLS.test(payload?.tool_name || '')) return null;
  const file = filePathOf(payload);
  if (!file) return null;
  const cur = readFileSafe(file);
  if (!cur) return null;

  const prev = loadRecord(file);
  if (
    prev &&
    prev.text != null &&
    prev.session &&
    prev.session === payload.session_id &&
    prev.promptId &&
    payload.prompt_id &&
    prev.promptId !== payload.prompt_id &&
    prev.hash !== cur.hash &&
    !cur.tooBig
  ) {
    const d = lineDiff(prev.text, cur.text);
    if (d.removed.length || d.added.length) {
      recordCorrection({
        kind: 'instructed', // the user said something; the agent did the editing
        file: resolve(file),
        writtenAt: prev.writtenAt,
        detectedAt: nowIso(),
        session: payload.session_id || null,
        askedFor: lastUserMessage(payload.transcript_path),
        removed: d.removed.slice(0, 40),
        added: d.added.slice(0, 40),
        removedCount: d.removed.length,
        addedCount: d.added.length,
      });
    }
  }

  // Policy decides whether contents are kept. Detection works from the hash either way.
  const keepBody = !cur.tooBig && mayStoreBody(file);
  saveRecord(file, {
    file: resolve(file),
    hash: cur.hash,
    text: keepBody ? cur.text : null,
    withheld: keepBody ? null : cur.tooBig ? 'size' : 'policy',
    size: cur.size,
    writtenAt: nowIso(),
    session: payload.session_id || null,
    promptId: payload.prompt_id || null,
    tool: payload.tool_name,
  });
  return null; // injects nothing — this is the fast path
}

/**
 * Take the last thing the user said, from the tail of this session's transcript.
 * It carries more than the diff does: the diff is the outcome, the sentence is the intent,
 * in their own words. Only the tail of the file is read, and only the first 500 characters
 * are kept.
 */
export function lastUserMessage(transcriptPath, limit = 500) {
  if (!transcriptPath || process.env.NARAI_NO_PROMPTS === '1') return null;
  let tail;
  try {
    const st = statSync(transcriptPath);
    const from = Math.max(0, st.size - 256 * 1024); // the tail is all we need
    const fd = openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(st.size - from);
      readSync(fd, buf, 0, buf.length, from);
      tail = buf.toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }

  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (!l.startsWith('{')) continue;
    let o;
    try {
      o = JSON.parse(l);
    } catch {
      continue;
    }
    if (o.type !== 'user' || !o.message) continue;
    const c = o.message.content;
    // a tool result posted back as a user turn is not the user speaking
    if (Array.isArray(c) && c.some((b) => b && b.type === 'tool_result')) continue;
    const text = typeof c === 'string'
      ? c
      : Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n') : '';
    if (text.trim()) return text.trim().replace(/\s+/g, ' ').slice(0, limit);
  }
  return null;
}

/**
 * PreToolUse: before rewriting, check whether a human got there first.
 * If so, hand the diff back as context. It does not block (by default).
 */
export function hookPre(payload) {
  if (!EDIT_TOOLS.test(payload?.tool_name || '')) return null;
  const file = filePathOf(payload);
  if (!file) return null;

  const rec = loadRecord(file);
  if (!rec) return null;                       // never written this file before
  const cur = readFileSafe(file);
  if (!cur) return null;                       // gone, or unreadable
  if (cur.hash === rec.hash) return null;      // still as I left it — nothing to say

  // The file changed, but not every change is a person. An agent edits files by other means
  // too — a shell command, a script, a formatter it just ran. Those all land outside Write/Edit,
  // so the record goes stale and the next write looks like someone reached in.
  //
  // The turn boundary settles it, the same way it does for an instructed correction: within one
  // prompt the user has not spoken, so whatever changed the file was the agent itself. Only a
  // change that spans a turn boundary can be attributed to a person.
  if (rec.promptId && payload.prompt_id && rec.promptId === payload.prompt_id) return null;

  const head = [
    `narai: ${basename(rec.file)} was edited after you last wrote it (${rec.writtenAt}).`,
    'Someone — most likely the user — changed it by hand.',
    '',
  ];

  let body;
  if (rec.text == null) {
    const why = rec.withheld === 'size' ? 'the file is too large to keep' : 'this path may hold secrets, so its contents are never stored';
    body = [
      `The previous contents were not kept (${why}), so there is no diff to show.`,
      'Read the file as it stands now before you write over it.',
    ];
  } else {
    const d = lineDiff(rec.text, cur.text);
    // The hash moved but no line did: line endings, trailing whitespace, a final
    // newline. `git checkout` normalising LF to CRLF is the common one. Nobody
    // corrected anything, so there is nothing to warn about and nothing to learn
    // from — and the empty correction would still be a citable id, which is
    // exactly the fabricated evidence the two-correction gate exists to stop.
    if (!d.removed.length && !d.added.length) return null;
    body = [
      'What you wrote → what is there now:',
      formatDiff(d),
      '',
      'That edit was deliberate. Read it before writing, and do not quietly revert it.',
      'If you believe it should be undone, say why and ask first.',
    ];
    // keep it as material to learn from
    recordCorrection({
      file: rec.file,
      writtenAt: rec.writtenAt,
      detectedAt: nowIso(),
      session: payload.session_id || null,
      removed: d.removed.slice(0, 40),
      added: d.added.slice(0, 40),
      removedCount: d.removed.length,
      addedCount: d.added.length,
    });
  }

  return head.concat(body).join('\n');
}

// ---------------- other signals ----------------

/**
 * A person's ways show up in more places than file edits.
 *   denial  — a call was stopped. The least ambiguous form of "don't do that".
 *   failure — a call ran and failed. The same shape twice is a rule waiting to be written.
 * Neither hook can return context (they are not built that way), so these only record.
 */
export function recordSignal(kind, payload) {
  const entry = {
    kind,
    at: nowIso(),
    session: payload.session_id || null,
    cwd: payload.cwd || null,
    tool: payload.tool_name || null,
    agentType: payload.agent_type || null,
    // Never keep tool_input whole — arguments carry secrets. Keep only enough to see the shape.
    summary: summarizeToolInput(payload.tool_name, payload.tool_input),
    error: kind === 'failure' ? String(payload.tool_error || '').slice(0, 400) : null,
  };
  ensure(SIGNALS());
  writeFileSync(
    join(SIGNALS(), entry.at.replace(/[:.]/g, '-') + '-' + kind + '.json'),
    JSON.stringify(entry, null, 2),
    'utf8',
  );
  return entry;
}

/** Reduce a tool input to the least that could still become a rule. */
export function summarizeToolInput(tool, input) {
  if (!input || typeof input !== 'object') return null;
  if (typeof input.command === 'string') {
    // Arguments hold keys, tokens and URLs. Keep the program and a bare-word subcommand,
    // nothing further. (`git commit` survives; `-H`, `"Authorization:` and `https://…` do not.)
    const tok = input.command.trim().split(/\s+/);
    const head = (tok[0] || '').slice(0, 40);
    const sub = /^[a-z][a-z0-9_-]{0,24}$/i.test(tok[1] || '') ? tok[1] : null;
    return { command: sub ? `${head} ${sub}` : head };
  }
  if (typeof input.file_path === 'string') return { file: basename(input.file_path) };
  if (typeof input.url === 'string') {
    try {
      return { host: new URL(input.url).host };
    } catch {
      return null;
    }
  }
  return null;
}

export function listSignals() {
  if (!existsSync(SIGNALS())) return [];
  return readdirSync(SIGNALS())
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      try {
        return { id: f.replace(/\.json$/, ''), ...JSON.parse(readFileSync(join(SIGNALS(), f), 'utf8')) };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function loadRules() {
  if (!existsSync(RULES())) return [];
  try {
    const j = JSON.parse(readFileSync(RULES(), 'utf8'));
    return Array.isArray(j.rules) ? j.rules : [];
  } catch {
    return [];
  }
}

/**
 * SubagentStart: a subagent is born knowing nothing. Whatever the main agent has learned
 * does not reach it on its own, so hand it over here. Say nothing when there is nothing
 * worth saying — an empty warning is just wasted context.
 */
export function hookSubagent() {
  const rules = loadRules();
  const lines = [];

  if (rules.length) {
    lines.push('narai — how this user works, learned from their own corrections:');
    for (const r of rules.slice(0, 12)) lines.push(`- ${r.rule}${r.scope && r.scope !== '*' ? `  (${r.scope})` : ''}`);
  }

  const corr = listCorrections();
  if (!rules.length && corr.length >= 3) {
    // Even before anything has been distilled into rules, which files keep getting
    // corrected is worth passing on.
    const byFile = {};
    for (const c of corr) byFile[basename(c.file)] = (byFile[basename(c.file)] || 0) + 1;
    const top = Object.entries(byFile).sort((a, b) => b[1] - a[1]).slice(0, 5).filter(([, n]) => n >= 2);
    if (top.length) {
      lines.push('narai — files this user has hand-corrected after the agent wrote them:');
      for (const [f, n] of top) lines.push(`- ${f} (${n} times)`);
      lines.push('Read them before rewriting; those edits were deliberate.');
    }
  }

  return lines.length ? lines.join('\n') : null;
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
    console.log('narai: nothing recorded yet.');
    console.log('Install the hooks, then edit a file the agent wrote — that is what gets recorded.');
    return 0;
  }
  const n = parseInt(argv.find((a) => /^\d+$/.test(a)) || '20', 10);
  const recent = all.slice(-n);
  console.log(`narai: ${all.length} hand-edit(s) recorded (showing the last ${recent.length})\n`);
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
      else if (sub === 'pre') emit('PreToolUse', hookPre(payload));
      else if (sub === 'denied') recordSignal('denial', payload);
      else if (sub === 'failed') recordSignal('failure', payload);
      else if (sub === 'subagent') emit('SubagentStart', hookSubagent());
    } catch {
      // a hook must never interrupt the user's work
    }
    return 0;
  }

  if (cmd === 'log') return cmdLog(argv.slice(1));

  if (cmd === 'export') return cmdExport(argv.slice(1));

  // corpus / validate load learn.mjs, which the hooks never touch. Kept behind a dynamic
  // import so the hot path stays two files: this one and nothing else.
  if (cmd === 'corpus' || cmd === 'validate') return cmdLearn(cmd, argv.slice(1));

  if (cmd === 'where') {
    console.log(STORE);
    return 0;
  }

  console.log(`narai — tells the agent when you edited what it wrote

  narai log [n]     show the hand-edits it has recorded (default 20)
  narai export      write a bundle to hand over: changed lines only, no paths, no file bodies
                      --as <name>   label the bundle (default: a hash of the hostname)
                      --out <file>  where to write it
  narai corpus      print the corrections, laid out for reading
  narai validate <rules.json> [--save]
                    check a rules file against the corrections on disk. A rule citing
                    fewer than two real ones is dropped and the command exits 1.
  narai where       print the store location

  Turning corrections into rules is the narai-learn skill's job — no API key involved.

  Install as hooks, in your Claude Code settings.json:

    "PostToolUse": [{ "matcher": "Write|Edit", "hooks": [
      { "type": "command", "command": "npx narai hook post", "timeout": 10 }]}],
    "PreToolUse":  [{ "matcher": "Write|Edit", "hooks": [
      { "type": "command", "command": "npx narai hook pre",  "timeout": 10 }]}]

  Set NARAI_HASH_ONLY=1 to never store file contents.
`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = main(process.argv.slice(2));
  // corpus / validate settle asynchronously; the rest return a number straight away.
  if (result && typeof result.then === 'function') result.then((code) => process.exit(code ?? 0));
  else process.exit(result);
}
