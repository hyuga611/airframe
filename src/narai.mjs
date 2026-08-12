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
  openSync, readSync, closeSync, realpathSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, basename, dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { homedir, hostname } from 'node:os';
import { pathToFileURL } from 'node:url';

export const STORE = process.env.NARAI_HOME || join(homedir(), '.claude', 'narai');
const ARTIFACTS = () => join(STORE, 'artifacts');
const CORRECTIONS = () => join(STORE, 'corrections');
const SIGNALS = () => join(STORE, 'signals');
const RULES = () => join(STORE, 'rules.json');
const SAID = () => join(STORE, 'said.json');

const MAX_BYTES = 512 * 1024; // above this, keep the hash but not the contents
const MAX_LINES = 40;         // how many changed lines a correction keeps
const MAX_LINE = 400;         // and how much of each one
const EDIT_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit)$/;

// Paths whose contents are never stored. It costs the diff, which is a far better trade
// than accumulating secrets on disk — detecting *that* something changed only needs the hash.
export const NEVER_STORE = [
  /(^|[/\\])\.env(\.|$)/i,
  /(^|[/\\])\.npmrc$/i,
  /(^|[/\\])\.netrc$/i,
  /(^|[/\\])id_(rsa|dsa|ecdsa|ed25519)/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
];

/**
 * A path segment that *is* named for a credential, rather than merely containing the letters.
 *
 * This used to be a bare substring test over the whole path, which excluded far more than it
 * meant to: `tokenlint/`, `tokenizer.js`, `TokenList.tsx`, `secretary/`. A directory caught by
 * it took everything underneath with it, so narai went silent across a whole repository and
 * said nothing about why — the failure looks exactly like the tool working and finding nothing.
 *
 * Testing each segment with a boundary keeps `secrets.yml`, `API_KEY.txt` and `config/secrets/`
 * while letting a word that merely starts the same through. The trade is real and deliberate:
 * a file called `mytokenstore.json` is now stored where it was not before. A name that is the
 * word is a signal; a name that contains the letters is a coincidence.
 */
export const CREDENTIAL_NAME =
  /(^|[^a-z0-9])(secrets?|credentials?|passwords?|passphrases?|tokens?|apikey|api[_-]?key|auth[_-]?token|private[_-]?key)([^a-z0-9]|$)/i;

/** Is any segment of this path named for a credential? */
export function namedForCredential(file) {
  return String(file).split(/[/\\]+/).some((seg) => seg && CREDENTIAL_NAME.test(seg));
}

/**
 * Text that must not reach the disk, wherever it came from.
 *
 * `NEVER_STORE` judges a path, which covers a file named for a credential and nothing else.
 * Two things narai keeps are not files: the sentence you typed (`askedFor`, taken from the
 * transcript) and the text of a failed call. Paste a key into the chat and the path rules
 * never see it. These patterns match the *shape* of a credential in free text, so they apply
 * to both.
 *
 * Matching the shape means false positives — a sentence that merely discusses a password can
 * be dropped. That is the right way to be wrong: the diff survives either way, and the worst
 * case is one weaker piece of evidence rather than a live secret sitting in a JSON file.
 */
export const SECRET_TEXT = [
  /\b(sk|sk-ant|sk-proj)-[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/,
  /\bAKIA[0-9A-Z]{12,}/,
  /\bBearer\s+[A-Za-z0-9._-]{12,}/i,
  /\b(password|passwd|pwd)\s*[:=]\s*\S{4,}/i,
  /(パスワード|合言葉)\s*[:=は＝]\s*\S{4,}/,
  /\b(api[_-]?key|apikey|access[_-]?token|auth[_-]?token|secret[_-]?key|client[_-]?secret)\s*[:=]\s*\S{8,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /https?:\/\/[^/\s:]+:[^@\s]+@/,
];

/** Does this free text look like it carries a credential? When in doubt, yes. */
export function looksSecret(text) {
  if (typeof text !== 'string' || !text) return false;
  return SECRET_TEXT.some((re) => re.test(text));
}

/** May this file's contents be kept? When in doubt, no. */
export function mayStoreBody(file) {
  if (process.env.NARAI_HASH_ONLY === '1') return false;
  const p = resolve(file);
  if (NEVER_STORE.some((re) => re.test(p))) return false;
  if (namedForCredential(p)) return false;
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

/**
 * A filename stem that sorts by time and cannot collide.
 *
 * The timestamp is milliseconds, and two records can land inside one — an agent writing three
 * files from a single instruction, a denial and a failure arriving together, two subagents in
 * separate processes. Same name meant one silently overwrote the other, which is a lost
 * correction that nothing would ever report. Found on Linux CI, where everything is fast enough
 * to actually hit; on Windows the clock and the disk hid it.
 *
 * The random tail only breaks ties. The timestamp stays the prefix, so ordering by filename
 * still means ordering by time, and existing ids keep working — they are only ever compared
 * for equality.
 */
const stamp = () => `${nowIso().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`;

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

/**
 * Cut a diff down to what a correction is allowed to keep.
 *
 * Every path that *displays* a line has capped its length for a long time — 160 characters in
 * `formatDiff`, 200 in the corpus — while the path that *stores* one capped only how many.
 * One edit to a minified bundle is a single line of half a megabyte, and corrections are never
 * pruned, so it stayed forever. Nothing downstream ever reads past this, so nothing is lost
 * that was being used, and markers stay comparable because past and future lines are cut the
 * same way.
 */
export function storableLines(lines) {
  return lines.slice(0, MAX_LINES).map((l) => l.slice(0, MAX_LINE));
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

/**
 * Write a correction down.
 *
 * `promptId` is on the entry because the two-correction gate counts observations, and one
 * sentence can produce several corrections — say "drop the emoji" and three files get
 * rewritten in the same turn. Those are one observation, not three, and nothing else in the
 * record can tell them apart. It has to be captured here: a field the hook did not write is
 * gone, and every correction recorded before this existed is permanently anonymous.
 */
export function recordCorrection(entry) {
  ensure(CORRECTIONS());
  const f = join(CORRECTIONS(), `${stamp()}-${keyOf(entry.file).slice(0, 8)}.json`);
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
    const signals = listSignals();

    if (cmd === 'corpus') {
      if (corrections.length === 0 && signals.length === 0) {
        console.log('narai: nothing recorded yet. Use the agent for a while first.');
        return 0;
      }
      console.log(`# ${corrections.length} correction(s)\n`);
      console.log(buildCorpus(corrections, { signals }));
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

    const { rules, skipped, dropped } = validate(obj, corrections, signals);
    for (const d of dropped) {
      console.error(`  dropped: ${d.reason} (cited ${d.cited}, ${d.real} real) — ${d.rule}`);
    }
    console.log(`narai: ${rules.length} rule(s) kept, ${dropped.length} dropped`);

    if (dropped.length) {
      console.error('narai: fix the evidence and run again. Nothing was saved.');
      return 1;
    }

    if (args.includes('--save')) {
      ensure(STORE);
      writeFileSync(RULES(), JSON.stringify({ rules, skipped }, null, 2), 'utf8');
      const l = propose(rules, nowIso(), corrections);
      const fresh = l.proposals.slice(-rules.length);
      const scorable = fresh.filter((p) => p.scorable).length;
      console.log(`narai: saved to ${RULES()} and recorded in the ledger`);
      console.log(`  ${scorable} of ${rules.length} can be scored later; the rest share no repeated line to watch for`);
      // The pile has been distilled, so the nudge starts over from here.
      try {
        if (existsSync(SAID())) writeFileSync(SAID(), JSON.stringify({}), 'utf8');
      } catch { /* the nudge is not worth failing a save over */ }
    }
    return 0;
  }).catch((e) => {
    console.error(`narai: ${e.message}`);
    return 1;
  });
}

/**
 * `narai score`  — how the rules that were written have actually done.
 * `narai accept` / `narai reject` — whether a proposal was adopted.
 *
 * All three write ledger.json, and nothing else does. Keeping the only writer on the
 * command side means no hook can ever lose a write to it, or be delayed by one.
 */
function cmdLedger(cmd, args) {
  return import('./learn.mjs').then(({ score, setAccepted }) => {
    if (cmd === 'accept' || cmd === 'reject') {
      const id = args.find((a) => !a.startsWith('--'));
      if (!id) {
        console.error(`narai ${cmd} <proposal-id>   (see narai score)`);
        return 2;
      }
      const p = setAccepted(id, cmd === 'accept');
      if (!p) {
        console.error(`narai: no proposal matching ${id}`);
        return 1;
      }
      console.log(`narai: ${cmd}ed — ${p.rule}`);
      return 0;
    }

    const s = score(listCorrections());
    if (!s.proposed) {
      console.log('narai: no rules have been proposed yet, so there is nothing to score.');
      console.log('Run the narai-learn skill first — it writes rules and records them here.');
      return 0;
    }

    console.log(`narai: ${s.proposed} proposal(s) — ${s.scorable} scorable, ${s.unscorable} unscorable`);
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
      console.log('These rules are also injected at session start, so narai is treating the very');
      console.log('behaviour it is measuring. Read the rows, not a score.');
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
      // What the user said is the best evidence there is, and it is also the one thing here
      // that arrives as free text they typed. If it looks like it carries a credential the
      // whole sentence is dropped — a rule written from a weaker signal beats a key on disk.
      const said = lastUserMessage(payload.transcript_path);
      const saidIsSecret = looksSecret(said);
      recordCorrection({
        kind: 'instructed', // the user said something; the agent did the editing
        file: resolve(file),
        writtenAt: prev.writtenAt,
        detectedAt: nowIso(),
        session: payload.session_id || null,
        promptId: payload.prompt_id || null,
        askedFor: saidIsSecret ? null : said,
        askedForWithheld: saidIsSecret ? 'secret-like' : undefined,
        removed: storableLines(d.removed),
        added: storableLines(d.added),
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
    withheld: keepBody ? null : cur.tooBig ? 'size' : process.env.NARAI_HASH_ONLY === '1' ? 'hash-only' : 'policy',
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
 * Why there is nothing to diff against.
 *
 * Four different reasons end up here and they are not interchangeable. Telling someone their
 * file looks like it holds secrets when the real reason is that `narai prune` dropped the copy
 * is a false alarm about their own repository — and it was what this said until a pruned record
 * was actually put through it. `cur.text` is checked first because a file that has grown past
 * the size limit since it was stored says nothing about how it was stored.
 */
function whyNoDiff(rec, cur) {
  if (cur.text == null) return 'the file is now too large to read';
  if (rec.withheld === 'size') return 'the file was too large to keep';
  if (rec.withheld === 'hash-only') return 'NARAI_HASH_ONLY is set, so no contents are kept anywhere';
  if (String(rec.withheld).startsWith('pruned')) return 'the stored copy was dropped by `narai prune`';
  return 'this path may hold secrets, so its contents are never stored';
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
  if (rec.text == null || cur.text == null) {
    body = [
      `There is no diff to show — ${whyNoDiff(rec, cur)}.`,
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
      promptId: payload.prompt_id || null,
      removed: storableLines(d.removed),
      added: storableLines(d.added),
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
  const err = kind === 'failure' ? errorTextOf(payload) : { text: null, withheld: undefined };
  const rsn = kind === 'denial' ? reasonOf(payload) : { text: null, withheld: undefined };
  const entry = {
    kind,
    at: nowIso(),
    session: payload.session_id || null,
    // Signals can be cited as evidence, and the two-correction gate counts turns rather than
    // records. Without this, several refusals inside one turn would look like several occasions.
    promptId: payload.prompt_id || null,
    cwd: payload.cwd || null,
    tool: payload.tool_name || null,
    agentType: payload.agent_type || null,
    // Never keep tool_input whole — arguments carry secrets. Keep only enough to see the shape.
    summary: summarizeToolInput(payload.tool_name, payload.tool_input),
    error: err.text,
    errorWithheld: err.withheld,
    reason: rsn.text,
    reasonWithheld: rsn.withheld,
    // Which fields the payload actually arrived with. Names only; the values are where the
    // secrets are. This is here because `tool_error` was read for 34 failures and was empty
    // every single time — the field name was assumed and never checked. Recording the shape
    // means the next gap gets dated from the record instead of guessed at.
    payloadKeys: Object.keys(payload || {}).sort(),
  };
  ensure(SIGNALS());
  writeFileSync(join(SIGNALS(), `${stamp()}-${kind}.json`), JSON.stringify(entry, null, 2), 'utf8');
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

/**
 * The text of a failure, from whichever field actually carried it.
 *
 * `tool_error` was the only name looked at, and it came back empty on every one of the 34
 * failures recorded — so the name was never right. Rather than guess at a replacement, try
 * the few that mean the same thing and return null when none of them holds anything. null
 * and '' are kept distinct on purpose: one says "nothing arrived", the other said "a field
 * arrived and was blank", and only the first is true here.
 *
 * Deliberately narrow. A tool's whole response is not an error message, and putting it on
 * disk would be keeping output nobody vetted.
 *
 * Even so, `stderr` is exactly where a failing command echoes the URL it was given, token and
 * all — so whatever is found here goes through the same free-text check as the sentence the
 * user typed. Returns `{ text, withheld }`: `withheld` says a candidate was found and dropped,
 * which is a different fact from nothing having arrived, and `doctor` reports them apart.
 */
export function freeText(v, limit = 400) {
  const s = typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ').slice(0, limit) : null;
  if (!s) return { text: null, withheld: undefined };
  return looksSecret(s) ? { text: null, withheld: 'secret-like' } : { text: s, withheld: undefined };
}

export function errorTextOf(payload) {
  for (const k of ['tool_error', 'error', 'stderr', 'errorMessage', 'error_message']) {
    const v = payload?.[k];
    const direct = freeText(v);
    if (direct.text || direct.withheld) return direct;
    if (v && typeof v === 'object') {
      for (const nk of ['message', 'error', 'stderr']) {
        const nested = freeText(v[nk]);
        if (nested.text || nested.withheld) return nested;
      }
    }
  }
  return { text: null, withheld: undefined };
}

/**
 * Why a call was blocked, in the harness's words.
 *
 * `reason` is on every denial payload observed so far, and narai was throwing it away — it
 * recorded *that* something was refused and kept only the program name. The refusal is the
 * least ambiguous "do not do that" this tool ever sees, and the reason is the only part that
 * says which of the many possible objections it was. Read as free text, so it goes through the
 * same credential check as everything else here: a reason can quote the command it stopped.
 *
 * Only `reason` is read, deliberately. Guessing at a second field name is what left
 * `tool_error` empty for 34 failures; `payloadKeys` is how another one gets found.
 */
export function reasonOf(payload) {
  return freeText(payload?.reason);
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

/** Where the per-file records live. `narai prune` needs the filenames, not just the contents. */
export function artifactsDir() {
  return ARTIFACTS();
}

/** The per-file records the hooks keep. Read by `narai doctor`; nothing else needs them. */
export function listArtifacts() {
  if (!existsSync(ARTIFACTS())) return [];
  return readdirSync(ARTIFACTS())
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(ARTIFACTS(), f), 'utf8'));
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
/** The learned rules, as lines to hand to an agent. Empty when there are none. */
function ruleLines(rules) {
  if (!rules.length) return [];
  const out = ['narai — how this user works, learned from their own corrections:'];
  for (const r of rules.slice(0, 12)) out.push(`- ${r.rule}${r.scope && r.scope !== '*' ? `  (${r.scope})` : ''}`);
  return out;
}

export function hookSubagent() {
  const rules = loadRules();
  const lines = ruleLines(rules);

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

// ---------------- the main session ----------------

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function loadSaid() {
  if (!existsSync(SAID())) return {};
  try {
    return JSON.parse(readFileSync(SAID(), 'utf8'));
  } catch {
    return {};
  }
}

function saveSaid(s) {
  ensure(STORE);
  writeFileSync(SAID(), JSON.stringify(s, null, 2), 'utf8');
}

/** Corrections no rule has cited yet. With no rules at all, that is all of them. */
export function undistilled(rules, corrections) {
  const cited = new Set();
  for (const r of rules) for (const e of r.evidence || []) cited.add(e);
  return corrections.filter((c) => !cited.has(c.id));
}

/**
 * The one line narai is allowed to say without being asked.
 *
 * Distilling needs a model, and a model may not run in a hook, so something has to raise
 * the subject. It is addressed to the agent that just started — which can act on it — and
 * not to a person who has to remember a command. Five weeks of corrections on this machine
 * produced no rules at all, which is what happens when the step only runs if someone thinks
 * to ask for it.
 *
 * Three gates, because an ambient line that repeats is an ambient line that gets turned off:
 * enough material to be worth the interruption, more of it than last time it spoke, and a
 * week since. Silence is the default state and every gate returns to it.
 */
export function distillNudge(rules, corrections, now, { min = 10 } = {}) {
  const n = undistilled(rules, corrections).length;
  if (n < min) return null;

  const said = loadSaid();
  if (typeof said.count === 'number' && n <= said.count) return null; // nothing new to say
  if (said.at && Date.parse(now) - Date.parse(said.at) < WEEK_MS) return null;

  try {
    saveSaid({ at: now, count: n });
  } catch {
    // If it cannot record that it spoke, it must not speak. The alternative is a line that
    // reappears every single session, which is precisely how an ambient tool gets uninstalled.
    return null;
  }
  return `narai: ${n} correction(s) recorded, not yet distilled. The narai-learn skill turns them into rules.`;
}

/**
 * SessionStart: hand the main session what has been learned.
 *
 * hookSubagent has always done this for subagents, so the agent that actually writes the
 * files was the only one not being told. Closing that meant one readFileSync and no new
 * capture — the whole gap was that nothing called loadRules() on the way in.
 *
 * This injects context, it does not apply anything: the rules arrive as something the agent
 * may weigh, the same way the diff from hookPre does. `validate --save` is the consent —
 * a human ran the skill and kept the result.
 */
export function hookSession(now = nowIso()) {
  const rules = loadRules();
  const lines = ruleLines(rules);
  try {
    const nudge = distillNudge(rules, listCorrections(), now);
    if (nudge) lines.push(nudge);
  } catch {
    // The rules are the point and the nudge is a convenience. Reading every correction file
    // to work out whether to speak must never be able to cost the session its rules.
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
        console.error(`narai: ${e.message}`);
        return 1;
      });
  }

  if (cmd === 'prune') {
    const args = argv.slice(1);
    const di = args.indexOf('--days');
    const days = di >= 0 ? Number.parseInt(args[di + 1], 10) : 30;
    if (!Number.isFinite(days) || days < 0) {
      console.error('narai prune [--days N] [--apply]');
      return 2;
    }
    return import('./prune.mjs')
      .then(({ prune, report }) => {
        console.log(report(prune({ days, apply: args.includes('--apply') }), { days }));
        return 0;
      })
      .catch((e) => {
        console.error(`narai: ${e.message}`);
        return 1;
      });
  }

  if (cmd === 'where') {
    console.log(STORE);
    return 0;
  }

  console.log(`narai — tells the agent when you edited what it wrote

  narai log [n]     show the hand-edits it has recorded (default 20)
  narai doctor      what the store actually contains, and which couplings have gone quiet
  narai prune [--days N] [--apply]
                    drop stored file bodies whose file is gone or untouched for N days
                    (default 30). The hash stays, so edits are still detected. Dry run
                    unless --apply.
  narai export      write a bundle to hand over: changed lines only, no paths, no file bodies
                      --as <name>   label the bundle (default: a hash of the hostname)
                      --out <file>  where to write it
  narai corpus      print the corrections, laid out for reading
  narai validate <rules.json> [--save]
                    check a rules file against the corrections on disk. A rule citing
                    fewer than two real ones is dropped and the command exits 1.
  narai score       how the rules that were written have actually done since
  narai accept <id> | narai reject <id>
                    record whether a proposal was adopted (ids come from narai score)
  narai where       print the store location

  Turning corrections into rules is the narai-learn skill's job — no API key involved.

  Install as hooks, in your Claude Code settings.json. The first two are the product; the
  rest are what makes it learn rather than only warn:

    "PostToolUse":       [{ "matcher": "Write|Edit", "hooks": [
      { "type": "command", "command": "npx @hyuga/narai hook post", "timeout": 10 }]}],
    "PreToolUse":        [{ "matcher": "Write|Edit", "hooks": [
      { "type": "command", "command": "npx @hyuga/narai hook pre",  "timeout": 10 }]}],
    "SessionStart":      [{ "hooks": [
      { "type": "command", "command": "npx @hyuga/narai hook session", "timeout": 10 }]}],
    "SubagentStart":     [{ "hooks": [
      { "type": "command", "command": "npx @hyuga/narai hook subagent", "timeout": 10 }]}],
    "PermissionDenied":  [{ "hooks": [
      { "type": "command", "command": "npx @hyuga/narai hook denied", "timeout": 10 }]}],
    "PostToolUseFailure":[{ "hooks": [
      { "type": "command", "command": "npx @hyuga/narai hook failed", "timeout": 10 }]}]

  Set NARAI_HASH_ONLY=1 to never store file contents.
  Set NARAI_NO_PROMPTS=1 to keep the diffs but not what you said.
`);
  return 0;
}

/**
 * Was this run directly, or imported?
 *
 * argv[1] is the path as invoked, and both `npm i -g` and `npx` put a symlink
 * there. import.meta.url is the resolved real path, so the two never matched for
 * an installed copy and this did nothing at all: exit 0, no output. Every hook in
 * the README is spelled `npx @hyuga/narai hook ...`, so the product was inert
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
