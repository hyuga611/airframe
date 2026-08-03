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
 *   the ledger   — record each rule as a prediction, and score it later.
 *
 * Requiring an API key here would have shut out everyone working from a subscription,
 * which is most people this is for.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { listCorrections, STORE } from './narai.mjs';

const LEDGER = () => join(STORE, 'ledger.json');

/**
 * The shape a rule must have. The agent writes JSON in this shape; validate() then
 * checks the one part that cannot be taken on trust — the evidence.
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

/** Lay the corrections out for reading. Same input, same text, every time. */
export function buildCorpus(corrections, { maxLines = 8 } = {}) {
  const lines = [];
  for (const c of corrections) {
    lines.push(`## ${c.id}`);
    lines.push(`file: ${basename(c.file || '')} (${extname(c.file || '') || 'no-ext'})`);
    // When the change was asked for, the reason survives in the user's own words.
    // That outweighs the diff, so it goes first.
    if (c.askedFor) lines.push(`the user said: ${c.askedFor}`);
    for (const l of (c.removed || []).slice(0, maxLines)) lines.push(`- ${l.trim().slice(0, 200)}`);
    for (const l of (c.added || []).slice(0, maxLines)) lines.push(`+ ${l.trim().slice(0, 200)}`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Drop rules with no support, or citing ids that do not exist.
 *
 * This is the whole reason the check lives in code. An agent asked to "cite at least two
 * corrections" will usually comply, and the times it does not are exactly the times the
 * rule is invented. So the ids get checked against the corrections actually on disk.
 */
export function validate(obj, corrections) {
  const known = new Set(corrections.map((c) => c.id));
  const rules = [];
  const dropped = [];
  for (const r of (obj && obj.rules) || []) {
    const ev = (r.evidence || []).filter((e) => known.has(e));
    if (ev.length < 2) {
      dropped.push({
        rule: r.rule,
        cited: (r.evidence || []).length,
        real: ev.length,
        reason: ev.length === 0 ? 'cites corrections that do not exist' : 'only one correction behind it',
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
    return JSON.parse(readFileSync(LEDGER(), 'utf8'));
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
 * It can be scored later by whether corrections of the same shape keep arriving.
 */
export function propose(rules, at) {
  const l = loadLedger();
  for (const r of rules) {
    l.proposals.push({
      rule: r.rule,
      scope: r.scope,
      evidence: r.evidence,
      confidence: r.confidence,
      proposedAt: at,
      accepted: null,       // did a human actually put it in AGENTS.md?
      correctionsSince: 0,  // corrections of the same kind since. Still 0 means it held.
    });
  }
  saveLedger(l);
  return l;
}

/**
 * The ledger's hit rate. The misses are always reported too — a scoreboard that only
 * shows wins is a sales pitch.
 */
export function score() {
  const l = loadLedger();
  const applied = l.proposals.filter((p) => p.accepted === true);
  const held = applied.filter((p) => p.correctionsSince === 0);
  return {
    proposed: l.proposals.length,
    applied: applied.length,
    held: held.length,
    rate: applied.length ? held.length / applied.length : null,
  };
}

export function gather() {
  return listCorrections();
}
