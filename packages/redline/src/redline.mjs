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
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { finding, report, ledger, sortie } from '@hyuga/spar';
import { runDirectly, readStdin } from '@hyuga/spar/cli';

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
  /**
   * Recorded, and not charged.
   *
   * A file the prompt did not name is worth writing down. It is not worth points, and a day of
   * field data says so plainly: 22 charges on a work machine, 19 of them unnamed, and every one
   * of those 19 was a skill writing the files it exists to write. Three runs of the same skill
   * reached the stop threshold in 41, 63 and 40 seconds, on nothing but its own declared output.
   *
   * There is no version of the scope test a skill can pass. The whole point of a skill is that
   * the human names the *task* and the skill knows the filenames — so "did the human say this
   * name out loud" cannot separate routine work from a runaway, which is the one distinction
   * the charge was for. A limiter that is 86% noise gets read as noise, and then the call that
   * should have stopped somebody reads like the nineteen that should not have. That is the same
   * ground on which quoting stopped being charged.
   *
   * Zero keeps the reading and drops the claim: the finding still lands in the ledger, so what
   * was written that nobody asked for stays answerable after the fact — by someone reading it,
   * which is where that question was always going to be settled.
   */
  {
    kind: 'unnamed',
    points: 0,
    why: 'nobody asked for this file',
    scope: true, // decided against what the prompt named
  },
];

/** One directory, then every directory above it, then the home directory. */
const lookIn = (cwd) => {
  const dirs = [];
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    dirs.push(dir);
    if (dirname(dir) === dir) break;
  }
  const home = resolve(homedir() || '');
  if (home && !dirs.includes(home)) dirs.push(home);
  return dirs;
};

/** The nearest readable config at or above one directory, or null if there is none. */
function nearest(start) {
  for (const dir of lookIn(start)) {
    for (const name of ['.redline.json', 'redline.json']) {
      const p = join(dir, name);
      if (existsSync(p)) {
        // A file that will not parse is not a reason to stop looking.
        try { return { production: [], ...JSON.parse(readFileSync(p, 'utf8')) }; } catch { /* keep looking */ }
      }
    }
  }
  return null;
}

/**
 * Production paths are per-repository and nobody else's business, so they come from config.
 *
 * Looked up from more than one place, because a hook's working directory is not where the work
 * is. It is the directory the *session* was started in, and an agent started in a home
 * directory writes to a client tree on a network share all day without ever changing it.
 * Following 0.3.0 to the letter, a config sitting at the top of that share is never reached,
 * and the machine ends up keeping two copies of the same file — one where the writing happens
 * and one where the session happens — which then have to be kept in step by hand.
 *
 * So the file being written gets a look-up of its own. Which paths are production is a property
 * of the tree the file lives in, the way .gitignore and .editorconfig are, and that tree is the
 * one that knows.
 *
 * The results are unioned rather than ranked. Ranking would let a config anywhere in the write
 * path shorten the list the session was started with — a quieter limiter, chosen by the
 * directory being written to. A union can only ever make more things count as production, which
 * is the direction a limiter is allowed to be wrong in.
 */
export function config(cwd = process.cwd(), alsoFrom = []) {
  const production = [];
  let found = false;
  for (const start of [cwd, ...alsoFrom].filter(Boolean)) {
    const cfg = nearest(start);
    if (!cfg) continue;
    found = true;
    for (const p of cfg.production || []) if (!production.includes(p)) production.push(p);
  }
  if (found) return { production };
  const env = process.env.REDLINE_PRODUCTION;
  return { production: env ? env.split(';').filter(Boolean) : [] };
}

const norm = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();

const WRITES = /^(Write|Edit|MultiEdit|NotebookEdit)$/;

/**
 * One command, cut into the things it actually runs.
 *
 * The tariff matches a regular expression against the command, and a command is not one action:
 * `grep "npm publish" README.md && npm publish` contains the words twice and performs the
 * publish once. Charging the whole string charges both, and there is no way to tell which of
 * them was real.
 *
 * Quotes are respected, because a separator inside them is a character rather than a break —
 * `grep "a; rm -rf /" notes.md` is one command that reads a file. Escapes are not; a limiter is
 * not a shell, and the case it would buy is rarer than the complexity it would cost.
 */
/**
 * A heredoc body is the file being written, not a list of commands to run.
 *
 * `cat > test.mjs <<'EOF'` followed by a test that asserts `rm -rf build` is charged — which is
 * how this limiter charged 6 points for the commit that taught it not to. Every line of the
 * body reads as a command because every line ends in a newline, and a newline is a separator.
 * What the shell does with those lines is write them to a file.
 *
 * An unterminated heredoc takes the rest of the string: the body is the part that was not
 * meant to run, and guessing where it ends in favour of charging is the wrong way to be wrong.
 *
 * The marker does not have to end the line, and reading it as if it did is how this file's own
 * commit was charged three points for the phrase `rm -rf` inside its message. `git commit -F -
 * <<'MSG' && git log -1` is an ordinary thing to type: the body starts on the next line either
 * way, and the rest of *this* line is a real command that still has to be read. So it is put
 * back rather than swallowed with the body.
 */
export function stripHeredocs(s) {
  return s.replace(
    /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1([^\n]*)\r?\n[\s\S]*?(?:\r?\n[ \t]*\2[ \t]*(?=\r?\n|$)|$)/g,
    (_all, _quote, _tag, rest) => `<<${rest}`,
  );
}

export function segments(command) {
  const s = stripHeredocs(String(command || ''));
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === ';' || c === '\n' || c === '&' || c === '|') {
      out.push(cur);
      cur = '';
      if ((c === '&' || c === '|') && s[i + 1] === c) i += 1; // && and || are one separator
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/**
 * Commands whose arguments are text, not actions.
 *
 * This limiter cost itself its own credibility before it cost anybody else anything: a session
 * that only ever *searched* for the string `npm publish` — grepping a README, reading a
 * workflow file — reached 20 against a limit of 3, and every one of those charges was a
 * quotation. A number that is mostly noise gets read as noise, and then the one call that
 * should have stopped somebody reads like the twenty that should not have.
 *
 * These are matched on the verb only, and only ones that print. `find`, `sed`, `awk` and
 * `xargs` are absent on purpose: each of them takes an argument that is itself a command, so
 * their arguments are not merely text.
 */
const READS = /^(grep|egrep|fgrep|rg|ag|ack|cat|head|tail|less|more|echo|printf|ls|dir|wc|Select-String|Get-Content|Get-ChildItem|Write-Host|Write-Output)\b/i;

/** What this command actually does, with the parts that only read something dropped. */
export function acts(command) {
  return segments(command).filter((seg) => !READS.test(seg));
}

const inProduction = (text, cfg) => !!text && cfg.production.some((pat) => norm(text).includes(norm(pat)));

/**
 * Only a write counts.
 *
 * Reading production is how you find out what is there, and charging for it would make the
 * careful thing cost the same as the dangerous one — which teaches skipping the read.
 */
function isProduction(tool, path, doing, cfg) {
  if (WRITES.test(tool)) return inProduction(path, cfg);
  // `doing` is already the command minus its read-only parts, so `grep X:/site/ -r` names a
  // production path without touching one and is not charged for it.
  return doing.some((seg) => inProduction(seg, cfg));
}

/** The files the human named in their own words. Everything else is the agent's own idea. */
export function namedInPrompt(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(/[\w./\\-]+\.[A-Za-z0-9]{1,8}\b/g)) {
    out.add(norm(m[0]).split('/').pop());
  }
  return [...out];
}

/**
 * What the human named, this sortie.
 *
 * Filtered by sortie, because the ledger outlives the session. Without it the first writes of a
 * new sortie — before anybody has typed anything — are judged against yesterday's prompt, and a
 * file nobody has mentioned today gets charged for not being in a list from a conversation that
 * is over. The score is meant to be a reading of this flight.
 */
function scope(cwd) {
  const s = sortie(cwd);
  const named = ledger(cwd)
    .filter((f) => f.source === 'redline' && f.phase === 'brief' && f.sortie === s.id);
  return named.length ? named[named.length - 1].observed : null;
}

/**
 * Price one tool call.
 *
 * Charges are not exclusive: a `git push --force` to a production checkout is irreversible and
 * outward at once, and pricing it as one of those would be the cheaper reading of the two.
 */
/**
 * The absolute paths a command names, as further places to look for a config.
 *
 * 0.4.0 gave the look-up to written files and withheld it from shell commands, on the grounds
 * that a path taken out of a string is a guess and a wrong guess reads a file off wherever the
 * guess pointed. A day of use turned that around: the last step of publishing anything on the
 * machine that reported it is a shell command — WinSCP, over twenty times in its work log — and
 * that step was the one call whose charge depended on where the config had been filed. The tool
 * call that stages a file into a client tree was priced correctly, and the upload that put it in
 * front of the public was free.
 *
 * The objection survives only if a stray read could make the limiter quieter, and it cannot:
 * configs are unioned, so anything found this way can only add paths to what counts as
 * production. A guess that lands nowhere costs a handful of `existsSync` calls and changes no
 * number. Four distinct paths per call is plenty for the shape this actually takes — a source
 * and a destination — and keeps a command full of slashes from walking the disk.
 *
 * Read-only segments are already gone by the time this is called: `grep /var/www -r` names a
 * production path without touching one, and is not asked about it.
 */
export function absolutePathsIn(doing, max = 4) {
  const out = [];
  for (const seg of doing) {
    for (const m of String(seg).matchAll(/(?:[A-Za-z]:[\\/]|\/)[^\s"';|&]*/g)) {
      if (!out.includes(m[0])) out.push(m[0]);
      if (out.length >= max) return out;
    }
  }
  return out;
}

export function price(payload, cwd = process.cwd(), cfg = null) {
  const tool = payload.tool_name || payload.toolName || '';
  const input = payload.tool_input || payload.toolInput || {};
  const command = String(input.command || '');
  const path = input.file_path || input.path || input.notebook_path || '';
  // What the command does, rather than what it says. A charge names the part that earned it, so
  // the pilot is told which half of a compound command was the expensive one.
  const doing = acts(command);
  // Every tree this call touches is asked where the rules are kept, alongside the session's own
  // directory.
  const conf = cfg || config(cwd, [
    ...(path ? [dirname(resolve(String(path)))] : []),
    ...absolutePathsIn(doing),
  ]);
  const charges = [];

  for (const rule of TARIFF) {
    const hit = rule.bash && doing.find((seg) => rule.bash.some((re) => re.test(seg)));
    if (hit) {
      charges.push({ kind: rule.kind, points: rule.points, why: rule.why, on: hit.slice(0, 120) });
      continue;
    }
    if (rule.file && path && rule.file.some((re) => re.test(path))) {
      charges.push({ kind: rule.kind, points: rule.points, why: rule.why, on: path });
      continue;
    }
    if (rule.path && isProduction(tool, path, doing, conf)) {
      charges.push({ kind: rule.kind, points: rule.points, why: rule.why, on: path || doing.join(' ').slice(0, 120) });
      continue;
    }
    if (rule.scope && path && WRITES.test(tool)) {
      const named = scope(cwd);
      // `null` means no scope was recorded at all — the prompt hook is not installed, and
      // judging without it would price every file in the repo as unasked-for.
      //
      // An empty list is a different fact, and it used to be read as the same one. It means the
      // hook is installed and the person named nothing, which is what a skill invocation looks
      // like: "/karte <client>" names a task, and the filenames are the skill's to know. That is
      // the case where what got written unasked-for is most worth having on the record, and it
      // was the one case that left no record at all.
      if (named && !named.includes(norm(path).split('/').pop())) {
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
  // A call that adds nothing cannot be the call that takes you past the edge.
  //
  // The number is the sortie's and it still only goes up — that is the claim this tool makes,
  // and a window over the last N calls would give it up. What has to be per-call is *which*
  // call gets stopped. Without this line the first irreversible command in a sortie converts
  // every later call into a stop, and with nobody in the seat every later call is then denied:
  // a scheduled task that deletes one temporary file spends the rest of its run being refused
  // permission to write to a scratch directory. Observed on a work machine at 40 seconds in.
  //
  // So the reading stays honest — the finding carries the running total either way — and the
  // interruption is spent on the calls that are actually buying more exposure.
  const severity = points ? severityFor(total) : 'note';

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
        // Filed even when it is empty. "The person named no files" and "nobody was asked" are
        // different states, and only one of them means the scope is unknowable — but with the
        // finding withheld they arrive downstream as the same silence.
        const named = namedInPrompt(payload.prompt || payload.user_prompt || '');
        report(finding({ phase: 'brief', source: 'redline', subject: 'scope', observed: named, actor: 'human' }));
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

  Which paths count as production is yours to say, in .redline.json — looked for in the
  working directory, then every directory above it, then your home directory:

    { "production": ["X:/01-client/", "/var/www/"] }

  or REDLINE_PRODUCTION, semicolon-separated.

  The score lives in the spar ledger (.spar/ledger.jsonl) and resets when a new
  sortie is launched. It never goes down inside one.
`);
  return 0;
}

if (runDirectly(import.meta.url)) process.exit(main(process.argv.slice(2)));
