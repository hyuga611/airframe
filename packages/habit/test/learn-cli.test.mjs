/**
 * `habit validate` decides which rules survive, and it had never been run.
 *
 * The function behind it is well covered; the command around it was not. src/habit.mjs sat at
 * 48.32% and everything uncovered was a subcommand — corpus, validate, score, accept, reject,
 * export, ledger, log. validate is the one that matters most: it is the only thing standing
 * between a rule an agent invented and a sentence injected into every session from then on.
 *
 * An instruction can be ignored. This cannot — which is exactly why it has to be checked that
 * it still refuses, and refuses for the right reason, through the path a person actually uses.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, '..', 'src', 'habit.mjs');

const HOME = mkdtempSync(join(tmpdir(), 'habit-learn-cli-'));
process.env.HABIT_HOME = HOME;

const { STORE } = await import('../src/habit.mjs');

const CORRECTIONS = join(STORE, 'corrections');
const RULES = join(STORE, 'rules.json');
const LEDGER = join(STORE, 'ledger.json');

function cli(args, { cwd } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, HABIT_HOME: HOME },
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** A store with nothing in it. validate reads the whole directory, so leftovers are noise. */
function fresh() {
  rmSync(CORRECTIONS, { recursive: true, force: true });
  rmSync(RULES, { force: true });
  rmSync(LEDGER, { force: true });
  mkdirSync(CORRECTIONS, { recursive: true });
}

/** One correction on disk. The filename is the id a rule has to cite. */
function correction(id, { file = 'notes.md', promptId, removed = ['// 日本語'], added = ['// English'] } = {}) {
  writeFileSync(join(CORRECTIONS, `${id}.json`), JSON.stringify({
    kind: 'edited',
    file: join('/work', file),
    detectedAt: '2026-08-20T00:00:00.000Z',
    writtenAt: '2026-08-20T00:00:00.000Z',
    askedFor: 'write the comments in English',
    promptId,
    removed,
    added,
    removedCount: removed.length,
    addedCount: added.length,
  }, null, 2), 'utf8');
  return id;
}

/** A rules file, in the shape the skill is told to produce. */
function rulesFile(t, rules, skipped = 'nothing else recurred') {
  const dir = mkdtempSync(join(tmpdir(), 'habit-rules-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = join(dir, 'rules.json');
  writeFileSync(f, JSON.stringify({ rules, skipped }, null, 2), 'utf8');
  return f;
}

const rule = (evidence, text = 'Write comments in English.') => ({
  rule: text, why: 'observed twice', scope: '*', evidence, confidence: 'high',
});

// ---------------- corpus ----------------

test('corpus says so plainly when there is nothing to read', () => {
  fresh();
  const r = cli(['corpus']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /nothing recorded yet/);
});

test('corpus prints the corrections under the ids a rule has to cite', () => {
  fresh();
  correction('2026-08-20-a', { file: 'index.html' });
  correction('2026-08-21-b', { file: 'about.html' });
  const r = cli(['corpus']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /# 2 correction\(s\)/);
  assert.match(r.out, /2026-08-20-a/);
  assert.match(r.out, /2026-08-21-b/);
});

// ---------------- validate: the refusals ----------------

test('validate needs a file, and says which one it wanted', () => {
  fresh();
  const r = cli(['validate']);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /habit validate <rules\.json>/);
});

test('a rules file that is not JSON is a usage error, not an empty rule set', (t) => {
  fresh();
  const dir = mkdtempSync(join(tmpdir(), 'habit-rules-bad-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = join(dir, 'rules.json');
  writeFileSync(f, '{ "rules": [ this is not json', 'utf8');
  const r = cli(['validate', f]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /cannot read/);
});

test('a file that is not there at all is refused the same way', () => {
  fresh();
  const r = cli(['validate', join(tmpdir(), 'habit-no-such-rules.json')]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /cannot read/);
});

/**
 * The whole point. An agent told to cite two corrections will usually do it, and the times it
 * does not are exactly the times the rule was invented.
 */
test('a rule citing ids that do not exist is dropped, and nothing is saved', (t) => {
  fresh();
  correction('2026-08-20-a');
  const f = rulesFile(t, [rule(['made-up-1', 'made-up-2'])]);
  const r = cli(['validate', f, '--save']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /cites corrections that do not exist/);
  assert.match(r.out, /cited 2, 0 real/);
  assert.match(r.out, /Nothing was saved/);
  assert.equal(existsSync(RULES), false, 'and nothing reached rules.json');
});

test('one correction is not yet a habit', (t) => {
  fresh();
  correction('2026-08-20-a');
  const f = rulesFile(t, [rule(['2026-08-20-a'])]);
  const r = cli(['validate', f]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /only one correction behind it/);
  assert.match(r.out, /0 rule\(s\) kept, 1 dropped/);
});

/**
 * "Stop using emoji" said once, then three files rewritten, is one thing a person said. If
 * those three can be cited to clear a two-witness gate, the gate means nothing.
 */
test('two corrections from one turn are one observation, and do not clear the gate', (t) => {
  fresh();
  correction('2026-08-20-a', { file: 'a.html', promptId: 'P1' });
  correction('2026-08-20-b', { file: 'b.html', promptId: 'P1' });
  const f = rulesFile(t, [rule(['2026-08-20-a', '2026-08-20-b'])]);
  const r = cli(['validate', f]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /only one turn behind it — one sentence produced them all/);
});

test('the same two corrections from different turns do clear it', (t) => {
  fresh();
  correction('2026-08-20-a', { file: 'a.html', promptId: 'P1' });
  correction('2026-08-21-b', { file: 'b.html', promptId: 'P2' });
  const f = rulesFile(t, [rule(['2026-08-20-a', '2026-08-21-b'])]);
  const r = cli(['validate', f]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /1 rule\(s\) kept, 0 dropped/);
});

/** Records written before promptId existed carry none. Assuming they shared a turn would drop
 *  a real rule on evidence nobody has. */
test('corrections with no promptId each count as their own observation', (t) => {
  fresh();
  correction('2026-08-20-a', { file: 'a.html' });
  correction('2026-08-21-b', { file: 'b.html' });
  const f = rulesFile(t, [rule(['2026-08-20-a', '2026-08-21-b'])]);
  assert.equal(cli(['validate', f]).code, 0);
});

test('one bad rule among good ones fails the whole file, and saves none of it', (t) => {
  fresh();
  correction('2026-08-20-a', { promptId: 'P1' });
  correction('2026-08-21-b', { promptId: 'P2' });
  const f = rulesFile(t, [
    rule(['2026-08-20-a', '2026-08-21-b'], 'Write comments in English.'),
    rule(['invented'], 'Never use tabs.'),
  ]);
  const r = cli(['validate', f, '--save']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /1 rule\(s\) kept, 1 dropped/);
  assert.equal(existsSync(RULES), false, 'the good rule is not saved either');
});

// ---------------- validate --save ----------------

test('without --save a passing file is reported and nothing is written', (t) => {
  fresh();
  correction('2026-08-20-a', { promptId: 'P1' });
  correction('2026-08-21-b', { promptId: 'P2' });
  const f = rulesFile(t, [rule(['2026-08-20-a', '2026-08-21-b'])]);
  assert.equal(cli(['validate', f]).code, 0);
  assert.equal(existsSync(RULES), false);
  assert.equal(existsSync(LEDGER), false);
});

test('--save writes the rules, records them as predictions, and says how many can be scored', (t) => {
  fresh();
  correction('2026-08-20-a', { file: 'a.html', promptId: 'P1', removed: ['<!-- 日本語 -->'] });
  correction('2026-08-21-b', { file: 'b.html', promptId: 'P2', removed: ['<!-- 日本語 -->'] });
  const f = rulesFile(t, [rule(['2026-08-20-a', '2026-08-21-b'])]);
  const r = cli(['validate', f, '--save']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /saved to/);
  assert.match(r.out, /1 of 1 can be scored later/);

  const saved = JSON.parse(readFileSync(RULES, 'utf8'));
  assert.equal(saved.rules.length, 1);
  assert.deepEqual(saved.rules[0].evidence, ['2026-08-20-a', '2026-08-21-b']);
  assert.equal(saved.skipped, 'nothing else recurred');

  const ledger = JSON.parse(readFileSync(LEDGER, 'utf8'));
  assert.equal(ledger.proposals.length, 1);
  assert.equal(ledger.proposals[0].accepted, null, 'adoption is a person\'s call, not a default');
  assert.equal(ledger.proposals[0].marker, '<!-- 日本語 -->',
    'the marker is derived from the evidence, not written by whatever is being graded');
});

/**
 * A rule whose citations share no repeated line cannot be recognised if it recurs. It still
 * applies; it just cannot be graded, and saying so is the point.
 */
test('a rule with no shared line is saved, and counted as one that cannot be scored', (t) => {
  fresh();
  correction('2026-08-20-a', { file: 'a.html', promptId: 'P1', removed: ['one thing'] });
  correction('2026-08-21-b', { file: 'b.html', promptId: 'P2', removed: ['a different thing'] });
  const f = rulesFile(t, [rule(['2026-08-20-a', '2026-08-21-b'])]);
  const r = cli(['validate', f, '--save']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /0 of 1 can be scored later/);
  assert.match(r.out, /share no repeated line/);
});

/** The pile has been distilled, so the nudge starts over rather than repeating next session. */
test('--save clears the nudge it had already spoken', (t) => {
  fresh();
  writeFileSync(join(STORE, 'said.json'), JSON.stringify({ at: '2026-08-01T00:00:00.000Z', count: 12 }));
  correction('2026-08-20-a', { promptId: 'P1' });
  correction('2026-08-21-b', { promptId: 'P2' });
  cli(['validate', rulesFile(t, [rule(['2026-08-20-a', '2026-08-21-b'])]), '--save']);
  assert.deepEqual(JSON.parse(readFileSync(join(STORE, 'said.json'), 'utf8')), {});
});

// ---------------- score, accept, reject ----------------

test('score says there is nothing to score, and what would change that', () => {
  fresh();
  const r = cli(['score']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /no rules have been proposed yet/);
  assert.match(r.out, /habit-learn skill/);
});

test('score shows what each rule is watching for, and prints no hit rate', (t) => {
  fresh();
  correction('2026-08-20-a', { file: 'a.html', promptId: 'P1', removed: ['<!-- 日本語 -->'] });
  correction('2026-08-21-b', { file: 'b.html', promptId: 'P2', removed: ['<!-- 日本語 -->'] });
  cli(['validate', rulesFile(t, [rule(['2026-08-20-a', '2026-08-21-b'])]), '--save']);

  const r = cli(['score']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /1 proposal\(s\) — 1 scorable, 0 unscorable/);
  assert.match(r.out, /\[undecided\]/);
  assert.match(r.out, /watching for: <!-- 日本語 -->/);
  assert.match(r.out, /no recurrence since/);
  assert.match(r.out, /No hit rate is printed, on purpose/);
  assert.doesNotMatch(r.out, /\d+%/, 'a percentage here would be measured by the thing injecting the rule');
});

test('accept and reject need an id, and say where to find one', () => {
  fresh();
  for (const cmd of ['accept', 'reject']) {
    const r = cli([cmd]);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /see habit score/);
  }
});

test('an id matching no proposal is refused rather than silently doing nothing', () => {
  fresh();
  const r = cli(['accept', 'nope']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /no proposal matching nope/);
});

test('accept and reject record the decision, and a prefix has to resolve to one', (t) => {
  fresh();
  correction('2026-08-20-a', { file: 'a.html', promptId: 'P1', removed: ['<!-- 日本語 -->'] });
  correction('2026-08-21-b', { file: 'b.html', promptId: 'P2', removed: ['<!-- 日本語 -->'] });
  cli(['validate', rulesFile(t, [rule(['2026-08-20-a', '2026-08-21-b'])]), '--save']);
  const id = JSON.parse(readFileSync(LEDGER, 'utf8')).proposals[0].id;

  const ok = cli(['accept', id]);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /accepted — Write comments in English\./);
  assert.equal(JSON.parse(readFileSync(LEDGER, 'utf8')).proposals[0].accepted, true);
  assert.match(cli(['score']).out, /\[accepted\]/);

  const back = cli(['reject', id]);
  assert.equal(back.code, 0, back.out);
  assert.equal(JSON.parse(readFileSync(LEDGER, 'utf8')).proposals[0].accepted, false);
});

// ---------------- export, where, log ----------------

test('export writes a bundle, and says what it left out', (t) => {
  fresh();
  correction('2026-08-20-a', { file: 'a.html' });
  const dir = mkdtempSync(join(tmpdir(), 'habit-export-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, 'bundle.json');

  const r = cli(['export', '--as', 'someone', '--out', out]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /1 correction\(s\) written to/);
  assert.match(r.out, /excluded: the folder path/);

  const bundle = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(bundle.who, 'someone');
  assert.equal(bundle.corrections.length, 1);
  assert.equal(bundle.corrections[0].file, 'a.html', 'the basename, never the directory');
  assert.doesNotMatch(JSON.stringify(bundle), /[/\\]work[/\\]/, 'no path survived into the bundle');
});

test('where prints the store, so a person can go and look at it', () => {
  const r = cli(['where']);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.out.trim(), STORE);
});

test('log lists what was corrected, and what was corrected most', () => {
  fresh();
  correction('2026-08-20-a', { file: 'a.html' });
  correction('2026-08-21-b', { file: 'a.html' });
  correction('2026-08-22-c', { file: 'b.html' });
  const r = cli(['log']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /3 hand-edit\(s\) recorded/);
  assert.match(r.out, /Corrected most often:/);
  assert.match(r.out, /2x\s+a\.html/);
});

// ---------------- the two hooks that had no test at all ----------------

/**
 * `hook denied` and `hook failed` are the only subcommands nothing exercised, and that is
 * exactly where a broken one hides: the dispatch sits inside a `catch {}` that exists so a hook
 * can never interrupt somebody's work, so a ReferenceError here is not an error — it is a hook
 * that quietly records nothing, for as long as nobody looks in the store.
 */
test('a refused call is recorded as a signal, with its reason and its turn', () => {
  fresh();
  rmSync(join(STORE, 'signals'), { recursive: true, force: true });
  const r = spawnSync(process.execPath, [CLI, 'hook', 'denied'], {
    input: JSON.stringify({
      tool_name: 'Bash',
      prompt_id: 'P7',
      reason: 'the user said no',
      tool_input: { command: 'rm -rf build' },
    }),
    encoding: 'utf8',
    env: { ...process.env, HABIT_HOME: HOME },
  });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);

  const dir = join(STORE, 'signals');
  assert.ok(existsSync(dir), 'the signal reached disk');
  const files = readdirSync(dir);
  assert.equal(files.length, 1, `nothing was recorded: ${JSON.stringify(files)}`);
  const s = JSON.parse(readFileSync(join(dir, files[0]), 'utf8'));
  assert.equal(s.kind, 'denial');
  assert.equal(s.promptId, 'P7', 'needed so several refusals in one turn count as one');
  assert.match(s.reason, /the user said no/);
});

test('a failed call is recorded too, and carries no reason field', () => {
  fresh();
  rmSync(join(STORE, 'signals'), { recursive: true, force: true });
  const r = spawnSync(process.execPath, [CLI, 'hook', 'failed'], {
    input: JSON.stringify({ tool_name: 'Bash', error: 'command not found: gh' }),
    encoding: 'utf8',
    env: { ...process.env, HABIT_HOME: HOME },
  });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  const dir = join(STORE, 'signals');
  const files = readdirSync(dir);
  assert.equal(files.length, 1, `nothing was recorded: ${JSON.stringify(files)}`);
  const s = JSON.parse(readFileSync(join(dir, files[0]), 'utf8'));
  assert.equal(s.kind, 'failure');
  assert.equal(s.reason, null, 'a reason belongs to a refusal, not to a failure');
  assert.match(s.error, /command not found/);
});
