import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { spawnSync } from 'node:child_process';
import { launch, transform, ledger } from '@hyuga/spar';
import { keep, list, isSensitive, within, MAX_BYTES } from '../src/carbon.mjs';

function fresh(t) {
  const dir = mkdtempSync(join(tmpdir(), 'carbon-'));
  const prev = process.env.SPAR_HOME;
  process.env.SPAR_HOME = join(dir, '.spar');
  t.after(() => {
    if (prev === undefined) delete process.env.SPAR_HOME; else process.env.SPAR_HOME = prev;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const write = (file_path) => ({ tool_name: 'Write', tool_input: { file_path } });

test('in cruise, the draft about to be overwritten is kept', (t) => {
  const dir = fresh(t);
  const draft = join(dir, 'note.md');
  writeFileSync(draft, 'the paragraph you liked');
  launch({ mode: 'cruise' });

  const kept = keep(write(draft), dir);
  assert.ok(kept, 'a copy was made');
  assert.equal(readFileSync(kept, 'utf8'), 'the paragraph you liked');
  assert.equal(list(dir).length, 1);
});

test('in strike it keeps nothing — git and review are behind you there', (t) => {
  const dir = fresh(t);
  const f = join(dir, 'src.mjs');
  writeFileSync(f, 'code');
  launch({ mode: 'strike' });
  assert.equal(keep(write(f), dir), null);
  assert.equal(list(dir).length, 0);
});

test('a file that does not exist yet is not being overwritten', (t) => {
  const dir = fresh(t);
  launch({ mode: 'cruise' });
  assert.equal(keep(write(join(dir, 'new.md')), dir), null);
});

test('credentials are never kept, cruise or not', (t) => {
  const dir = fresh(t);
  launch({ mode: 'cruise' });
  for (const name of ['.env', '.env.local', 'id_rsa', 'server.pem', 'secrets/token.txt']) {
    assert.ok(isSensitive(name), `${name} is sensitive`);
  }
  const env = join(dir, '.env');
  writeFileSync(env, 'API_KEY=hunter2');
  assert.equal(keep(write(env), dir), null);
  assert.equal(list(dir).length, 0);
});

test('what git already has is not copied again', (t) => {
  const dir = fresh(t);
  launch({ mode: 'cruise' });
  const git = (...a) => spawnSync('git', a, { cwd: dir, stdio: 'ignore' });
  if (git('init', '-q').status !== 0) return; // no git on this machine: nothing to assert
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  const tracked = join(dir, 'tracked.md');
  writeFileSync(tracked, 'committed prose');
  git('add', 'tracked.md');
  git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'x');
  assert.equal(keep(write(tracked), dir), null, 'git show can get this back');

  const untracked = join(dir, 'draft.md');
  writeFileSync(untracked, 'nothing else keeps this');
  assert.ok(keep(write(untracked), dir));
});

test('too large to keep means the fact is kept, not the body', (t) => {
  const dir = fresh(t);
  launch({ mode: 'cruise' });
  const big = join(dir, 'big.md');
  writeFileSync(big, 'x'.repeat(MAX_BYTES + 1));
  const kept = keep(write(big), dir);
  assert.match(readFileSync(kept, 'utf8'), /too large to keep/);
});

test('it files a finding, and it is a cruise one', (t) => {
  const dir = fresh(t);
  const draft = join(dir, 'plan.md');
  writeFileSync(draft, 'v1');
  launch({ mode: 'cruise' });
  keep(write(draft), dir);
  const f = ledger().at(-1);
  assert.equal(f.source, 'carbon');
  assert.equal(f.mode, 'cruise');
  assert.equal(f.observed, 'superseded');
  assert.equal(f.severity, 'note', 'it never interrupts');
});

test('transforming into cruise is what turns it on', (t) => {
  const dir = fresh(t);
  const draft = join(dir, 'idea.md');
  writeFileSync(draft, 'v1');
  launch({ mode: 'strike' });
  assert.equal(keep(write(draft), dir), null);
  transform('cruise');
  assert.ok(keep(write(draft), dir));
});

// ---- containment (added after the pre-publish audit) ----

test('a file outside the working directory is never kept, even in cruise', (t) => {
  const dir = fresh(t);
  const outside = mkdtempSync(join(tmpdir(), 'carbon-elsewhere-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const theirs = join(outside, 'notes.md');
  writeFileSync(theirs, 'someone else’s file');
  launch({ mode: 'cruise' });

  assert.equal(keep(write(theirs), dir), null);
  assert.equal(list(dir).length, 0);
});

test('a symlink is refused even when it points at something inside', (t) => {
  const dir = fresh(t);
  const real = join(dir, 'real.md');
  writeFileSync(real, 'the draft');
  const link = join(dir, 'link.md');
  try {
    symlinkSync(real, link);
  } catch {
    return; // Windows without developer mode: nothing to assert
  }
  launch({ mode: 'cruise' });

  assert.equal(keep(write(link), dir), null);
});

test('within() rejects a path that climbs out with ..', (t) => {
  const dir = fresh(t);
  assert.equal(within(join(dir, '..', 'x.md'), dir), false);
  assert.equal(within(dir, dir), false); // the directory itself is not a draft
});

test('the names the audit found missing are refused', () => {
  for (const name of [
    '.git-credentials', 'app/.htpasswd', '~/.pypirc', '.ssh/id_ecdsa', 'key.ppk',
    '.kube/config', '.docker/config.json', 'wp-config.php', 'terraform.tfstate',
    'service-account-1234.json', '.envrc', 'gh/hosts.yml',
  ]) {
    assert.equal(isSensitive(name), true, `${name} should never be kept`);
  }
});
