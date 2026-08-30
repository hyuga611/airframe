import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sortie, discard, ledger, finding, report } from '@hyuga/spar';
import { wire, install, session, status, mounted, settingsPath, spend, land, mount, wingman } from '../src/airframe.mjs';

function fresh(t) {
  const dir = mkdtempSync(join(tmpdir(), 'airframe-'));
  const prev = process.env.SPAR_HOME;
  const prevAuto = process.env.AIRFRAME_AUTONOMY;
  process.env.SPAR_HOME = join(dir, '.spar');
  delete process.env.AIRFRAME_AUTONOMY;
  t.after(() => {
    if (prev === undefined) delete process.env.SPAR_HOME; else process.env.SPAR_HOME = prev;
    if (prevAuto === undefined) delete process.env.AIRFRAME_AUTONOMY; else process.env.AIRFRAME_AUTONOMY = prevAuto;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const commands = (s) => Object.values(s.hooks).flat().flatMap((g) => g.hooks.map((h) => h.command));

test('only the parts that are actually there get wired', () => {
  const { settings, added } = wire({});
  assert.ok(added > 0);
  const all = commands(settings).join(' ');
  assert.match(all, /@hyuga\/redline hook pre/);
  assert.match(all, /@hyuga\/airframe hook session/);
  const absent = mounted().filter((p) => !p.present).map((p) => p.name);
  for (const name of absent) assert.doesNotMatch(all, new RegExp(name.replace('/', '\\/')));
});

test('wiring twice does not charge every call twice', () => {
  const once = wire({}).settings;
  const twice = wire(once);
  assert.equal(twice.added, 0);
  assert.deepEqual(commands(twice.settings), commands(once));
});

test('hooks somebody else put there survive', () => {
  const theirs = {
    hooks: {
      PreToolUse: [{ hooks: [{ type: 'command', command: 'their-own-tool check' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
    },
    permissions: { allow: ['Bash(ls:*)'] },
  };
  const { settings } = wire(theirs);
  const all = commands(settings);
  assert.ok(all.includes('their-own-tool check'), 'an existing PreToolUse hook is kept');
  assert.ok(all.includes('say done'), 'an event we never touch is kept');
  assert.deepEqual(settings.permissions, theirs.permissions, 'everything outside hooks is left alone');
});

test('install writes the file, keeps a backup, and is idempotent', (t) => {
  const dir = fresh(t);
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ model: 'opus' }));

  const first = install({ cwd: dir });
  assert.ok(first.added > 0);
  assert.ok(existsSync(first.backup), 'the previous settings are kept');
  const written = JSON.parse(readFileSync(first.file, 'utf8'));
  assert.equal(written.model, 'opus', 'settings that were not ours are untouched');

  const second = install({ cwd: dir });
  assert.equal(second.added, 0);
  assert.equal(second.backup, null, 'nothing changed, so nothing was backed up over');
});

test('settings.json that is not valid JSON is refused, never overwritten', (t) => {
  const dir = fresh(t);
  mkdirSync(join(dir, '.claude'), { recursive: true });
  const file = join(dir, '.claude', 'settings.json');
  writeFileSync(file, '{ this is not json');
  assert.throws(() => install({ cwd: dir }), /not valid JSON/);
  assert.equal(readFileSync(file, 'utf8'), '{ this is not json', 'left exactly as it was');
});

test('a session starts its own sortie, with a pilot in it', (t) => {
  fresh(t);
  session();
  const s = sortie();
  assert.ok(s.id, 'nothing depends on remembering to launch');
  assert.equal(s.autonomy, false);
  assert.equal(s.mode, 'strike');
});

test('autonomy comes from a declared reason, not from nobody typing', (t) => {
  fresh(t);
  process.env.AIRFRAME_AUTONOMY = 'nightly deploy loop, wired on purpose';
  session();
  const s = sortie();
  assert.equal(s.autonomy, true);
  assert.equal(s.autonomyReason, 'nightly deploy loop, wired on purpose');
});

test('the brief from the last sortie reaches the next one', (t) => {
  fresh(t);
  session();
  discard('an idea', 'it was the wrong shape');
  const text = session();
  assert.match(text, /an idea/);
});

test('status says where the machine is', (t) => {
  fresh(t);
  session();
  const text = status();
  assert.match(text, /form\s+strike \/ fire/);
  assert.match(text, /\+ redline /);
});

test('the project settings path is the project one', () => {
  assert.match(settingsPath('project', '/tmp/x'), /[\\/]tmp[\\/]x[\\/]\.claude[\\/]settings\.json$/);
});

test('--bin wires the installed binaries, for machines with no registry to npx from', () => {
  const { settings } = wire({}, mounted(), { how: 'bin' });
  const all = commands(settings);
  assert.ok(all.includes('airframe hook session'));
  assert.ok(all.includes('redline hook pre'));
  assert.ok(!all.some((c) => c.startsWith('npx ')), 'no npx anywhere');
});

test('the two runners are not confused for one another', () => {
  const npx = commands(wire({}).settings);
  const bin = commands(wire({}, mounted(), { how: 'bin' }).settings);
  assert.notDeepEqual(npx, bin);
  // wiring one after the other must not leave both spellings behind
  const mixed = wire(wire({}).settings, mounted(), { how: 'bin' });
  assert.ok(mixed.added > 0, 'a different spelling is a different hook, and is added');
});

test('--local wires absolute paths, so nothing has to be installed at all', () => {
  const all = commands(wire({}, mounted(), { how: 'local' }).settings);
  assert.ok(all.every((c) => c.startsWith('node "')), 'every hook runs a file by path');
  assert.ok(all.some((c) => c.endsWith('redline/src/redline.mjs" hook pre')));
  assert.ok(all.some((c) => c.endsWith('airframe/src/airframe.mjs" hook session')));
  assert.ok(all.every((c) => !c.includes(String.fromCharCode(92))), 'forward slashes, so the JSON stays readable');
});

test('a hook already wired by hand is not wired again in a different spelling', () => {
  const parts = [{ name: '@hyuga/redline', hooks: { PreToolUse: ['hook pre'] }, present: true }];
  const generated = commands(wire({}, parts, { how: 'local' }).settings)[0];
  // the same command as someone would have typed it: unquoted, and with Windows separators
  const typed = generated.replace(/"/g, '').split('/').join('\\');
  assert.notEqual(typed, generated, 'the two spellings really are different strings');

  const again = wire({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: typed }] }] } }, parts, { how: 'local' });
  assert.equal(again.added, 0, 'quoting and slashes are spelling, not a different hook');
  assert.equal(commands(again.settings).length, 1);
});

test('propellant is actually spent, so bingo can be reached at all', (t) => {
  fresh(t);
  process.env.AIRFRAME_BUDGET = '10';
  session();
  for (let i = 0; i < 6; i += 1) assert.equal(spend(), null, 'quiet while there is fuel');
  const warning = spend();
  assert.match(warning, /past bingo/);
  assert.match(warning, /land/);
  delete process.env.AIRFRAME_BUDGET;
});

test('with no budget declared, nothing is ever claimed about the fuel', (t) => {
  fresh(t);
  session();
  for (let i = 0; i < 50; i += 1) assert.equal(spend(), null);
});

test('a sortie lands, and the landing is in the ledger', (t) => {
  fresh(t);
  session();
  spend();
  report(finding({ phase: 'pre', source: 'redline', severity: 'warn', subject: 'x', observed: 1 }));
  land();
  const last = ledger().at(-1);
  assert.equal(last.source, 'airframe');
  assert.equal(last.subject, 'sortie');
  assert.equal(last.observed.worst, 'warn');
  assert.equal(last.observed.spent, 1);
});

test('landing an empty sortie writes nothing', (t) => {
  fresh(t);
  session();
  land();
  assert.equal(ledger().length, 0, 'a session where nothing happened is not a record');
});

test('anything that runs and exits can be mounted, without knowing this exists', (t) => {
  fresh(t);
  session();
  const ok = mount(process.execPath, ['-e', 'console.log("clean")'], { as: 'a-linter' });
  assert.equal(ok.code, 0);
  const bad = mount(process.execPath, ['-e', 'console.log("3 problems"); process.exit(1)'], { as: 'a-linter' });
  assert.equal(bad.code, 1);

  const filed = ledger().filter((f) => f.source === 'a-linter');
  assert.equal(filed.length, 2);
  assert.equal(filed[0].severity, 'note');
  assert.equal(filed[1].severity, 'warn', 'a linter has no business halting a machine');
  assert.equal(filed[1].phase, 'brief', 'ground inspection happens around the sortie');
  assert.deepEqual(filed[1].observed.said, ['3 problems']);
});

test('a wingman leaves a trace, because fan-out otherwise leaves none', (t) => {
  fresh(t);
  session();
  wingman(); wingman(); wingman();
  const sent = ledger().filter((f) => f.actor === 'wingman');
  assert.equal(sent.length, 3);
  assert.equal(sent.at(-1).observed.sent, 3, 'the count is in the record, not only the number of rows');
  assert.match(status(), /wingmen\s+3/);
});

test('a part that scopes a hook keeps its matcher through install', () => {
  const part = {
    name: '@hyuga/habit',
    present: true,
    hooks: { PreToolUse: [{ sub: 'hook pre', matcher: 'Write|Edit' }, 'hook sync'] },
  };
  const { settings } = wire({}, [part], { how: 'bin' });
  const groups = settings.hooks.PreToolUse;

  const scoped = groups.find((g) => g.hooks[0].command === 'habit hook pre');
  const unscoped = groups.find((g) => g.hooks[0].command === 'habit hook sync');
  assert.equal(scoped.matcher, 'Write|Edit');
  assert.equal('matcher' in unscoped, false); // no matcher means every tool, and it must stay that way
});
