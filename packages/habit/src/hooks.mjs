/**
 * The four places habit is handed control, and what it says back.
 *
 *   PostToolUse    record what was just written, and notice a rewrite of the agent's own
 *                  earlier output — which means somebody told it to
 *   PreToolUse     before writing a file again, compare against what is on disk. Different
 *                  means a human edited it, and the diff goes back as context
 *   SubagentStart  hand a subagent the rules the main session would have had
 *   SessionStart   hand back the rules, and — at most once a week — the one unprompted line
 *
 * A hook is the only code here that runs without anybody asking for it, so the rule throughout
 * is that it either says something useful or says nothing at all. Every path that cannot produce
 * something worth reading returns null.
 */
import { readFileSync, writeFileSync, existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import {
  STORE, SAID, EDIT_TOOLS,
  ensure, nowIso, filePathOf, loadRecord, saveRecord, readFileSafe,
} from './store.mjs';
import { lineDiff, storableLines, formatDiff } from './diff.mjs';
import {
  recordCorrection, listCorrections, loadRules, ruleLines,
  sessionRecords,
} from './record.mjs';
import { looksSecret, mayStoreBody } from './secrets.mjs';

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
/**
 * PostToolUse, on every tool: bring the stored hash back in line with disk.
 *
 * `hookPre` decides "a person did this" from the file no longer matching what was
 * last written, plus a turn boundary. The turn boundary rules out the agent still
 * working inside one prompt. It does *not* rule out the agent, in an earlier turn,
 * editing the file by some route that is not Write or Edit — `sed -i`, a heredoc, a
 * formatter, a codemod, a subagent. All of those land outside `EDIT_TOOLS`, the
 * record goes stale, and the next Write is told the user reached in by hand.
 *
 * That is not a cosmetic misattribution. `hookPre` files the diff as a correction,
 * corrections become rules, and rules are injected into every later session — so
 * the agent's own shell command comes back as a preference the user never expressed.
 *
 * Nothing in a hook payload says who wrote a file. What *is* knowable is that a tool
 * just ran, so any change to a tracked file belongs to the agent. Recording it here
 * leaves hand edits as what they actually are: changes that appear when no tool ran.
 *
 * Only files already tracked are hashed, and only those touched this session, so this
 * is a few `stat`s on the hot path rather than a walk of the store.
 */
export function hookSync(payload) {
  if (EDIT_TOOLS.test(payload?.tool_name || '')) return null; // hookPost already owns these
  const session = payload?.session_id;
  if (!session) return null;
  for (const rec of sessionRecords(session)) {
    const cur = readFileSafe(rec.file);
    if (!cur || cur.hash === rec.hash) continue;
    const keepBody = !cur.tooBig && mayStoreBody(rec.file);
    saveRecord(rec.file, {
      ...rec,
      hash: cur.hash,
      text: keepBody ? cur.text : null,
      size: cur.size,
      writtenAt: nowIso(),
      promptId: payload.prompt_id || null,
      // Kept so `habit doctor` can show how often this path is the one doing the
      // writing. A store full of these means the agent is not using Write at all.
      tool: payload.tool_name || null,
      viaSync: true,
    });
  }
  return null;
}

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
    withheld: keepBody ? null : cur.tooBig ? 'size' : process.env.HABIT_HASH_ONLY === '1' ? 'hash-only' : 'policy',
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
  if (!transcriptPath || process.env.HABIT_NO_PROMPTS === '1') return null;
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
 * file looks like it holds secrets when the real reason is that `habit prune` dropped the copy
 * is a false alarm about their own repository — and it was what this said until a pruned record
 * was actually put through it. `cur.text` is checked first because a file that has grown past
 * the size limit since it was stored says nothing about how it was stored.
 */
function whyNoDiff(rec, cur) {
  if (cur.text == null) return 'the file is now too large to read';
  if (rec.withheld === 'size') return 'the file was too large to keep';
  if (rec.withheld === 'hash-only') return 'HABIT_HASH_ONLY is set, so no contents are kept anywhere';
  if (String(rec.withheld).startsWith('pruned')) return 'the stored copy was dropped by `habit prune`';
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

  // The turn boundary only settles it while the coverage holds, and the coverage is one
  // session wide. `hook sync` walks `sessionRecords(session)` — the files *this* session has
  // touched — so a file last written in an earlier session has had no tool coverage at all in
  // between. `npm version` rewriting a version line, the host rewriting settings.json, a
  // release script, a second agent: from here every one of those is indistinguishable from a
  // person. Measured on this machine before the guard existed: 28 records of this shape, and
  // not one of them was a hand edit.
  //
  // The warning is still worth making — do not write over a change you have not read — so it
  // stays. What stops is the claim about who made it, and the corpus entry built on that claim.
  const sameSession = Boolean(rec.session && payload.session_id && rec.session === payload.session_id);

  const head = sameSession
    ? [
        `habit: ${basename(rec.file)} is not what you last wrote (${rec.writtenAt}).`,
        // The premise is stated with the conclusion so a reader can see when it fails.
        // It fails if `hook sync` is not installed, and then this sentence is wrong —
        // which is better than the sentence it replaced, which asserted the conclusion
        // and hid the premise entirely.
        'Nothing you did through a tool accounts for the difference, so it came from',
        'outside this agent — most likely the user, by hand.',
        '',
      ]
    : [
        `habit: ${basename(rec.file)} is not what you last wrote (${rec.writtenAt}).`,
        'That write was in an earlier session, and nothing has been watching this file since,',
        'so a script or a release step accounts for the difference as well as a person does.',
        'Read it before writing over it. Who changed it is not being claimed.',
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
      ...(sameSession
        ? [
            'That edit was deliberate. Read it before writing, and do not quietly revert it.',
            'If you believe it should be undone, say why and ask first.',
          ]
        : [
            'Read it before writing, and do not quietly revert it. If you believe it should be',
            'undone, say why and ask first.',
          ]),
    ];
    // Only material habit can actually attribute becomes material to learn from. A rule is
    // meant to be citable back to corrections the user really made; an entry sourced from a
    // release script would be fabricated evidence wearing the same id.
    if (sameSession) {
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
  }

  return head.concat(body).join('\n');
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
      lines.push('habit — files this user has hand-corrected after the agent wrote them:');
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
 * The one line habit is allowed to say without being asked.
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
  return `habit: ${n} correction(s) recorded, not yet distilled. The habit-learn skill turns them into rules.`;
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
