/**
 * Everything that is written down, and everything that is read back.
 *
 * Three kinds of record share this module because they share one property: each is appended
 * under an id that sorts by time and never collides, and nothing is ever rewritten in place.
 *
 *   corrections  a human changed what the agent wrote
 *   signals      a call was refused, or failed
 *   artifacts    what the agent last wrote to a file, so the next write can be compared
 *
 * Reading them back lives here too — the corpus, the rules and the export bundle are all views
 * over the same three directories, and a view that disagreed with the writer about the shape of
 * a record is a whole class of defect this arrangement removes.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import {
  ARTIFACTS, CORRECTIONS, SIGNALS, RULES,
  ensure, keyOf, stamp, nowIso,
} from './store.mjs';
import { looksSecret } from './secrets.mjs';

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
export function summarizeToolInput(_tool, input) {
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
 * `reason` is on every denial payload observed so far, and habit was throwing it away — it
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

/** Where the per-file records live. `habit prune` needs the filenames, not just the contents. */
export function artifactsDir() {
  return ARTIFACTS();
}

/**
 * The records written during one session, which is the set {@link hookSync} has to
 * re-check after a tool runs. Scoped to the session on purpose: the store accumulates
 * every file ever written on this machine, and hashing all of them after every Bash
 * call would put a growing cost on the hot path for no gain — a file last written
 * three weeks ago is not one this agent is about to be told a lie about.
 */
export function sessionRecords(session) {
  return listArtifacts().filter((r) => r && r.session === session && r.file);
}

/** The per-file records the hooks keep. Read by `habit doctor`; nothing else needs them. */
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
/**
 * One rule, one line.
 *
 * A rule is text a model distilled out of a pile of edits, saved into a file, and handed back
 * at the start of every session from then on. `habit validate --save` is run by a person and
 * drops rules whose cited evidence is not real, which is the check that matters — but the text
 * itself was never anybody's sentence, and it arrives in the next session's context as part of
 * its briefing. A rule that carried its own blank line and heading would arrive looking like a
 * section of the briefing rather than a line inside one.
 *
 * So: flattened and capped. Not quoted, unlike the frame's ledger — these lines are meant to be
 * followed, which is the whole point of the part, and quoting something you are asking an agent
 * to act on only makes it harder to read. What is taken away is the ability to be more than one
 * line, which is what the trick needs.
 */
export const MAX_RULE = 300;

export const oneLine = (s) => {
  const flat = String(s ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > MAX_RULE ? `${flat.slice(0, MAX_RULE)}…` : flat;
};

/** The learned rules, as lines to hand to an agent. Empty when there are none. */
export function ruleLines(rules) {
  if (!rules.length) return [];
  const out = ['habit — how this user works, learned from their own corrections:'];
  for (const r of rules.slice(0, 12)) {
    const scope = r.scope && r.scope !== '*' ? `  (${oneLine(r.scope)})` : '';
    out.push(`- ${oneLine(r.rule)}${scope}`);
  }
  return out;
}
