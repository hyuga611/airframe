#!/usr/bin/env node
/**
 * redline — 際 ("the edge; the point past which you do not go")
 *
 * A limiter, mounted on the spar frame.
 *
 * Permission prompts ask about one call at a time, and every single call can be defensible
 * while the session as a whole goes somewhere nobody agreed to. redline counts instead. One
 * number per sortie, it only ever goes up, and what it counts is exposure — writing to
 * production, doing something irreversible, sending something outward.
 *
 *   1  recorded
 *   2  advised
 *   3  stopped — but only when nobody is in the seat. A pilot who is flying gets told.
 *
 * The score is not stored here. redline has no store: it sums its own findings back out of the
 * frame's ledger. That is the whole reason the frame exists.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { finding, report, ledger, sortie } from '@hyuga/spar';

export const THRESHOLDS = { record: 1, advise: 2, stop: 3 };

/**
 * What costs what.
 *
 * The weights are arguable and the structure is not. Irreversible and outward-facing sit at
 * the stop threshold on their own, because both are things whose first instance is already the
 * whole event: there is no such thing as half a publish.
 */
export const TARIFF = [
  {
    kind: 'irreversible',
    points: 3,
    why: 'cannot be undone',
    bash: [
      /\brm\s+-[a-zA-Z]*[rf]/,
      /\brm\s+--(recursive|force)/,
      /\bgit\s+push\b[^|;]*--force/,
      /\bgit\s+reset\s+--hard/,
      /\bgit\s+clean\s+-[a-zA-Z]*[fd]/,
      /\bgit\s+filter-(branch|repo)/,
      // PowerShell and cmd. The shell a session actually runs in is the machine's, not the
      // author's — on Windows none of the patterns above ever match, and a limiter that scores
      // zero on the only shell present is worse than no limiter, because it reads as a clean run.
      /\bRemove-Item\b[^|;]*-(Recurse|Force)/i,
      /\bClear-Content\b/i,
      /\brmdir\s+\/[a-z]*s/i,
      /\bdel\s+\/[a-z]*[sq]/i,
      /\bFormat-Volume\b/i,
      /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i,
      /\bTRUNCATE\b/i,
      /\bDELETE\s+FROM\b/i,
      /\bUPDATE\s+\S+\s+SET\b/i,
    ],
  },
  {
    kind: 'outward',
    points: 3,
    why: 'leaves this machine',
    bash: [
      /\bnpm\s+publish\b/,
      /\bgit\s+push\b/,
      /\bgh\s+(pr|release)\s+create\b/,
      /\bcurl\b[^|;]*(-X\s*(POST|PUT|PATCH|DELETE)|--data|\s-d\s)/,
      /\bInvoke-(WebRequest|RestMethod)\b[^|;]*-Method\s*["']?(POST|PUT|PATCH|DELETE)/i,
      /\bSend-MailMessage\b/i,
      /\b(sendmail|mailx|mail)\s/,
    ],
  },
  {
    kind: 'production',
    points: 2,
    why: 'writes where people are looking',
    path: true, // decided by config, below
  },
  {
    kind: 'dependency',
    points: 1,
    why: 'new code enters the tree',
    bash: [/\bnpm\s+(i|install|add)\s+[^-\s]/, /\b(yarn|pnpm|bun)\s+add\s+\S/],
    file: [/(^|[\\/])package\.json$/],
  },
  {
    kind: 'unnamed',
    points: 1,
    why: 'nobody asked for this file',
    scope: true, // decided against what the prompt named
  },
];

/** Production paths are per-repository and nobody else's business, so they come from config. */
export function config(cwd = process.cwd()) {
  for (const name of ['.redline.json', 'redline.json']) {
    const p = join(resolve(cwd), name);
    if (existsSync(p)) {
      try { return { production: [], ...JSON.parse(readFileSync(p, 'utf8')) }; } catch { /* fall through */ }
    }
  }
  const env = process.env.REDLINE_PRODUCTION;
  return { production: env ? env.split(';').filter(Boolean) : [] };
}

const norm = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();

const WRITES = /^(Write|Edit|MultiEdit|NotebookEdit)$/;

const inProduction = (text, cfg) => !!text && cfg.production.some((pat) => norm(text).includes(norm(pat)));

/**
 * Only a write counts.
 *
 * Reading production is how you find out what is there, and charging for it would make the
 * careful thing cost the same as the dangerous one — which teaches skipping the read.
 */
function isProduction(tool, path, command, cfg) {
  if (WRITES.test(tool)) return inProduction(path, cfg);
  if (command) return inProduction(command, cfg);
  return false;
}

/** The files the human named in their own words. Everything else is the agent's own idea. */
export function namedInPrompt(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(/[\w./\\-]+\.[A-Za-z0-9]{1,8}\b/g)) {
    out.add(norm(m[0]).split('/').pop());
  }
  return [...out];
}

function scope(cwd) {
  const named = ledger(cwd).filter((f) => f.source === 'redline' && f.phase === 'brief');
  return named.length ? named[named.length - 1].observed : null;
}

/**
 * Price one tool call.
 *
 * Charges are not exclusive: a `git push --force` to a production checkout is irreversible and
 * outward at once, and pricing it as one of those would be the cheaper reading of the two.
 */
export function price(payload, cwd = process.cwd(), cfg = config(cwd)) {
  const tool = payload.tool_name || payload.toolName || '';
  const input = payload.tool_input || payload.toolInput || {};
  const command = String(input.command || '');
  const path = input.file_path || input.path || input.notebook_path || '';
  const charges = [];

  for (const rule of TARIFF) {
    if (rule.bash && command && rule.bash.some((re) => re.test(command))) {
      charges.push({ kind: rule.kind, points: rule.points, why: rule.why, on: command.slice(0, 120) });
      continue;
    }
    if (rule.file && path && rule.file.some((re) => re.test(path))) {
      charges.push({ kind: rule.kind, points: rule.points, why: rule.why, on: path });
      continue;
    }
    if (rule.path && isProduction(tool, path, command, cfg)) {
      charges.push({ kind: rule.kind, points: rule.points, why: rule.why, on: path || command.slice(0, 120) });
      continue;
    }
    if (rule.scope && path && WRITES.test(tool)) {
      const named = scope(cwd);
      // No scope recorded means the prompt hook is not installed. Charging for it then would
      // price every file in the repo as unasked-for, which is noise, not a limit.
      if (named && named.length && !named.includes(norm(path).split('/').pop())) {
        charges.push({ kind: rule.kind, points: rule.points, why: rule.why, on: path });
      }
    }
  }
  return charges;
}

export function score(cwd = process.cwd()) {
  const s = sortie(cwd);
  return ledger(cwd)
    .filter((f) => f.source === 'redline' && f.phase === 'pre' && f.sortie === s.id)
    .reduce((n, f) => n + (f.observed?.points || 0), 0);
}

const severityFor = (total) => (total >= THRESHOLDS.stop ? 'stop' : total >= THRESHOLDS.advise ? 'warn' : 'note');

/**
 * The limiter itself.
 *
 * There is no melee case here, and there was one until the tests said otherwise: the frame
 * already defers every finding raised inside a committed swing, so a limiter written to keep
 * quiet mid-melee is a limiter writing code the frame had written. Nothing about staying silent
 * during a swing is redline's to decide.
 */
/**
 * Say so when this looks like something that cannot be broken off halfway.
 *
 * The frame has a melee range with two real preconditions — an exit route, and a reading taken
 * at contact — and nothing in a session ever reached it, because closing to it is a command
 * somebody has to type. A limiter that has just decided a call is irreversible or lands in
 * production is exactly where that sentence belongs.
 *
 * It is a sentence and not a state change. Deciding that a swing has begun is the pilot's, and
 * guessing it would put the machine into a range where nothing can interrupt it — off one
 * classifier's opinion.
 */
function melee(charges, cwd) {
  if (sortie(cwd).melee) return '';
  if (!charges.some((c) => c.kind === 'irreversible' || c.kind === 'production')) return '';
  return '\nIf this one cannot be broken off halfway, close to melee first — it wants an exit route'
    + ' and a reading taken now: spar melee --action "..." --exit "..." --state "..."';
}

export function check(payload, cwd = process.cwd()) {
  const charges = price(payload, cwd);
  if (!charges.length) return null;
  const points = charges.reduce((n, c) => n + c.points, 0);
  const before = score(cwd);
  const total = before + points;
  const severity = severityFor(total);

  const r = report(finding({
    phase: 'pre',
    source: 'redline',
    severity,
    subject: [...new Set(charges.map((c) => c.on))].join(' + '),
    observed: { points, total, kinds: charges.map((c) => c.kind) },
    expected: THRESHOLDS.stop,
    note: charges.map((c) => `${c.kind} (+${c.points}): ${c.why}`).join('; '),
  }), cwd);

  if (!r.show) return null;

  const head = `redline: ${total} — ${charges.map((c) => `${c.kind} +${c.points}`).join(', ')}`;
  const closeIn = melee(charges, cwd);
  if (r.verdict === 'halt') {
    return {
      verdict: 'halt',
      message: `${head}\nPast ${THRESHOLDS.stop} with nobody in the seat. Stopping here: hand back to a human.`,
    };
  }
  if (severity === 'stop') {
    return {
      verdict: 'advise',
      message: `${head}\nThis sortie has spent ${total} against a limit of ${THRESHOLDS.stop}. You are flying it, so it is your call — but say out loud that you are past the edge before going on.`,
    };
  }
  return { verdict: 'advise', message: `${head}\nHalfway to the limit (${THRESHOLDS.stop}).${closeIn}` };
}

// ---------------- CLI ----------------

/**
 * Advice and a stop are not the same output.
 *
 * `additionalContext` is text the model reads and can talk itself out of, which is the right
 * shape for advice to a pilot who is flying — they get told, and they decide. It is the wrong
 * shape for a halt: with nobody in the seat there is no one to overrule it, so a halt has to be
 * the call actually being denied rather than a sentence about being past the edge.
 */
function emit(out) {
  if (!out) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: out.verdict === 'halt'
      ? { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: out.message }
      : { hookEventName: 'PreToolUse', additionalContext: out.message },
  }));
}

function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
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
      else if (sub === 'prompt') {
        const named = namedInPrompt(payload.prompt || payload.user_prompt || '');
        if (named.length) {
          report(finding({ phase: 'brief', source: 'redline', subject: 'scope', observed: named, actor: 'human' }));
        }
      }
    } catch {
      // a limiter that breaks the session is worse than no limiter
    }
    return 0;
  }

  if (cmd === 'score') {
    const n = score();
    console.log(`redline: ${n} spent this sortie (stop at ${THRESHOLDS.stop})`);
    return n >= THRESHOLDS.stop ? 1 : 0;
  }

  console.log(`redline — 際. A limiter that counts the sortie, not the call.

  redline score        what this sortie has spent so far

  Install as hooks, in your Claude Code settings.json:

    "PreToolUse":        [{ "hooks": [
      { "type": "command", "command": "npx @hyuga/redline hook pre", "timeout": 10 }]}],
    "UserPromptSubmit":  [{ "hooks": [
      { "type": "command", "command": "npx @hyuga/redline hook prompt", "timeout": 10 }]}]

  Without the prompt hook, redline cannot tell a file you asked for from one it chose itself,
  and simply does not charge for that — it never guesses the scope.

  Which paths count as production is yours to say, in .redline.json:

    { "production": ["X:/01-client/", "/var/www/"] }

  or REDLINE_PRODUCTION, semicolon-separated.

  The score lives in the spar ledger (.spar/ledger.jsonl) and resets when a new
  sortie is launched. It never goes down inside one.
`);
  return 0;
}

function runDirectly() {
  const arg = process.argv[1];
  if (!arg) return false;
  if (import.meta.url === pathToFileURL(arg).href) return true;
  try { return import.meta.url === pathToFileURL(realpathSync(arg)).href; } catch { return false; }
}

if (runDirectly()) process.exit(main(process.argv.slice(2)));
