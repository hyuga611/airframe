/**
 * narai learn — turn accumulated corrections into the way this person works.
 *
 * There is no model call in here. Reading the corrections and writing the rules is the
 * agent's job, driven by skills/narai-learn/SKILL.md; this file is the part that has to
 * be code rather than instructions:
 *
 *   buildCorpus  — lay the corrections out in a fixed shape, so what the agent reads
 *                  does not depend on how it decided to read the directory.
 *   validate     — throw away rules whose evidence does not hold up. An instruction can
 *                  be ignored; this cannot.
 *   markerFor    — derive, in code, the literal a recurrence would have to contain.
 *   the ledger   — record each rule as a prediction, and score it later.
 *
 * Requiring an API key here would have shut out everyone working from a subscription,
 * which is most people this is for.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, basename, dirname, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { listCorrections, listSignals, STORE } from './narai.mjs';

const LEDGER = () => join(STORE, 'ledger.json');

/**
 * The shape a rule must have. The agent writes JSON in this shape; validate() then
 * checks the one part that cannot be taken on trust — the evidence.
 *
 * There is deliberately no `marker` field. What a recurrence looks like is derived from
 * the cited corrections by markerFor(), not asserted by the model: the thing being graded
 * does not get to write its own answer key.
 */
export const RULES_SCHEMA = {
  type: 'object',
  properties: {
    rules: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          rule: { type: 'string', description: 'The instruction, as one sentence, stated plainly.' },
          why: { type: 'string', description: 'Why it holds. Observed facts only.' },
          scope: { type: 'string', description: 'Where it applies: a file glob, or "*".' },
          evidence: {
            type: 'array',
            items: { type: 'string' },
            description: 'Ids of the corrections behind this rule. At least two — one is not yet a habit.',
          },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['rule', 'why', 'scope', 'evidence', 'confidence'],
        additionalProperties: false,
      },
    },
    skipped: {
      type: 'string',
      description: 'What you saw but did not turn into a rule, and why. One paragraph.',
    },
  },
  required: ['rules', 'skipped'],
  additionalProperties: false,
};

/** One line, reduced to the form two occurrences of the same habit would share. */
const norm = (s) => String(s).trim().replace(/\s+/g, ' ').toLowerCase();

const sha8 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 8);

/**
 * Where a correction happened, as one segment of parent plus the file name.
 *
 * The basename alone was ambiguous in a way that defeated the two-correction gate: on a
 * machine holding many projects, `index.html` under two different clients reads as the same
 * file being corrected twice, and a rule gets written from a habit that never existed.
 * The absolute path is already in the record, so this costs no new capture — and buildExport
 * still strips the directory, so nothing changes about what can leave the machine.
 */
function where(file) {
  const b = basename(file || '');
  const d = basename(dirname(file || ''));
  return d && d !== '.' && d !== b ? `${d}/${b}` : b;
}

/** Lay the corrections out for reading. Same input, same text, every time. */
export function buildCorpus(corrections, { maxLines = 8, signals = [] } = {}) {
  const lines = [];
  for (const c of corrections) {
    lines.push(`## ${c.id}`);
    lines.push(`file: ${where(c.file)} (${extname(c.file || '') || 'no-ext'})`);
    // When the change was asked for, the reason survives in the user's own words.
    // That outweighs the diff, so it goes first.
    if (c.askedFor) lines.push(`the user said: ${c.askedFor}`);
    for (const l of (c.removed || []).slice(0, maxLines)) lines.push(`- ${l.trim().slice(0, 200)}`);
    for (const l of (c.added || []).slice(0, maxLines)) lines.push(`+ ${l.trim().slice(0, 200)}`);
    lines.push('');
  }

  // A blocked call is the least ambiguous "do not do that" there is, and these were being
  // recorded and then read by nobody. Only denials: a failure is the tool's problem, not a
  // statement about how this person works.
  const denials = signals.filter((s) => s.kind === 'denial' && s.summary);
  if (denials.length) {
    const byShape = new Map();
    for (const d of denials) {
      const shape = d.summary.command || d.summary.file || d.summary.host || 'unknown';
      if (!byShape.has(shape)) byShape.set(shape, { ids: [], reasons: new Set() });
      const e = byShape.get(shape);
      e.ids.push(d.id);
      if (d.reason) e.reasons.add(d.reason);
    }
    lines.push('## calls this user blocked');
    lines.push('Each was stopped before it ran. Cite these ids like any other evidence, but read');
    lines.push('them narrowly — a block can be about one path or one moment, not a standing rule.');
    lines.push('Where a reason was given, it says which objection it was; the command shape alone');
    lines.push('does not.');
    for (const [shape, e] of [...byShape].sort((a, b) => b[1].ids.length - a[1].ids.length)) {
      lines.push(`- ${shape} — blocked ${e.ids.length}x: ${e.ids.join(', ')}`);
      for (const r of [...e.reasons].slice(0, 2)) lines.push(`    reason: ${r.slice(0, 160)}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * The literal a later correction would have to repeat for it to count as this rule failing.
 *
 * Taken as the intersection of the cited corrections' removed lines, normalised. Requiring
 * a non-empty intersection is the whole test: it proves the line actually recurred across
 * the known past before it is trusted to recognise a future instance. When the cited
 * corrections share nothing literal — which is common, and true of most style habits — the
 * answer is null and the rule is simply not scorable. That is a worse-looking number and a
 * more honest one; the alternative is fuzzy matching, which fires on unrelated edits and
 * quietly turns the ledger into noise.
 */
export function markerFor(cited) {
  if (!Array.isArray(cited) || cited.length < 2) return null;
  let acc = null;
  for (const c of cited) {
    const set = new Set((c.removed || []).map(norm).filter((l) => l.length >= 3));
    acc = acc === null ? set : new Set([...acc].filter((l) => set.has(l)));
    if (acc.size === 0) return null;
  }
  // The longest shared line is the most specific thing to watch for.
  return [...acc].sort((a, b) => b.length - a.length)[0] ?? null;
}

/**
 * Drop rules with no support, or citing ids that do not exist.
 *
 * This is the whole reason the check lives in code. An agent asked to "cite at least two
 * corrections" will usually comply, and the times it does not are exactly the times the
 * rule is invented. So the ids get checked against what is actually on disk.
 *
 * What is counted is observations, not records. Say "drop the emoji" once and three files
 * get rewritten in the same turn: that is one thing the person told you, and citing all
 * three would clear a gate meant to require two separate occasions. Corrections carrying
 * the same promptId therefore count once. Corrections recorded before promptId existed
 * have none, and each is counted separately — there is no evidence they shared a turn, and
 * inventing that link would drop real rules.
 */
export function validate(obj, corrections, signals = []) {
  const known = new Map();
  for (const c of corrections) known.set(c.id, c);
  for (const s of signals) known.set(s.id, s);

  const rules = [];
  const dropped = [];
  for (const r of (obj && obj.rules) || []) {
    const ev = (r.evidence || []).filter((e) => known.has(e));

    const turns = new Set();
    let unattributed = 0;
    for (const e of ev) {
      const p = known.get(e).promptId;
      if (p) turns.add(p);
      else unattributed += 1;
    }
    const observations = turns.size + unattributed;

    if (observations < 2) {
      dropped.push({
        rule: r.rule,
        cited: (r.evidence || []).length,
        real: ev.length,
        reason:
          ev.length === 0
            ? 'cites corrections that do not exist'
            : ev.length < 2
              ? 'only one correction behind it'
              : 'only one turn behind it — one sentence produced them all',
      });
      continue;
    }
    rules.push({ ...r, evidence: ev });
  }
  return { rules, skipped: (obj && obj.skipped) || '', dropped };
}

// ---------------- the ledger: predictions, and how they turned out ----------------

export function loadLedger() {
  if (!existsSync(LEDGER())) return { proposals: [], version: 1 };
  try {
    const l = JSON.parse(readFileSync(LEDGER(), 'utf8'));
    return l && Array.isArray(l.proposals) ? l : { proposals: [], version: 1 };
  } catch {
    return { proposals: [], version: 1 };
  }
}

export function saveLedger(l) {
  if (!existsSync(STORE)) mkdirSync(STORE, { recursive: true });
  writeFileSync(LEDGER(), JSON.stringify(l, null, 2), 'utf8');
}

/**
 * Record a rule in the ledger as a prediction.
 * The prediction is: "apply this rule and corrections of this kind stop happening."
 *
 * `marker` is what makes that checkable, and it is derived here from the corrections the
 * rule cited — not stored by the hooks, not written by the model. A rule with no marker is
 * kept and injected like any other; it simply reports as unscorable forever.
 */
export function propose(rules, at, corrections = []) {
  const byId = new Map(corrections.map((c) => [c.id, c]));
  const l = loadLedger();
  for (const r of rules) {
    const cited = (r.evidence || []).map((e) => byId.get(e)).filter(Boolean);
    const marker = markerFor(cited);
    l.proposals.push({
      id: `${at.slice(0, 10)}-${sha8(r.rule)}`,
      rule: r.rule,
      scope: r.scope,
      evidence: r.evidence,
      confidence: r.confidence,
      marker,                 // null when the cited corrections share no literal line
      scorable: marker != null,
      proposedAt: at,
      accepted: null,         // set only by `narai accept` / `narai reject`
    });
  }
  saveLedger(l);
  return l;
}

/** Record whether a proposal was adopted. Accepts a full id or a unique prefix. */
export function setAccepted(id, value) {
  const l = loadLedger();
  const hits = l.proposals.filter((p) => p.id === id || String(p.id || '').startsWith(id));
  if (hits.length !== 1) return null;
  hits[0].accepted = value;
  saveLedger(l);
  return hits[0];
}

/**
 * How the proposed rules have actually done.
 *
 * Folded straight from the corrections on disk: a recurrence is a correction recorded after
 * the rule was proposed whose removed lines contain the rule's marker. Nothing is written
 * at hook time to support this, and nothing needs to be — the corrections already carry
 * everything, so a second log would only be a second thing to keep in step.
 *
 * No rate is returned. Zero recurrences cannot be told apart from "the situation never came
 * up", and since narai injects these same rules at session start it is treating the very
 * behaviour it is measuring — any ratio would be pinned toward 1.00 by its own hand. The
 * rows are the honest output. A scoreboard whose mistakes flatter it is a sales pitch.
 */
export function score(corrections = gather()) {
  const l = loadLedger();
  const rows = l.proposals.map((p) => {
    if (!p.marker) return { ...p, scorable: false, recurrences: [] };
    const recurrences = [];
    for (const c of corrections) {
      if (!c.detectedAt || !p.proposedAt || c.detectedAt <= p.proposedAt) continue;
      if ((c.removed || []).some((line) => norm(line) === p.marker)) {
        recurrences.push({ id: c.id, at: c.detectedAt, line: p.marker });
      }
    }
    return { ...p, scorable: true, recurrences };
  });

  return {
    proposed: rows.length,
    scorable: rows.filter((r) => r.scorable).length,
    unscorable: rows.filter((r) => !r.scorable).length,
    recurrences: rows.reduce((n, r) => n + r.recurrences.length, 0),
    rows,
  };
}

export function gather() {
  return listCorrections();
}

export function gatherSignals() {
  return listSignals();
}
