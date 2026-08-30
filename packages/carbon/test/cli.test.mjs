/**
 * Start carbon's own CLI and check what it does.
 *
 * carbon is the one part that is silent by design, which makes it the one whose CLI most needs
 * running: there is no output to notice going wrong. A copy that was never taken and a copy
 * taken correctly look identical from the session, and the moment anybody finds out is the
 * moment they wanted the draft back.
 *
 * `carbon show` is checked here byte for byte. 0.1.1 fixed exactly this: files were read as
 * UTF-8 and written back, so every byte that is not valid UTF-8 came out as U+FFFD. A png in
 * the store looked kept — `carbon list` showed it — and did not restore.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, '..', 'src', 'carbon.mjs');
// Resolved rather than composed: npm workspaces hoists the link to the root node_modules, and
// spawnSync answers a missing file with a null status instead of throwing.
const SPAR = createRequire(import.meta.url).resolve('@hyuga/spar');

/** A working directory and a frame inside it, so `within()` sees a real repository root. */
function work(t) {
  const dir = mkdtempSync(join(tmpdir(), 'carbon-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, home: join(dir, '.spar') };
}

function run(w, args, { stdin = '' } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    input: stdin,
    cwd: w.dir,
    encoding: 'utf8',
    env: { ...process.env, SPAR_HOME: w.home },
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, raw: r.stdout };
}

function launch(w, mode) {
  const r = spawnSync(process.execPath, [SPAR, 'launch', mode], {
    cwd: w.dir, encoding: 'utf8', env: { ...process.env, SPAR_HOME: w.home },
  });
  assert.equal(r.status, 0, `launch failed: ${r.stderr ?? ''}${r.error ?? ''}`);
}

const overwriting = (file_path) => JSON.stringify({ tool_name: 'Write', tool_input: { file_path } });

test('the bin runs at all, and says when it acts', (t) => {
  const w = work(t);
  const r = run(w, []);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /only acts in cruise/);
  assert.match(r.out, /PreToolUse/);
});

test('nothing kept yet says so, and says what would change that', (t) => {
  const w = work(t);
  const r = run(w, ['list']);
  assert.equal(r.code, 0);
  assert.match(r.out, /nothing kept yet/);
  assert.match(r.out, /untracked file in cruise/);
});

test('strike keeps nothing — git and review are already behind it', (t) => {
  const w = work(t);
  launch(w, 'strike');
  writeFileSync(join(w.dir, 'draft.md'), 'the paragraph you liked\n');
  const r = run(w, ['hook', 'pre'], { stdin: overwriting(join(w.dir, 'draft.md')) });
  assert.equal(r.code, 0);
  assert.equal(r.out.trim(), '');
  assert.match(run(w, ['list']).out, /nothing kept yet/);
});

test('cruise keeps the copy, and says nothing while doing it', (t) => {
  const w = work(t);
  launch(w, 'cruise');
  writeFileSync(join(w.dir, 'draft.md'), 'the paragraph you liked\n');
  const r = run(w, ['hook', 'pre'], { stdin: overwriting(join(w.dir, 'draft.md')) });
  assert.equal(r.code, 0);
  assert.equal(r.out.trim(), '', 'interrupting a draft is the failure cruise exists to prevent');
  const list = run(w, ['list']);
  assert.match(list.out, /\.md\s+\d+ bytes/);
});

/**
 * The 0.1.1 regression, pinned. A copy that lists and does not restore is the worst thing a
 * part like this can do, and nothing about it is visible until the day it matters.
 */
test('show returns bytes, so a binary draft restores byte for byte', (t) => {
  const w = work(t);
  launch(w, 'cruise');
  // A PNG header, then bytes that are not valid UTF-8 in any decoding.
  const original = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x80, 0xc3]);
  const file = join(w.dir, 'hero.png');
  writeFileSync(file, original);
  run(w, ['hook', 'pre'], { stdin: overwriting(file) });

  const id = run(w, ['list']).out.trim().split(/\s+/)[0];
  assert.ok(id, 'a copy was kept');
  const back = spawnSync(process.execPath, [CLI, 'show', id], {
    cwd: w.dir, env: { ...process.env, SPAR_HOME: w.home },
  });
  assert.equal(back.status, 0);
  assert.deepEqual(back.stdout, original, 'every byte came back, U+FFFD replaced none of them');
});

test('show refuses an id it does not have, rather than printing nothing and exiting 0', (t) => {
  const w = work(t);
  const r = run(w, ['show', 'nope']);
  assert.equal(r.code, 1);
  assert.match(r.out, /no such copy/);
});

test('a credential is never copied, whatever the mode', (t) => {
  const w = work(t);
  launch(w, 'cruise');
  for (const name of ['.env', 'id_rsa', 'secrets.json', 'server.pem', 'auth.json']) {
    const f = join(w.dir, name);
    writeFileSync(f, 'SECRET=hunter2trustno1\n');
    run(w, ['hook', 'pre'], { stdin: overwriting(f) });
  }
  assert.match(run(w, ['list']).out, /nothing kept yet/);
});

/**
 * The path arrives in a hook payload, which is to say the agent chose it, and nothing in the
 * hook contract keeps it under the working directory.
 */
test('a file outside the repository is not ours to keep', (t) => {
  const w = work(t);
  const elsewhere = mkdtempSync(join(tmpdir(), 'carbon-elsewhere-'));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  launch(w, 'cruise');
  const f = join(elsewhere, 'someone-elses.md');
  writeFileSync(f, 'not mine\n');
  run(w, ['hook', 'pre'], { stdin: overwriting(f) });
  assert.match(run(w, ['list']).out, /nothing kept yet/);
});

test('a file that does not exist yet is not being overwritten', (t) => {
  const w = work(t);
  launch(w, 'cruise');
  const r = run(w, ['hook', 'pre'], { stdin: overwriting(join(w.dir, 'not-written-yet.md')) });
  assert.equal(r.code, 0);
  assert.match(run(w, ['list']).out, /nothing kept yet/);
});

test('a directory is not a draft', (t) => {
  const w = work(t);
  launch(w, 'cruise');
  mkdirSync(join(w.dir, 'notes'));
  run(w, ['hook', 'pre'], { stdin: overwriting(join(w.dir, 'notes')) });
  assert.match(run(w, ['list']).out, /nothing kept yet/);
});

/** A draft must never be lost to a hook that threw, and a session must never be either. */
test('a payload it cannot make sense of costs the session nothing', (t) => {
  const w = work(t);
  launch(w, 'cruise');
  for (const stdin of ['', '{', 'null', '[]', '{"tool_input":null}', '{"tool_input":{"file_path":42}}']) {
    const r = run(w, ['hook', 'pre'], { stdin });
    assert.equal(r.code, 0, `${stdin}: ${r.out}`);
    assert.equal(r.out.trim(), '');
  }
});

test('what carbon kept is written down in the ledger, even though nothing was said', (t) => {
  const w = work(t);
  launch(w, 'cruise');
  const f = join(w.dir, 'draft.md');
  writeFileSync(f, 'the paragraph you liked\n');
  run(w, ['hook', 'pre'], { stdin: overwriting(f) });
  const ledger = readFileSync(join(w.home, 'ledger.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const kept = ledger.find((x) => x.source === 'carbon');
  assert.ok(kept, 'the copy is a finding');
  assert.equal(kept.observed, 'superseded');
  assert.equal(kept.mode, 'cruise');
});
