#!/usr/bin/env node
/**
 * airframe — 器 ("the vessel: what holds the parts, and carries the person")
 *
 * The machine. One install, one front door.
 *
 * Underneath are separate packages — spar the frame, redline the limiter, and whichever of the
 * runtime tools are present — each of which still works on its own, because people installed
 * them on their own and taking that away would be a worse thing than never having assembled
 * them. airframe mounts what it finds and reports what it did not.
 *
 * What it actually does:
 *
 *   install   write the hooks for every mounted part into settings.json, without disturbing
 *             hooks that were already there
 *   session   start a sortie and hand over the brief, so nothing depends on remembering to
 *   status    one screen: mode, range, what the sortie has spent, what is left, what is mounted
 *
 * Everything else belongs to the parts. This file is deliberately not where policy lives.
 */
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, renameSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launch, sortie, fuel, brief, ledger, discard, transform, burn, finding, report, root } from '@hyuga/spar';
import { runDirectly, emit } from '@hyuga/spar/cli';

const require_ = createRequire(import.meta.url);

/**
 * What can be mounted, and what each part needs wired for it.
 *
 * A part with no hooks is not a lesser part — groundtruth is called from inside your own code at the
 * moment a completion is claimed, which is a place no hook can reach.
 */
export const PARTS = [
  {
    name: '@hyuga/airframe',
    is: 'the vessel',
    hooks: {
      SessionStart: ['hook session'],
      PostToolUse: ['hook burn'],
      SubagentStart: ['hook wingman'],
      Stop: ['hook land'],
    },
  },
  {
    name: '@hyuga/redline',
    is: 'limiter — counts the sortie, not the call',
    hooks: { PreToolUse: ['hook pre'], UserPromptSubmit: ['hook prompt'] },
  },
  {
    name: '@hyuga/habit',
    is: 'learns from the corrections you make by hand',
    // `hook post` and `hook pre` watch what gets written, so they are scoped to the tools that
    // write. Wired without a matcher they fire on every read and every search as well, which
    // costs a process per tool call to reach the same conclusion. `hook sync` is unscoped on
    // purpose: it is the one that reconciles regardless of what the tool was.
    hooks: {
      PostToolUse: [{ sub: 'hook post', matcher: 'Write|Edit' }, 'hook sync'],
      PreToolUse: [{ sub: 'hook pre', matcher: 'Write|Edit' }],
      SessionStart: ['hook session'],
      SubagentStart: ['hook subagent'],
      PermissionDenied: ['hook denied'],
      PostToolUseFailure: ['hook failed'],
    },
  },
  {
    name: '@hyuga/carbon',
    is: 'keeps the draft about to be written over — cruise only',
    hooks: { PreToolUse: ['hook pre'] },
  },
  {
    name: '@hyuga/groundtruth',
    is: 'completion gate — called from your code, not from a hook',
    hooks: {},
  },
  {
    name: '@hyuga/llm-safe-sql',
    is: 'runs the write, measures it, rolls back — from your code',
    hooks: {},
  },
];

export function mounted() {
  return PARTS.map((p) => {
    if (p.name === '@hyuga/airframe') return { ...p, present: true };
    try {
      require_.resolve(`${p.name}/package.json`);
      return { ...p, present: true };
    } catch {
      try {
        require_.resolve(p.name);
        return { ...p, present: true };
      } catch {
        return { ...p, present: false };
      }
    }
  });
}

export const settingsPath = (scope = 'project', cwd = root()) => (scope === 'user'
  ? join(homedir(), '.claude', 'settings.json')
  : join(resolve(cwd), '.claude', 'settings.json'));

function readSettings(file) {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`airframe: ${file} is not valid JSON — fix it first, I will not overwrite it (${e.message})`);
  }
}

/**
 * How a hook names the part it runs.
 *
 * `npx` is right once these are on a registry, and wrong everywhere else — it has nothing to
 * resolve, so the settings file has to be hand-edited after every install. Two machines that are
 * not a registry:
 *
 *   bin    installed globally from a tarball. The binaries are on PATH
 *   local  not installed at all. Just the folders, called by absolute path
 */
function entry(name) {
  if (name === '@hyuga/airframe') return fileURLToPath(import.meta.url);
  try { return require_.resolve(name); } catch { return null; }
}

function runner(name, sub, how) {
  if (how === 'bin') return `${name.split('/').pop()} ${sub}`;
  if (how === 'local') {
    const file = entry(name);
    if (file) return `node "${file.split('\\').join('/')}" ${sub}`;
  }
  return `npx ${name} ${sub}`;
}

/**
 * Is this hook already here, written slightly differently?
 *
 * Found against a real settings.json: a part had been wired by hand as
 * `node C:/x/habit.mjs hook pre`, and the line generated here quotes the path so a directory
 * with a space in it still works. Compared literally those are two different strings, so the
 * part would have been added a second time and every write recorded twice. Quoting, slashes and
 * runs of whitespace are spelling; the command is the same command.
 */
const same = (a, b) => {
  const norm = (c) => String(c).replace(/["']/g, '').split('\\').join('/').replace(/\s+/g, ' ').trim();
  return norm(a) === norm(b);
};

/**
 * Add our hooks to whatever is already in settings.json.
 *
 * Two things this must never do: drop a hook somebody else put there, and add a second copy of
 * one of ours. Both are silent — the first loses a tool that was working, the second charges
 * every call twice — so entries are matched on the exact command string and appended only when
 * that string is absent.
 */
export function wire(settings, parts = mounted(), { how = 'npx' } = {}) {
  const out = { ...settings, hooks: { ...(settings.hooks || {}) } };
  let added = 0;
  for (const part of parts) {
    if (!part.present) continue;
    for (const [event, subs] of Object.entries(part.hooks || {})) {
      const existing = Array.isArray(out.hooks[event]) ? [...out.hooks[event]] : [];
      for (const entry of subs) {
        const { sub, matcher } = typeof entry === 'string' ? { sub: entry } : entry;
        const command = runner(part.name, sub, how);
        const already = existing.some((g) => (g.hooks || []).some((h) => same(h.command, command)));
        if (already) continue;
        const group = { hooks: [{ type: 'command', command, timeout: 10 }] };
        if (matcher) group.matcher = matcher;
        existing.push(group);
        added += 1;
      }
      out.hooks[event] = existing;
    }
  }
  return { settings: out, added };
}

export function install({ scope = 'project', cwd = root(), how = 'npx' } = {}) {
  const file = settingsPath(scope, cwd);
  const before = readSettings(file);
  const { settings, added } = wire(before, mounted(), { how });
  if (added === 0) return { file, added: 0, backup: null };
  mkdirSync(dirname(file), { recursive: true });
  let backup = null;
  if (existsSync(file)) {
    // Stamped, not fixed. A single `settings.json.airframe-backup` is overwritten by the next
    // install, so the copy kept is the one made just after the previous install rather than the
    // last known-good file — the two are the same only if nothing was edited in between.
    backup = `${file}.airframe-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    copyFileSync(file, backup);
  }
  // Written beside the target and renamed over it. settings.json is the file the whole editor
  // reads: truncated by a crash or by a second install running at the same time, it does not
  // degrade, it stops Claude Code from starting. rename is the one step the filesystem will
  // not leave half-done.
  const tmp = `${file}.airframe-${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(tmp, file);
  return { file, added, backup };
}

/**
 * Start the sortie for this session.
 *
 * Autonomy is never inferred from the fact that no one has typed anything. It is on when
 * AIRFRAME_AUTONOMY carries a reason — which is exactly the second of the frame's two conditions:
 * somebody deliberately wired this into a loop or a timer, and wrote down why.
 */
export function session(cwd = root()) {
  const reason = process.env.AIRFRAME_AUTONOMY;
  const budget = Number(process.env.AIRFRAME_BUDGET || 0);
  launch({
    mode: 'strike',
    autonomy: !!reason,
    reason: reason || null,
    budget,
  }, cwd);
  return brief(cwd);
}

/**
 * Spend one unit of propellant.
 *
 * The unit is a tool call, because it is the only thing a hook can actually count. Context
 * consumed would be the truer measure and no hook is told it, so rather than dress an
 * unavailable number up as a gauge, this counts the thing it can and says so: AIRFRAME_BUDGET is
 * how many actions a sortie gets.
 *
 * Until this existed, `bingo` could never be reached — the frame had a fuel gauge and nothing
 * connected to it, which meant the one guard that depends on it (not closing to melee with too
 * little left to finish and land) never fired once.
 */
export function spend(cwd = root()) {
  const f = burn(1, cwd);
  if (!f.pastBingo) return null;
  return `airframe: ${f.spent}/${f.budget} spent — past bingo.
Start nothing new. Finish what is open, write it down, and land.`;
}

/**
 * A wingman launched.
 *
 * The frame has always had `actor: 'wingman'` and nothing ever set it, which made fan-out the
 * one thing happening in a sortie that left no trace: eight subagents and the ledger reads
 * exactly like one. Counting them is the whole part — how many were sent is a number a pilot
 * should be able to see afterwards, and cannot otherwise.
 */
export function wingman(cwd = root()) {
  const s = sortie(cwd);
  const sent = ledger(cwd).filter((f) => f.actor === 'wingman' && f.sortie === s.id).length + 1;
  report(finding({
    phase: 'brief',
    source: 'airframe',
    subject: 'wingman',
    observed: { sent },
    actor: 'wingman',
  }), cwd);
  return null; // it says nothing to the subagent: habit already hands that one what it needs
}

/**
 * Land.
 *
 * A sortie that just stops leaves a ledger nobody can read as a day's work: findings, and no
 * sense of what the whole thing was. This writes the one line that closes it, and it is also
 * what makes the next brief worth reading.
 */
export function land(cwd = root()) {
  const s = sortie(cwd);
  if (!s.id) return null;
  const mine = ledger(cwd).filter((f) => f.sortie === s.id);
  if (!mine.length) return null;
  const worst = mine.some((f) => f.severity === 'stop') ? 'stop'
    : mine.some((f) => f.severity === 'warn') ? 'warn' : 'note';
  report(finding({
    phase: 'post',
    source: 'airframe',
    severity: 'note',
    subject: 'sortie',
    observed: { findings: mine.length, worst, spent: s.propellant.spent, mode: s.mode },
    note: s.melee ? `landed still committed to "${s.melee.action}"` : undefined,
  }), cwd);
  return null;
}

/**
 * Mount anything that runs and exits.
 *
 * A linter, a build, a test run, a check somebody else wrote. None of them know this frame
 * exists and none of them need to: what they have is an exit code and something they printed,
 * which is a finding already. Wrapping the call is the whole integration.
 *
 * Phase is `brief` because this is ground inspection — it happens around the sortie, not inside
 * one. A non-zero exit is a `warn`, not a `stop`: a linter has no business halting a machine.
 */
export function mount(command, args, { as, cwd = root() } = {}) {
  const r = spawnSync(command, args, { cwd, encoding: 'utf8', shell: false, windowsHide: true });
  const out = `${r.stdout || ''}${r.stderr || ''}`.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const code = r.status === null ? -1 : r.status;
  report(finding({
    phase: 'brief',
    source: as || command,
    severity: code === 0 ? 'note' : 'warn',
    subject: [command, ...args].join(' '),
    observed: { exit: code, said: out.slice(-3) },
    expected: 0,
  }), cwd);
  return { code, out };
}

export function status(cwd = root()) {
  const s = sortie(cwd);
  const f = fuel(s);
  const parts = mounted();
  const spent = ledger(cwd)
    .filter((x) => x.source === 'redline' && x.phase === 'pre' && x.sortie === s.id)
    .reduce((n, x) => n + (x.observed?.points || 0), 0);
  const lines = [
    s.id ? `sortie   ${s.id}` : 'sortie   not launched — run "airframe launch"',
    `form     ${s.mode}${s.mode === 'strike' ? ` / ${s.range}` : ''}${s.autonomy ? `  (autonomous: ${s.autonomyReason})` : ''}`,
    `limiter  ${spent}`,
    `wingmen  ${ledger(cwd).filter((x) => x.actor === 'wingman' && x.sortie === s.id).length}`,
    `fuel     ${f.budget ? `${f.spent}/${f.budget}${f.pastBingo ? '  — past bingo, break off and land' : ''}` : `${f.spent} (no budget set)`}`,
  ];
  if (s.melee) lines.push(`melee    committed to "${s.melee.action}" — exit: ${s.melee.exit}`);
  lines.push('mounted');
  for (const p of parts) lines.push(`  ${p.present ? '+' : '-'} ${p.name.replace('@hyuga/', '').padEnd(13)} ${p.is}`);
  return lines.join('\n');
}

// ---------------- CLI ----------------

export function main(argv) {
  const [cmd, ...rest] = argv;
  const val = (n) => { const i = rest.indexOf(`--${n}`); return i === -1 ? undefined : rest[i + 1]; };

  if (cmd === 'hook') {
    try {
      if (rest[0] === 'session') emit('SessionStart', session());
      else if (rest[0] === 'burn') emit('PostToolUse', spend());
      else if (rest[0] === 'wingman') wingman();
      else if (rest[0] === 'land') land();
    } catch { /* a hook must never cost the session */ }
    return 0;
  }

  if (cmd === 'install') {
    const r = install({
      scope: rest.includes('--user') ? 'user' : 'project',
      how: rest.includes('--local') ? 'local' : rest.includes('--bin') ? 'bin' : 'npx',
    });
    if (r.added === 0) {
      console.log(`airframe: already wired in ${r.file}`);
      return 0;
    }
    console.log(`airframe: wired ${r.added} hook(s) into ${r.file}`);
    if (r.backup) console.log(`        previous settings kept at ${r.backup}`);
    console.log('        restart Claude Code for them to take effect.');
    return 0;
  }

  if (cmd === 'launch') {
    const reason = val('reason');
    const s = launch({
      mode: rest[0] && !rest[0].startsWith('--') ? rest[0] : 'strike',
      autonomy: rest.includes('--autonomy'),
      reason,
      budget: Number(val('budget') || 0),
    });
    console.log(`airframe: sortie ${s.id} — ${s.mode}${s.autonomy ? ` (autonomous: ${s.autonomyReason})` : ''}`);
    return 0;
  }

  if (cmd === 'mode') {
    if (!rest[0]) { console.log(sortie().mode); return 0; }
    console.log(`airframe: ${transform(rest[0]).mode}`);
    return 0;
  }

  if (cmd === 'discard') {
    discard(rest[0], rest.slice(1).join(' ') || 'no reason recorded');
    console.log('airframe: kept.');
    return 0;
  }

  if (cmd === 'mount') {
    const at = rest.indexOf('--');
    const argv = at === -1 ? rest.filter((a) => a !== '--as' && a !== val('as')) : rest.slice(at + 1);
    if (!argv.length) { console.error('airframe: nothing to mount — airframe mount [--as name] -- <command> [args]'); return 1; }
    const r = mount(argv[0], argv.slice(1), { as: val('as') });
    console.log(`airframe: ${val('as') || argv[0]} exited ${r.code} — filed`);
    return r.code === 0 ? 0 : 1;
  }

  if (cmd === 'status' || cmd === undefined) {
    console.log(status());
    return 0;
  }

  console.log(`airframe — 器. The machine: a frame, and whichever parts are mounted on it.

  airframe install [--user] [--bin]
                            wire the mounted parts' hooks into settings.json
                            --user  write to ~/.claude/settings.json, for every project
                            --bin   call the installed binaries instead of npx, for when
                                    the packages came from "npm i -g" rather than a registry
                            --local call the checked-out files by absolute path — no install,
                                    no registry, just the folders you cloned
  airframe status             mode, range, what this sortie has spent, what is mounted
  airframe launch [strike|cruise] [--budget N] [--autonomy --reason "..."]
  airframe mode [strike|cruise]
                            strike converges and is policed; cruise diverges and is not
  airframe discard <subject> <reason>
                            put something down on purpose, and keep why
  airframe mount [--as name] -- <command> [args]
                            run anything and file its exit code as a finding. This is how a
                            linter, a build or a test run gets onto the frame without knowing
                            the frame exists

  Sorties start on their own once installed — SessionStart launches one and hands back what
  the last one left unfinished, along with anything you put down on purpose.

  Set AIRFRAME_AUTONOMY to the reason you are running unattended (a loop, a timer). That, and
  only that, is what lets a part halt the machine instead of advising you.
  Set AIRFRAME_BUDGET to declare how much propellant a sortie has.
`);
  return 0;
}

if (runDirectly(import.meta.url)) process.exit(main(process.argv.slice(2)));
