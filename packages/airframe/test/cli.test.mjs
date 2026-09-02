/**
 * Start the machine's own CLI and check what it does.
 *
 * `install` is the reason this file exists. It rewrites settings.json — the file the whole
 * editor reads — and the two ways it can go wrong are both silent: dropping a hook somebody
 * else put there loses a working tool, and adding a second copy of one of ours charges every
 * call twice. Neither produces an error, and a truncated settings.json does not degrade, it
 * stops Claude Code from starting.
 *
 * Everything here runs in a temporary working directory. Nothing touches the real
 * ~/.claude/settings.json, and no test passes --user.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, '..', 'src', 'airframe.mjs');

function work(t) {
  const dir = mkdtempSync(join(tmpdir(), 'airframe-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, home: join(dir, '.spar'), settings: join(dir, '.claude', 'settings.json') };
}

function run(w, args, { stdin = '', env = {} } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    input: stdin,
    cwd: w.dir,
    encoding: 'utf8',
    // CLAUDE_PROJECT_DIR is pinned to the temp dir. Under a Claude Code hook it names the real
    // project — and when that project is the home directory, its .claude/settings.json is the
    // user's own. Left inherited, `install` in these tests would target that file.
    env: { ...process.env, SPAR_HOME: w.home, CLAUDE_PROJECT_DIR: w.dir, ...env },
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const settingsOf = (w) => JSON.parse(readFileSync(w.settings, 'utf8'));
const commandsIn = (s) => Object.values(s.hooks || {})
  .flat().flatMap((g) => (g.hooks || []).map((h) => h.command));

test('status runs before anything has been launched, and says so', (t) => {
  const w = work(t);
  const r = run(w, ['status']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /not launched/);
  assert.match(r.out, /mounted/);
  // spar is absent on purpose: it is the frame, not something mounted on it.
  assert.match(r.out, /\+ redline/, 'the parts it can see are listed');
  assert.doesNotMatch(r.out, /spar/);
});

test('a bare invocation is status, not a silent success', (t) => {
  const w = work(t);
  assert.match(run(w, []).out, /sortie/);
});

test('launch then status reports the form the machine is in', (t) => {
  const w = work(t);
  assert.equal(run(w, ['launch', 'strike', '--budget', '10']).code, 0);
  const s = run(w, ['status']);
  assert.match(s.out, /form\s+strike \/ fire/);
  assert.match(s.out, /fuel\s+0\/10/);
  run(w, ['mode', 'cruise']);
  assert.match(run(w, ['status']).out, /form\s+cruise/);
});

// ---------------- install ----------------

test('install writes the hooks, and says where and how many', (t) => {
  const w = work(t);
  const r = run(w, ['install']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /wired \d+ hook\(s\)/);
  assert.match(r.out, /restart Claude Code/);
  const cmds = commandsIn(settingsOf(w));
  assert.ok(cmds.some((c) => c.includes('@hyuga/airframe hook session')));
  assert.ok(cmds.some((c) => c.includes('@hyuga/redline hook pre')));
});

/** Adding a second copy of one of ours charges every call twice, and says nothing about it. */
test('install twice adds nothing the second time', (t) => {
  const w = work(t);
  run(w, ['install']);
  const first = commandsIn(settingsOf(w));
  const again = run(w, ['install']);
  assert.equal(again.code, 0);
  assert.match(again.out, /already wired/);
  assert.deepEqual(commandsIn(settingsOf(w)), first);
});

/** Dropping a hook somebody else put there loses a tool that was working. */
test('install leaves hooks that were already there alone', (t) => {
  const w = work(t);
  mkdirSync(dirname(w.settings), { recursive: true });
  writeFileSync(w.settings, JSON.stringify({
    model: 'claude-opus-5',
    permissions: { allow: ['Bash(npm test)'] },
    hooks: {
      PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'node ./mine.mjs' }] }],
      SessionStart: [{ hooks: [{ type: 'command', command: 'echo hello' }] }],
    },
  }, null, 2));

  assert.equal(run(w, ['install']).code, 0);
  const after = settingsOf(w);
  const cmds = commandsIn(after);
  assert.ok(cmds.includes('node ./mine.mjs'), 'somebody else\'s PreToolUse hook survived');
  assert.ok(cmds.includes('echo hello'), 'and their SessionStart hook did too');
  assert.equal(after.model, 'claude-opus-5', 'settings that are not hooks are untouched');
  assert.deepEqual(after.permissions.allow, ['Bash(npm test)']);
});

/**
 * Found against a real settings.json: a part wired by hand as `node C:/x/habit.mjs hook pre`
 * against a generated line that quotes the path. Compared literally those are two strings.
 * Quoting, slashes and runs of whitespace are spelling; the command is the same command.
 */
test('a hook already wired by hand, spelled differently, is recognised as the same one', (t) => {
  const w = work(t);
  run(w, ['install', '--local']);
  const generated = commandsIn(settingsOf(w)).find((c) => c.includes('redline'));
  assert.ok(generated, 'a local-path command was generated');

  const w2 = work(t);
  const byHand = generated.replace(/"/g, '').split('/').join('\\').replace(/ +/g, '   ');
  mkdirSync(dirname(w2.settings), { recursive: true });
  writeFileSync(w2.settings, JSON.stringify({
    hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: byHand }] }] },
  }));
  run(w2, ['install', '--local']);
  // Compared the way wire() compares them, since the point is that spelling is not identity.
  const flat = (c) => String(c).replace(/["']/g, '').split('\\').join('/').replace(/\s+/g, ' ')
    .trim();
  const all = commandsIn(settingsOf(w2));
  const redlinePre = all.filter((c) => flat(c) === flat(byHand));
  assert.equal(redlinePre.length, 1, `wired twice: ${JSON.stringify(all)}`);
});

test('install keeps the previous settings, under a name the next install cannot overwrite', (t) => {
  const w = work(t);
  mkdirSync(dirname(w.settings), { recursive: true });
  writeFileSync(w.settings, JSON.stringify({ model: 'claude-opus-5' }));
  const r = run(w, ['install']);
  assert.match(r.out, /previous settings kept at/);
  // In backups/ beside settings.json (~/.claude/backups/ for --user), not as a sibling of it.
  const dir = join(dirname(w.settings), 'backups');
  const backups = readdirSync(dir).filter((f) => f.endsWith('-airframe-install'));
  assert.equal(backups.length, 1);
  assert.match(backups[0], /^settings\.json\.\d{4}-\d{2}-\d{2}-\d{6}-airframe-install$/);
  assert.match(readFileSync(join(dir, backups[0]), 'utf8'), /claude-opus-5/);
  assert.deepEqual(readdirSync(dirname(w.settings)).sort(), ['backups', 'settings.json'],
    'nothing beside settings.json: no backup, no temporary file it renames from');
});

/**
 * settings.json is the file the whole editor reads. Overwriting one that does not parse would
 * turn somebody's typo into a lost configuration.
 */
test('install refuses a settings.json it cannot parse, and does not overwrite it', (t) => {
  const w = work(t);
  mkdirSync(dirname(w.settings), { recursive: true });
  writeFileSync(w.settings, '{ "hooks": [ this is not json');
  const r = run(w, ['install']);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /not valid JSON/);
  assert.match(readFileSync(w.settings, 'utf8'), /this is not json/, 'left exactly as it was');
});

test('--bin and --local name the part differently, and both stay recognisable', (t) => {
  const bin = work(t);
  run(bin, ['install', '--bin']);
  assert.ok(commandsIn(settingsOf(bin)).some((c) => c.startsWith('redline hook pre')));
  const local = work(t);
  run(local, ['install', '--local']);
  assert.ok(commandsIn(settingsOf(local)).some((c) => c.startsWith('node "') && c.includes('redline')));
});

// ---------------- the hooks and mount ----------------

test('the session hook launches a sortie without anybody remembering to', (t) => {
  const w = work(t);
  const r = run(w, ['hook', 'session']);
  assert.equal(r.code, 0);
  assert.match(run(w, ['status']).out, /sortie\s+\d{4}-/, 'a sortie exists now');
});

test('autonomy is on only when somebody wrote down why', (t) => {
  const w = work(t);
  run(w, ['hook', 'session']);
  assert.doesNotMatch(run(w, ['status']).out, /autonomous/);
  const w2 = work(t);
  run(w2, ['hook', 'session'], { env: { AIRFRAME_AUTONOMY: 'wired into a nightly loop' } });
  assert.match(run(w2, ['status']).out, /autonomous: wired into a nightly loop/);
});

test('the burn hook spends propellant and speaks only once past bingo', (t) => {
  const w = work(t);
  run(w, ['hook', 'session'], { env: { AIRFRAME_BUDGET: '10' } });
  for (let i = 0; i < 6; i += 1) {
    assert.equal(run(w, ['hook', 'burn']).out.trim(), '', `call ${i + 1} is not worth interrupting for`);
  }
  const past = run(w, ['hook', 'burn']); // 7 of 10, bingo is 0.7
  assert.match(JSON.parse(past.out).hookSpecificOutput.additionalContext, /past bingo/);
});

test('a hook that was handed nothing it understands never costs the session', (t) => {
  const w = work(t);
  for (const sub of ['session', 'burn', 'wingman', 'land', 'nonsense']) {
    const r = run(w, ['hook', sub], { stdin: '{' });
    assert.equal(r.code, 0, `${sub}: ${r.out}`);
  }
});

test('wingmen are counted, because fan-out otherwise leaves no trace', (t) => {
  const w = work(t);
  run(w, ['hook', 'session']);
  assert.match(run(w, ['status']).out, /wingmen\s+0/);
  run(w, ['hook', 'wingman']);
  run(w, ['hook', 'wingman']);
  assert.match(run(w, ['status']).out, /wingmen\s+2/);
});

/** Wrapping the call is the whole integration: a linter has an exit code, and that is a finding. */
test('mount runs anything and files its exit code', (t) => {
  const w = work(t);
  run(w, ['hook', 'session']);
  const ok = run(w, ['mount', '--as', 'greet', '--', process.execPath, '-e', 'console.log("hi")']);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /greet exited 0 — filed/);

  const bad = run(w, ['mount', '--', process.execPath, '-e', 'process.exit(3)']);
  assert.equal(bad.code, 1, 'a non-zero exit is reported to the caller');
  assert.match(bad.out, /exited 3 — filed/);

  const ledger = readFileSync(join(w.home, 'ledger.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const filed = ledger.find((f) => f.source === 'greet');
  assert.ok(filed, 'it is in the ledger under the name it was given');
  assert.equal(filed.observed.exit, 0);
  assert.equal(filed.severity, 'note');
  assert.equal(ledger.find((f) => f.observed?.exit === 3).severity, 'warn',
    'a linter has no business halting a machine');
});

test('mount with nothing to run says so instead of doing nothing quietly', (t) => {
  const w = work(t);
  const r = run(w, ['mount']);
  assert.equal(r.code, 1);
  assert.match(r.out, /nothing to mount/);
});

test('landing closes the sortie with a line the next brief can read', (t) => {
  const w = work(t);
  run(w, ['hook', 'session']);
  run(w, ['hook', 'wingman']);
  assert.equal(run(w, ['hook', 'land']).code, 0);
  const ledger = readFileSync(join(w.home, 'ledger.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const landed = ledger.find((f) => f.source === 'airframe' && f.subject === 'sortie');
  assert.ok(landed, 'the sortie was closed');
  assert.equal(landed.observed.mode, 'strike');
  assert.equal(typeof landed.observed.findings, 'number');
});

test('landing a sortie that did nothing writes nothing', (t) => {
  const w = work(t);
  run(w, ['hook', 'session']);
  const before = existsSync(join(w.home, 'ledger.jsonl'))
    ? readFileSync(join(w.home, 'ledger.jsonl'), 'utf8') : '';
  run(w, ['hook', 'land']);
  const after = existsSync(join(w.home, 'ledger.jsonl'))
    ? readFileSync(join(w.home, 'ledger.jsonl'), 'utf8') : '';
  assert.equal(after, before);
});

test('discard from the machine keeps what was put down', (t) => {
  const w = work(t);
  run(w, ['launch', 'cruise']);
  assert.match(run(w, ['discard', 'the plugin idea', 'no', 'second', 'user']).out, /kept/);
  const ledger = readFileSync(join(w.home, 'ledger.jsonl'), 'utf8');
  assert.match(ledger, /the plugin idea/);
  assert.match(ledger, /no second user/);
});

test('an unknown subcommand prints the help rather than pretending to have worked', (t) => {
  const w = work(t);
  const r = run(w, ['nonsense']);
  assert.equal(r.code, 0);
  assert.match(r.out, /airframe install/);
  assert.match(r.out, /AIRFRAME_AUTONOMY/);
});
