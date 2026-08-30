/**
 * prune is the one command here that deletes something, and until this file existed its
 * reporting half had never run: coverage put src/prune.mjs at 74.77%, and every uncovered line
 * was inside `report()` or the guard that skips a record it cannot read.
 *
 * That is the wrong half to leave untested. A dry run *is* the report — it is the only thing a
 * person sees before they type --apply — so a wrong count or the wrong closing sentence is how
 * somebody drops bodies they meant to keep. And a corrupt record must be stepped over rather
 * than made the reason to start deleting.
 *
 * Everything here goes through a store of its own, set before the import.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, '..', 'src', 'habit.mjs');

const HOME = mkdtempSync(join(tmpdir(), 'habit-prune-'));
process.env.HABIT_HOME = HOME;

const { prune, report } = await import('../src/prune.mjs');
const { artifactsDir } = await import('../src/habit.mjs');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-08-30T00:00:00.000Z');

/** Wipe the store between tests: prune reads the whole directory, so leftovers are noise. */
function fresh() {
  const dir = artifactsDir();
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** One artifact record, exactly as the hooks write them. */
function artifact(name, { file, text = 'body\n', ago = 0, bare = false } = {}) {
  const dir = artifactsDir();
  const rec = {
    file,
    hash: 'deadbeef',
    text: bare ? null : text,
    writtenAt: new Date(NOW - ago).toISOString(),
  };
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(rec), 'utf8');
  return join(dir, `${name}.json`);
}

/** A file that really exists, so `existsSync(rec.file)` means something. */
function realFile(t, body = 'still here\n') {
  const dir = mkdtempSync(join(tmpdir(), 'habit-prune-work-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = join(dir, 'kept.md');
  writeFileSync(f, body);
  return f;
}

test('a store that has never been written to is not an error', () => {
  rmSync(artifactsDir(), { recursive: true, force: true });
  const r = prune({ now: NOW });
  assert.equal(r.scanned, 0);
  assert.deepEqual(r.gone, []);
  assert.match(report(r, { days: 30 }), /Nothing to prune/);
});

test('a body whose file still exists and was written recently is kept', (t) => {
  fresh();
  artifact('a', { file: realFile(t), ago: 3 * DAY });
  const r = prune({ now: NOW });
  assert.equal(r.scanned, 1);
  assert.equal(r.keptWithBody, 1);
  assert.equal(r.gone.length + r.stale.length, 0);
});

test('a body already dropped is counted as bare, not dropped again', (t) => {
  fresh();
  artifact('a', { file: realFile(t), bare: true });
  const r = prune({ now: NOW });
  assert.equal(r.alreadyBare, 1);
  assert.equal(r.freed, 0);
  assert.match(report(r, { days: 30 }), /1 already have none/);
});

/** An unreadable record is not something to start deleting over. */
test('a record that is not JSON is stepped over, and does not even count as scanned', (t) => {
  fresh();
  writeFileSync(join(artifactsDir(), 'broken.json'), '{ this is not json', 'utf8');
  artifact('a', { file: realFile(t) });
  const r = prune({ now: NOW, apply: true });
  assert.equal(r.scanned, 1, 'only the readable one was scanned');
  assert.equal(readFileSync(join(artifactsDir(), 'broken.json'), 'utf8'), '{ this is not json',
    'and the unreadable one is exactly as it was');
});

test('a file that is gone can never be diffed against again, so its body goes', () => {
  fresh();
  artifact('a', { file: join(tmpdir(), 'habit-prune-no-such-file.md'), text: 'x'.repeat(2048) });
  const r = prune({ now: NOW });
  assert.equal(r.gone.length, 1);
  assert.equal(r.stale.length, 0);
  assert.equal(r.freed, 2048);
  const out = report(r, { days: 30 });
  assert.match(out, /the file no longer exists \(1\)/);
  assert.match(out, /2 KB/);
});

test('a body untouched for longer than --days is stale', (t) => {
  fresh();
  const f = realFile(t);
  artifact('recent', { file: f, ago: 5 * DAY });
  artifact('old', { file: f, ago: 40 * DAY });
  const r = prune({ now: NOW, days: 30 });
  assert.equal(r.stale.length, 1);
  assert.equal(r.keptWithBody, 1);
  assert.match(report(r, { days: 30 }), /untouched for over 30 days \(1\)/);

  const wider = prune({ now: NOW, days: 90 });
  assert.equal(wider.stale.length, 0, 'nothing is stale against a longer window');
  assert.equal(wider.keptWithBody, 2);
});

/**
 * The default is a dry run, and the sentence a person reads has to say so. This is the last
 * thing standing between "let me see" and a directory of bodies that are gone.
 */
test('a dry run changes nothing, and says that it changed nothing', () => {
  fresh();
  const path = artifact('a', { file: join(tmpdir(), 'habit-prune-no-such-file.md') });
  const r = prune({ now: NOW });
  assert.equal(r.applied, false);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).text, 'body\n', 'the body is still there');
  const out = report(r, { days: 30 });
  assert.match(out, /Nothing was changed/);
  assert.match(out, /--apply/);
  assert.doesNotMatch(out, /^Done\./m);
});

test('--apply drops the body, keeps the hash, and records why', () => {
  fresh();
  const gonePath = artifact('gone', { file: join(tmpdir(), 'habit-prune-no-such-file.md') });
  const r = prune({ now: NOW, apply: true });
  assert.equal(r.applied, true);
  const after = JSON.parse(readFileSync(gonePath, 'utf8'));
  assert.equal(after.text, null, 'the body goes');
  assert.equal(after.hash, 'deadbeef', 'the hash stays, so an edit is still detected');
  assert.equal(after.withheld, 'pruned-gone');
  assert.equal(after.prunedAt, new Date(NOW).toISOString());
  assert.match(report(r, { days: 30 }), /^Done\./m);
});

test('a stale body is marked as stale, not as gone', (t) => {
  fresh();
  const path = artifact('old', { file: realFile(t), ago: 40 * DAY });
  prune({ now: NOW, days: 30, apply: true });
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).withheld, 'pruned-stale');
});

test('running it twice drops nothing the second time', (t) => {
  fresh();
  artifact('gone', { file: join(tmpdir(), 'habit-prune-no-such-file.md') });
  artifact('kept', { file: realFile(t) });
  prune({ now: NOW, apply: true });
  const again = prune({ now: NOW, apply: true });
  assert.equal(again.gone.length, 0);
  assert.equal(again.alreadyBare, 1);
  assert.equal(again.keptWithBody, 1);
  assert.equal(again.freed, 0);
});

/** A report that printed 200 filenames would not be read, so it stops at twelve and counts. */
test('a long list is truncated, and says how much it did not show', () => {
  fresh();
  for (let i = 0; i < 15; i += 1) {
    artifact(`gone${i}`, { file: join(tmpdir(), `habit-prune-no-such-${i}.md`) });
  }
  const out = report(prune({ now: NOW }), { days: 30 });
  assert.match(out, /the file no longer exists \(15\)/);
  assert.match(out, /… and 3 more/);
  assert.equal(out.split('\n').filter((l) => l.includes('habit-prune-no-such-')).length, 12);
});

// ---------------- through the CLI ----------------

function cli(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HABIT_HOME: HOME },
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

test('the CLI defaults to a dry run', () => {
  fresh();
  const path = artifact('gone', { file: join(tmpdir(), 'habit-prune-no-such-file.md') });
  const r = cli(['prune']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Nothing was changed/);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).text, 'body\n');
});

test('the CLI applies when asked, and only then', () => {
  fresh();
  const path = artifact('gone', { file: join(tmpdir(), 'habit-prune-no-such-file.md') });
  const r = cli(['prune', '--apply']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^Done\./m);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).text, null);
});

test('a --days that is not a number is a usage error, not a window of NaN days', () => {
  fresh();
  for (const bad of [['prune', '--days', 'soon'], ['prune', '--days', '-5'], ['prune', '--days']]) {
    const r = cli(bad);
    assert.equal(r.code, 2, `${bad.join(' ')}: ${r.out}`);
    assert.match(r.out, /habit prune \[--days N\]/);
  }
});

test('the store is left with the same number of records prune started with', (t) => {
  fresh();
  artifact('gone', { file: join(tmpdir(), 'habit-prune-no-such-file.md') });
  artifact('kept', { file: realFile(t) });
  const before = readdirSync(artifactsDir()).length;
  cli(['prune', '--apply']);
  assert.equal(readdirSync(artifactsDir()).length, before,
    'prune drops bodies, never records — the hash is what detection runs on');
});
