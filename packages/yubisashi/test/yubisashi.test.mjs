import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { launch, ledger } from '@hyuga/spar';
import { check, point, contracts, pendingFiles } from '../src/yubisashi.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, '..', 'src', 'yubisashi.mjs');

/**
 * Every test gets its own frame, home and pending file.
 *
 * Home is moved too: pendingFiles() looks under ~/.claude/groundtruth, and redline's config()
 * looks for ~/.redline.json, so a real home would let either of them reach into the test.
 */
function fresh(t, { production = [], pending = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'yubisashi-'));
  const prev = {};
  for (const k of ['SPAR_HOME', 'HOME', 'USERPROFILE', 'REDLINE_PRODUCTION', 'GROUNDTRUTH_PENDING', 'CLAUDE_PROJECT_DIR']) prev[k] = process.env[k];
  process.env.SPAR_HOME = join(dir, '.spar');
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.CLAUDE_PROJECT_DIR = dir;
  process.env.REDLINE_PRODUCTION = production.join(';');
  const file = join(dir, 'pending.jsonl');
  if (pending) process.env.GROUNDTRUTH_PENDING = file; else delete process.env.GROUNDTRUTH_PENDING;
  t.after(() => {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(dir, { recursive: true, force: true });
  });
  launch({ mode: 'strike' }, dir);
  return { dir, file };
}

const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
const write = (file_path) => ({ tool_name: 'Write', tool_input: { file_path } });
const contract = (file, c) => writeFileSync(file, `${JSON.stringify(c)}\n`, { flag: 'a' });

// Probes that run everywhere node does. The counter one records how many times it was run.
const slash = (p) => p.split('\\').join('/');
const printing = (s) => `node -e "console.log('${s}')"`;
const failing = 'node -e "process.exit(1)"';
const counting = (path) => `node -e "const f=require('fs');const p=process.argv[1];const n=(f.existsSync(p)?Number(f.readFileSync(p,'utf8')):0)+1;f.writeFileSync(p,String(n));console.log(n)" ${slash(path)}`;

const mine = (dir) => ledger(dir).filter((f) => f.source === 'yubisashi');

test('a read, a search and a dependency are not pointed at', (t) => {
  const { dir } = fresh(t, { production: ['/var/www/'] });
  assert.equal(check({ tool_name: 'Read', tool_input: { file_path: '/var/www/index.html' } }, dir), null);
  assert.equal(check(bash('ls -la'), dir), null);
  assert.equal(check(bash('grep -r "npm publish" README.md'), dir), null);
  assert.equal(check(bash('npm install left-pad'), dir), null, 'a dependency is charged by redline and still not pointed at');
  assert.equal(mine(dir).length, 0, 'nothing filed for calls that change nothing out of reach');
});

test('a write with no contract is told to point first', (t) => {
  const { dir, file } = fresh(t);
  const out = check(bash('git push origin main'), dir);
  assert.equal(out.verdict, 'advise', 'a pilot is flying, so it is advice');
  assert.match(out.message, /nothing pointed at \(no contract\)/);
  assert.match(out.message, new RegExp(file.replace(/[\\/.]/g, '.')), 'it names the file the contract belongs in');
  const f = mine(dir);
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'stop');
  assert.deepEqual(f[0].observed, { kinds: ['outward'], contracts: 0 });
});

test('a cruise is never interrupted, and never probed', (t) => {
  const { dir, file } = fresh(t);
  launch({ mode: 'cruise' }, dir);
  const counter = join(dir, 'n.txt');
  contract(file, { action: 'x', probe: counting(counter), expect: { type: 'count', value: 3 } });
  assert.equal(check(bash('git push origin main'), dir), null);
  assert.equal(existsSync(counter), false, 'the probe was not run');
  assert.equal(mine(dir).length, 0);
});

test('a probe that does not run is caught before the write, not after', (t) => {
  const { dir, file } = fresh(t);
  contract(file, { action: 'publish the page', probe: failing, expect: { type: 'nonempty' } });
  const out = check(bash('npm publish'), dir);
  assert.equal(out.verdict, 'advise');
  assert.match(out.message, /"publish the page" — the probe does not run: exit 1/);
  assert.match(out.message, /1 contract\(s\) pending, none that run/, 'a broken contract is not a pointed one');
  const f = mine(dir);
  assert.equal(f[0].observed.reason, 'probe-error');
  assert.equal(f[0].severity, 'stop');
});

test('a contract that is not a contract is caught the same way', (t) => {
  const { dir, file } = fresh(t);
  writeFileSync(file, 'not json at all\n');
  contract(file, { action: 'no probe here', expect: { type: 'nonempty' } });
  contract(file, { action: 'typo', probe: printing('1'), expect: { type: 'non-empty' } });
  const out = check(bash('npm publish'), dir);
  assert.match(out.message, /the line is not JSON/);
  assert.match(out.message, /names no probe/);
  assert.match(out.message, /unknown expect.type: non-empty/, "groundtruth's own reading of the line, so the two agree");
  assert.deepEqual(mine(dir).map((f) => f.observed.reason), ['bad-json', 'no-probe', 'bad-expect', undefined]);
});

test('an expectation that is already true confirms nothing, and says so once', (t) => {
  const { dir, file } = fresh(t);
  contract(file, { action: 'insert 45 rows', probe: printing('45'), expect: { type: 'count', value: 45 } });
  const out = check(bash('git push origin main'), dir);
  assert.equal(out.verdict, 'advise');
  assert.match(out.message, /"insert 45 rows" is already true before you act \[count\(45\)\] — the probe returned "45"/);
  assert.doesNotMatch(out.message, /nothing pointed at/, 'it was pointed — at the wrong thing, which the pilot has now been told');
  assert.equal(check(bash('git push origin main'), dir), null, 'told once; the second write is not nagged');
  const f = mine(dir);
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'warn');
  assert.equal(f[0].observed.met, true);
});

test('a real target is silent, filed, and pointed at once', (t) => {
  const { dir, file } = fresh(t, { production: ['/var/www/'] });
  const counter = join(dir, 'n.txt');
  contract(file, { action: 'upload three pages', probe: counting(counter), expect: { type: 'count', value: 3 } });
  assert.equal(check(write('/var/www/a.html'), dir), null, 'the finger is on something real: nothing to say');
  assert.equal(readFileSync(counter, 'utf8'), '1');
  assert.equal(check(write('/var/www/b.html'), dir), null);
  assert.equal(check(bash('scp c.html host:/var/www/c.html'), dir), null);
  assert.equal(readFileSync(counter, 'utf8'), '1', 'pointed once this sortie, not before every write');
  const f = mine(dir);
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'note');
  assert.equal(f[0].observed.before, '"1"', 'the reading before the write is on the ledger');
  assert.equal(f[0].observed.met, false);
  assert.equal(f[0].expected, 'count(3)');
});

test('a new sortie points again', (t) => {
  const { dir, file } = fresh(t);
  const counter = join(dir, 'n.txt');
  contract(file, { action: 'x', probe: counting(counter), expect: { type: 'count', value: 9 } });
  check(bash('npm publish'), dir);
  launch({ mode: 'strike' }, dir);
  check(bash('npm publish'), dir);
  assert.equal(readFileSync(counter, 'utf8'), '2');
});

test('with nobody in the seat, a write with nothing pointed at is denied', (t) => {
  const { dir, file } = fresh(t);
  launch({ mode: 'strike', autonomy: true, reason: 'test' }, dir);
  const out = check(bash('git push origin main'), dir);
  assert.equal(out.verdict, 'halt');
  assert.match(out.message, /denied rather than advised/);
  contract(file, { action: 'y', probe: failing, expect: { type: 'nonempty' } });
  assert.equal(check(bash('git push origin main'), dir).verdict, 'halt', 'a broken probe is nothing pointed at');
  writeFileSync(file, '');
  contract(file, { action: 'z', probe: printing('0'), expect: { type: 'count', value: 1 } });
  assert.equal(check(bash('git push origin main'), dir), null, 'a real target lets the call through');
});

test('the session file is read too, and named when it is the one that exists', (t) => {
  const { dir } = fresh(t, { pending: false });
  const sid = 'abc-123';
  const sessionFile = join(dir, '.claude', 'groundtruth', `${sid}.jsonl`);
  mkdirSync(dirname(sessionFile), { recursive: true });
  const payload = { ...bash('npm publish'), session_id: sid };
  assert.deepEqual(pendingFiles(payload, dir), [join(dir, '.groundtruth', 'pending.jsonl'), sessionFile]);
  assert.equal(pendingFiles({ ...payload, session_id: '../evil' }, dir).length, 1, 'a session id that is a path is not one');
  contract(sessionFile, { action: 'from the session file', probe: printing('0'), expect: { type: 'count', value: 1 } });
  assert.equal(contracts(payload, dir).length, 1);
  assert.equal(check(payload, dir), null);
  assert.equal(mine(dir)[0].subject, 'from the session file');
});

test('point() reads the line the way groundtruth does', () => {
  const p = point({ key: 'k', file: 'f', line: JSON.stringify({ action: 'a', probe: printing('hello world'), expect: { type: 'contains', value: 'world' } }) });
  assert.equal(p.reason, 'already-met');
  assert.equal(p.before, 'hello world');
  assert.equal(p.expectation, 'contains("world")');
  const q = point({ key: 'k', file: 'f', line: JSON.stringify({ action: 'b', probe: printing(''), expect: { type: 'count', value: 2 } }) });
  assert.equal(q.reason, null);
  assert.equal(q.met, false);
});

test('a probe that never answers is a probe that does not run', (t) => {
  const { dir, file } = fresh(t);
  contract(file, { action: 'slow', probe: 'node -e "setTimeout(()=>{},60000)"', expect: { type: 'nonempty' } });
  const out = check(bash('npm publish'), dir);
  assert.match(out.message, /took longer than 4000ms/);
});

test('the CLI: hook pre reads stdin and writes the envelope; point runs the probes by hand', (t) => {
  const { dir, file } = fresh(t);
  contract(file, { action: 'by hand', probe: printing('0'), expect: { type: 'count', value: 1 } });
  const env = { ...process.env };
  const hook = spawnSync(process.execPath, [CLI, 'hook', 'pre'], { input: JSON.stringify(bash('git push origin main')), encoding: 'utf8', env, cwd: dir });
  assert.equal(hook.status, 0);
  assert.equal(hook.stdout, '', 'a real target: silent, no envelope at all');
  const empty = spawnSync(process.execPath, [CLI, 'hook', 'pre'], { input: 'not json', encoding: 'utf8', env, cwd: dir });
  assert.equal(empty.status, 0, 'a malformed payload never costs the session');

  writeFileSync(file, '');
  contract(file, { action: 'broken', probe: failing, expect: { type: 'nonempty' } });
  const nag = spawnSync(process.execPath, [CLI, 'hook', 'pre'], { input: JSON.stringify(bash('git push origin main')), encoding: 'utf8', env, cwd: dir });
  const out = JSON.parse(nag.stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, 'PreToolUse');
  assert.match(out.additionalContext, /the probe does not run/);
  assert.equal(out.permissionDecision, undefined, 'advice, not a denial, while somebody is flying');

  const byHand = spawnSync(process.execPath, [CLI, 'point', file], { encoding: 'utf8', env, cwd: dir });
  assert.equal(byHand.status, 1);
  assert.match(byHand.stdout, /✗ "broken" — probe-error: exit 1/);
});
