/**
 * Start the limiter's own CLI and check what it does.
 *
 * A hook is the only shape redline is ever really used in, and until this file existed not one
 * test went through it. `check()` was well covered and `main()` — reading stdin, choosing an
 * envelope, deciding whether to be silent — was not run at all.
 *
 * The two failures that matter here are both invisible from the outside. A limiter that throws
 * on a malformed payload takes the session with it, and a limiter that answers "deny" when it
 * meant "advise" stops a human who was in the seat. Neither shows up as a wrong number.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, '..', 'src', 'redline.mjs');
// Resolved, not composed from a path. npm workspaces hoists the link to the root
// node_modules, so `../node_modules/@hyuga/spar` does not exist — and spawnSync answers a
// missing file with status null rather than by throwing, so every launch would have been a
// silent no-op and these tests would have passed against a sortie that never started.
const SPAR = createRequire(import.meta.url).resolve('@hyuga/spar');

function frame(t) {
  const dir = mkdtempSync(join(tmpdir(), 'redline-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(home, args, { stdin = '', cwd = home, env = {} } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    input: stdin,
    cwd,
    encoding: 'utf8',
    env: { ...process.env, SPAR_HOME: home, ...env },
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function launch(home, extra = []) {
  const r = spawnSync(process.execPath, [SPAR, 'launch', 'strike', ...extra], {
    encoding: 'utf8',
    env: { ...process.env, SPAR_HOME: home },
  });
  // Checked, because a launch that did not happen leaves every sortie id null — and findings
  // filed under a null id all match each other, so the per-sortie tests below would pass while
  // measuring nothing.
  assert.equal(r.status, 0, `launch failed: ${r.stdout ?? ''}${r.stderr ?? ''}${r.error ?? ''}`);
}

const call = (command) => JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
const write = (file_path) => JSON.stringify({ tool_name: 'Write', tool_input: { file_path } });
const spoke = (prompt) => JSON.stringify({ prompt });

/** The hook's reply, or null when it said nothing. */
const said = (r) => (r.out.trim() ? JSON.parse(r.out).hookSpecificOutput : null);

test('the bin runs at all, and prints how to wire it', (t) => {
  const home = frame(t);
  const r = run(home, []);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /PreToolUse/);
  assert.match(r.out, /UserPromptSubmit/);
});

test('nothing on stdin is not an error — a plain invocation has none', (t) => {
  const home = frame(t);
  const r = run(home, ['hook', 'pre'], { stdin: '' });
  assert.equal(r.code, 0);
  assert.equal(r.out.trim(), '');
});

/**
 * A limiter that breaks the session is worse than no limiter. Every one of these is something a
 * hook can genuinely be handed, and the only acceptable answer to all of them is silence.
 */
test('a payload it cannot make sense of costs the session nothing', (t) => {
  const home = frame(t);
  launch(home);
  for (const stdin of ['{', 'null', '[]', '"a string"', '{"tool_input":null}', '{"tool_name":42}']) {
    const r = run(home, ['hook', 'pre'], { stdin });
    assert.equal(r.code, 0, `${stdin}: ${r.out}`);
    assert.equal(r.out.trim(), '', `${stdin} should have said nothing`);
  }
});

test('a call that costs nothing is not spoken about', (t) => {
  const home = frame(t);
  launch(home);
  const r = run(home, ['hook', 'pre'], { stdin: call('ls -la') });
  assert.equal(r.code, 0);
  assert.equal(r.out.trim(), '', 'silence is the normal case');
});

test('an irreversible call reaches the limit and is advised, not denied', (t) => {
  const home = frame(t);
  launch(home);
  const out = said(run(home, ['hook', 'pre'], { stdin: call('rm -rf build') }));
  assert.ok(out, 'it said something');
  assert.equal(out.hookEventName, 'PreToolUse');
  assert.equal(out.permissionDecision, undefined, 'a pilot who is flying is told, not overruled');
  assert.match(out.additionalContext, /irreversible \+3/);
  assert.match(out.additionalContext, /it is your call/);
});

/**
 * The distinction the whole part rests on. `additionalContext` is text a model reads and can
 * talk itself out of, which is right for advice and wrong for a halt — with nobody in the seat
 * there is no one to overrule it, so the call itself has to be denied.
 */
test('with nobody in the seat the same call is denied outright', (t) => {
  const home = frame(t);
  launch(home, ['--autonomy', '--reason', 'wired into a nightly loop on purpose']);
  const out = said(run(home, ['hook', 'pre'], { stdin: call('rm -rf build') }));
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /nobody in the seat/);
  assert.equal(out.additionalContext, undefined);
});

test('the score is summed out of the ledger and only ever goes up inside a sortie', (t) => {
  const home = frame(t);
  launch(home);
  assert.match(run(home, ['score']).out, /0 spent/);
  run(home, ['hook', 'pre'], { stdin: call('npm install left-pad') });
  const one = run(home, ['score']);
  assert.equal(one.code, 0, 'below the limit, so the command succeeds');
  assert.match(one.out, /1 spent/);
  run(home, ['hook', 'pre'], { stdin: call('git push') });
  const past = run(home, ['score']);
  assert.equal(past.code, 1, 'at or past the limit, so the command reports it');
  assert.match(past.out, /4 spent/);
});

test('a new sortie starts from zero', (t) => {
  const home = frame(t);
  launch(home);
  run(home, ['hook', 'pre'], { stdin: call('rm -rf build') });
  assert.match(run(home, ['score']).out, /3 spent/);
  launch(home);
  assert.match(run(home, ['score']).out, /0 spent/);
});

/**
 * This limiter cost itself its own credibility before it cost anybody anything else: a session
 * that only ever searched for the string `npm publish` reached 20 against a limit of 3, and
 * every one of those charges was a quotation.
 */
test('reading about a dangerous command is not doing one', (t) => {
  const home = frame(t);
  launch(home);
  for (const c of ['grep "npm publish" README.md', 'cat deploy.sh', 'echo "rm -rf /"']) {
    const r = run(home, ['hook', 'pre'], { stdin: call(c) });
    assert.equal(r.out.trim(), '', `${c} should be free`);
  }
  assert.match(run(home, ['score']).out, /0 spent/);
});

test('a heredoc body is the file being written, not a list of commands', (t) => {
  const home = frame(t);
  launch(home);
  run(home, ['hook', 'pre'], { stdin: call("cat > t.mjs <<'EOF'\nassert(run('rm -rf build'));\nEOF") });
  assert.match(run(home, ['score']).out, /0 spent/, 'the body never ran, so it is never charged');
});

test('production is whatever this repository says it is', (t) => {
  const home = frame(t);
  launch(home);
  const free = run(home, ['hook', 'pre'], { stdin: write('/var/www/index.html') });
  assert.equal(free.out.trim(), '', 'with no config, nothing is production');
  writeFileSync(join(home, '.redline.json'), JSON.stringify({ production: ['/var/www/'] }));
  const charged = said(run(home, ['hook', 'pre'], { stdin: write('/var/www/index.html') }));
  assert.match(charged.additionalContext, /production \+2/);
});

test('the config is found in the home directory when the work is somewhere else entirely', (t) => {
  const home = frame(t);
  launch(home);
  const elsewhere = mkdtempSync(join(tmpdir(), 'redline-work-'));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  writeFileSync(join(home, '.redline.json'), JSON.stringify({ production: ['/var/www/'] }), 'utf8');

  const out = said(run(home, ['hook', 'pre'], {
    stdin: write('/var/www/index.html'),
    cwd: elsewhere,
    env: { HOME: home, USERPROFILE: home },
  }));
  assert.match(out.additionalContext, /production \+2/,
    'nothing above the working directory says anything, so the home directory has the last word');
});

/**
 * Without the prompt hook redline cannot tell a file you asked for from one it chose itself,
 * and does not charge for that at all rather than guessing. With it, it can tell — and still
 * does not charge, because a skill knows its own filenames and the human never says them.
 */
test('the prompt hook records the scope, and a file outside it is written down for free', (t) => {
  const home = frame(t);
  launch(home);
  assert.equal(run(home, ['hook', 'pre'], { stdin: write('/tmp/whatever.md') }).out.trim(), '',
    'no scope recorded: nothing is unasked-for');
  const p = run(home, ['hook', 'prompt'], { stdin: spoke('please fix notes.md') });
  assert.equal(p.code, 0);
  assert.equal(p.out.trim(), '', 'the prompt hook is silent — it only writes down what was named');
  run(home, ['hook', 'pre'], { stdin: write('/tmp/notes.md') });
  assert.match(run(home, ['score']).out, /0 spent/, 'a file the human named is free');

  // And so is one they did not name. Three writes nobody asked for used to be a stop, and a
  // skill reaches three before it has finished starting — which is how the whole limit got
  // spent on the work instead of on the exposure.
  for (const f of ['/tmp/whatever.md', '/tmp/another.md', '/tmp/third.md']) {
    assert.equal(said(run(home, ['hook', 'pre'], { stdin: write(f) })), null, f + ' is silent');
  }
  assert.match(run(home, ['score']).out, /0 spent/, 'written down, not charged');
});

/**
 * The shape of a skill invocation: a task is named and no filenames are. Everything the run
 * writes is then the agent's own idea, which is exactly when it is worth having on the record —
 * and it was the one case that left no record at all, because a prompt naming nothing filed
 * nothing, and a missing brief reads as "the hook is not installed".
 */
test('a prompt that names no file still says so, and what follows is written down', (t) => {
  const home = frame(t);
  launch(home);
  const p = run(home, ['hook', 'prompt'], { stdin: spoke('run the karte for the ski resort') });
  assert.equal(p.out.trim(), '', 'still silent');

  assert.equal(said(run(home, ['hook', 'pre'], { stdin: write('/tmp/_targets.yml') })), null,
    'unnamed costs nothing, so it interrupts nobody');
  assert.match(run(home, ['score']).out, /0 spent/);

  const filed = readFileSync(join(home, 'ledger.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((f) => f.source === 'redline');
  assert.deepEqual(filed[0].observed, [], 'the brief says: they named none');
  assert.deepEqual(filed[1].observed.kinds, ['unnamed'], 'and the write is on the record');
});

test('an unknown subcommand prints the help rather than pretending to have worked', (t) => {
  const home = frame(t);
  const r = run(home, ['nonsense']);
  assert.equal(r.code, 0);
  assert.match(r.out, /A limiter that counts the sortie/);
});
