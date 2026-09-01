import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { launch, enterMelee, finding, report, ledger } from '@hyuga/spar';
import { price, score, check, namedInPrompt, THRESHOLDS } from '../src/redline.mjs';

function fresh(t, { production = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'redline-'));
  const prevHome = process.env.SPAR_HOME;
  const prevProd = process.env.REDLINE_PRODUCTION;
  process.env.SPAR_HOME = dir;
  process.env.REDLINE_PRODUCTION = production.join(';');
  t.after(() => {
    if (prevHome === undefined) delete process.env.SPAR_HOME; else process.env.SPAR_HOME = prevHome;
    if (prevProd === undefined) delete process.env.REDLINE_PRODUCTION; else process.env.REDLINE_PRODUCTION = prevProd;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
const write = (file_path) => ({ tool_name: 'Write', tool_input: { file_path } });

test('the tariff prices what it says it prices', (t) => {
  fresh(t, { production: ['X:/01-client/'] });
  assert.deepEqual(price(bash('rm -rf build')).map((c) => c.kind), ['irreversible']);
  assert.deepEqual(price(bash('npm publish --access public')).map((c) => c.kind), ['outward']);
  assert.deepEqual(price(bash('npm install left-pad')).map((c) => c.kind), ['dependency']);
  assert.deepEqual(price(write('X:/01-client/acme/index.html')).map((c) => c.kind), ['production']);
  assert.deepEqual(price(bash('ls -la')), []);
  assert.deepEqual(price(bash('git status')), []);
});

test('one call can be charged twice, and is', (t) => {
  fresh(t);
  const kinds = price(bash('git push --force origin main')).map((c) => c.kind);
  assert.deepEqual(kinds, ['irreversible', 'outward'], 'a force push is both, and pricing it as one would be the cheaper reading');
});

test('reading production is not writing to it', (t) => {
  fresh(t, { production: ['/var/www/'] });
  assert.deepEqual(price({ tool_name: 'Read', tool_input: { file_path: '/var/www/site/index.html' } }), []);
  assert.deepEqual(price(write('/var/www/site/index.html')).map((c) => c.kind), ['production']);
  assert.deepEqual(price(bash('cp local.html /var/www/site/index.html')).map((c) => c.kind), ['production'],
    'the shell reaches production too');
});

test('the score only goes up, and it is the sortie that is counted', (t) => {
  fresh(t, { production: ['/var/www/'] });
  launch({ mode: 'strike' });
  assert.equal(score(), 0);
  check(write('/var/www/a.html'));
  assert.equal(score(), 2);
  check(write('/var/www/b.html'));
  assert.equal(score(), 4, 'two defensible writes are still four');
  launch({ mode: 'strike' });
  assert.equal(score(), 0, 'a new sortie starts empty');
});

test('under the edge it says nothing', (t) => {
  fresh(t);
  launch({ mode: 'strike' });
  assert.equal(check(bash('npm install left-pad')), null, '1 point is recorded, not announced');
  assert.equal(ledger().length, 1, 'recorded all the same');
});

test('halfway there, it advises', (t) => {
  fresh(t, { production: ['/var/www/'] });
  launch({ mode: 'strike' });
  const out = check(write('/var/www/a.html'));
  assert.equal(out.verdict, 'advise');
  assert.match(out.message, /redline: 2/);
  assert.match(out.message, /Halfway/);
});

test('past the edge with a pilot aboard, it is the pilot\'s call', (t) => {
  fresh(t);
  launch({ mode: 'strike' });
  const out = check(bash('npm publish'));
  assert.equal(out.verdict, 'advise', 'a pilot is told, never overruled');
  assert.match(out.message, /your call/);
});

test('past the edge with nobody in the seat, it stops', (t) => {
  fresh(t);
  launch({ mode: 'strike', autonomy: true, reason: 'wired into a nightly loop on purpose' });
  const out = check(bash('npm publish'));
  assert.equal(out.verdict, 'halt', 'denied, not narrated');
  assert.match(out.message, /Stopping here/);
});

test('past the edge, a call that costs nothing is not the one that gets stopped', (t) => {
  fresh(t);
  launch({ mode: 'strike', autonomy: true, reason: 'wired into a nightly loop on purpose' });
  report(finding({ phase: 'brief', source: 'redline', subject: 'scope', observed: ['readme.md'], actor: 'human' }));
  assert.equal(check(bash('rm -rf build')).verdict, 'halt', 'the irreversible one is stopped');
  assert.equal(score(), 3, 'and the sortie has spent it');

  // The shape that deadlocked a scheduled run: everything after the deletion was denied,
  // including writing a scratch file, so the task could not even hand back.
  assert.equal(check(write('scratch/notes.json')), null, 'a free call is not denied for the last one');
  assert.equal(score(), 3, 'and it is still 3 — the score never went down to get here');
});

test('in melee it does not stop the swing — it refuses the next one', (t) => {
  fresh(t, { production: ['/var/www/'] });
  launch({ mode: 'strike', autonomy: true, reason: 'scheduled deploy' });
  enterMelee({ action: 'deploy to /var/www', exit: 'backup at 09:00 restored', state: 'sha 4f2a' });
  const msg = check(bash('rm -rf /var/www/old'));
  assert.equal(msg, null, 'the frame defers findings mid-swing; nothing interrupts');
  const held = ledger().filter((f) => f.source === 'redline');
  assert.equal(held.length, 1, 'still written down, to be judged on the way out');
});

test('cruise is not policed', (t) => {
  fresh(t);
  launch({ mode: 'cruise' });
  assert.equal(check(bash('npm publish')), null, 'a draft is not a deployment');
});

test('an unnamed file is only charged when the scope is actually known', (t) => {
  fresh(t);
  launch({ mode: 'strike' });
  assert.deepEqual(price(write('src/whatever.mjs')), [], 'no prompt hook installed — never guess the scope');

  report(finding({ phase: 'brief', source: 'redline', subject: 'scope', observed: ['readme.md'], actor: 'human' }));
  assert.deepEqual(price(write('src/whatever.mjs')).map((c) => c.kind), ['unnamed']);
  assert.deepEqual(price(write('docs/README.md')), [], 'the file the human named is free');
});

test('unnamed is a reading, not a charge', (t) => {
  fresh(t);
  launch({ mode: 'strike' });
  report(finding({ phase: 'brief', source: 'redline', subject: 'scope', observed: ['readme.md'], actor: 'human' }));

  // The shape that spent a whole limit in 41 seconds: a skill writing the files it exists to
  // write, none of which the human could have named, four of them before it has really begun.
  for (const f of ['_targets.yml', '_industry_topics.yml', '_content_queue.yml', '_action_ledger.yml']) {
    assert.equal(check(write(f)), null, f + ' says nothing');
  }
  assert.equal(score(), 0, 'four files nobody asked for is still nothing spent');

  // Filed all the same. What it wrote that nobody asked for stays answerable afterwards; it
  // just is not answered by the number.
  const filed = ledger().filter((f) => f.source === 'redline' && f.phase === 'pre');
  assert.equal(filed.length, 4);
  assert.deepEqual(filed[0].observed, { points: 0, total: 0, kinds: ['unnamed'] });
});

test('the config is found from wherever the work is, not only from the top of it', (t) => {
  const root = fresh(t);
  writeFileSync(join(root, '.redline.json'), JSON.stringify({ production: ['/var/www/'] }), 'utf8');
  const deep = join(root, 'clients', 'acme', 'web');
  mkdirSync(deep, { recursive: true });

  // The working directory is wherever the work is, and it is nowhere near where anybody would
  // think to write down which paths are production. Not finding the file is silent, and what it
  // costs is the whole tool: the most exposed write of the day gets charged as an ordinary one.
  assert.deepEqual(price(write('/var/www/site/index.html'), deep).map((c) => c.kind), ['production']);
});

test('the tree the file lives in is asked too, not only the one the session started in', (t) => {
  const root = fresh(t);
  const share = join(root, 'share');
  const deep = join(share, 'clients', 'acme', '01_web');
  mkdirSync(deep, { recursive: true });
  writeFileSync(join(share, '.redline.json'), JSON.stringify({ production: ['/share/clients/'] }), 'utf8');
  const started = join(root, 'home');
  mkdirSync(started, { recursive: true });

  // The shape a work machine actually has: the session is started in a home directory and never
  // leaves it, and every write of the day lands on a network share. Nothing at or above the
  // session's directory says a word about production; the share knows perfectly well.
  assert.deepEqual(price(write(join(deep, 'index.html')), started).map((c) => c.kind), ['production']);
});

test('two configs are added together, never ranked', (t) => {
  const root = fresh(t);
  const share = join(root, 'share', 'clients');
  mkdirSync(share, { recursive: true });
  const started = join(root, 'home');
  mkdirSync(started, { recursive: true });
  writeFileSync(join(root, 'share', '.redline.json'), JSON.stringify({ production: ['/share/clients/'] }), 'utf8');
  writeFileSync(join(started, '.redline.json'), JSON.stringify({ production: ['/var/www/'] }), 'utf8');

  // Ranking would let the directory being written to shorten the list the session started with,
  // which is a quieter limiter chosen by the thing it is meant to be watching.
  assert.deepEqual(price(write(join(share, 'x.html')), started).map((c) => c.kind), ['production']);
  assert.deepEqual(price(write('/var/www/x.html'), started).map((c) => c.kind), ['production']);
});

test('the files a human named are pulled out of their own words', () => {
  assert.deepEqual(namedInPrompt('fix the bug in src/app.mjs and update README.md').sort(), ['app.mjs', 'readme.md']);
  assert.deepEqual(namedInPrompt('make it faster'), []);
});

test('the limit is where the tariff says it is', () => {
  assert.equal(THRESHOLDS.stop, 3);
});

test('a committed-looking call is told where melee is', (t) => {
  fresh(t, { production: ['/var/www/'] });
  launch({ mode: 'strike' });
  const out = check(write('/var/www/index.html'));
  assert.match(out.message, /close to melee first/);
  assert.match(out.message, /exit route/);
});

test('a harmless call is not', (t) => {
  fresh(t);
  launch({ mode: 'strike' });
  check(bash('npm install a'));
  const out = check(bash('npm install b'));
  assert.doesNotMatch(out.message, /melee/);
});

test('already committed, it does not say it twice', (t) => {
  fresh(t, { production: ['/var/www/'] });
  launch({ mode: 'strike' });
  enterMelee({ action: 'deploy', exit: 'backup', state: 'now' });
  assert.equal(check(write('/var/www/index.html')), null, 'nothing interrupts a swing at all');
});

// ---- the shell the session is actually in (added after the pre-publish audit) ----

test('PowerShell and cmd destructive commands are charged, not just bash ones', (t) => {
  const dir = fresh(t);
  const bash = (command) => price({ tool_name: 'Bash', tool_input: { command } }, dir);

  for (const command of [
    'Remove-Item -Recurse -Force C:\build',
    'Clear-Content .\notes.md',
    'rmdir /s /q build',
    'del /s /q *.tmp',
  ]) {
    const charges = bash(command);
    assert.equal(
      charges.some((c) => c.kind === 'irreversible'), true,
      `${command} should be charged as irreversible`,
    );
  }
});

test('an outward PowerShell call is charged like curl is', (t) => {
  const dir = fresh(t);
  const charges = price(
    { tool_name: 'Bash', tool_input: { command: 'Invoke-RestMethod -Uri $u -Method POST' } },
    dir,
  );
  assert.equal(charges.some((c) => c.kind === 'outward'), true);
});

test('quoting a dangerous command is not running one', (t) => {
  fresh(t, { production: ['X:/01-client/'] });
  // What cost this limiter its own credibility: a session that only ever searched for the
  // words reached 20 against a limit of 3, and every charge was a quotation.
  assert.deepEqual(price(bash('grep "npm publish" README.md')), []);
  assert.deepEqual(price(bash('rg "rm -rf" packages/')), []);
  assert.deepEqual(price(bash('cat .github/workflows/release.yml')), []);
  assert.deepEqual(price(bash('echo "git push --force is what we do not do"')), []);
  assert.deepEqual(price(bash('grep -r X:/01-client/ notes/')), [],
    'naming a production path is not reaching one');
  // And the words still cost what they cost when they are the command.
  assert.deepEqual(price(bash('npm publish --access public')).map((c) => c.kind), ['outward']);
});

test('a command is cut into the things it actually runs', (t) => {
  fresh(t);
  // The reading half is dropped; the half after it is not.
  assert.deepEqual(price(bash('grep "npm publish" README.md && npm publish')).map((c) => c.kind),
    ['outward'], 'the publish after the grep is still a publish');
  // A separator inside quotes is a character, not a break.
  assert.deepEqual(price(bash('grep "a; rm -rf /" notes.md')), []);
  // The charge names the part that earned it, not the whole line.
  const [charge] = price(bash('cat notes.md | head -20 ; rm -rf build'));
  assert.equal(charge.on, 'rm -rf build');
});

test('a command that takes another command is not treated as reading', (t) => {
  fresh(t);
  // find, sed, awk and xargs each take an argument that is itself a command, so their
  // arguments are not merely text.
  assert.deepEqual(price(bash('find . -name "*.tmp" -exec rm -rf {} +')).map((c) => c.kind),
    ['irreversible']);
  assert.deepEqual(price(bash('git ls-files | xargs rm -rf')).map((c) => c.kind), ['irreversible']);
});

test('what a heredoc writes is a file, not a command', (t) => {
  fresh(t);
  const write = [
    "cat >> test.mjs <<'ZZEOF'",
    "  assert.deepEqual(price(bash('rm -rf build')).map((c) => c.kind), ['irreversible']);",
    "  assert.deepEqual(price(bash('npm publish')).map((c) => c.kind), ['outward']);",
    'ZZEOF',
  ].join('\n');
  assert.deepEqual(price(bash(write)), [], 'the body is what is being written down');

  // The command after the heredoc still runs, and is still charged.
  assert.deepEqual(price(bash(`${write}\nnpm publish`)).map((c) => c.kind), ['outward']);

  // A heredoc nobody closed takes the rest: the body is the part not meant to run, and
  // guessing where it ends in favour of charging is the wrong way to be wrong.
  assert.deepEqual(price(bash("cat > x <<'EOF'\nrm -rf /\n")), []);
});

test('the scope is this sortie\'s, not the one before it', (t) => {
  fresh(t);
  launch({ mode: 'strike' });
  // what the prompt hook files when the human names a file in their own words
  report(finding({ phase: 'brief', source: 'redline', subject: 'scope', observed: ['a.md'], actor: 'human' }));
  assert.deepEqual(price(write('b.md')).map((c) => c.kind), ['unnamed'],
    'inside the sortie that named a.md, b.md is the agent\'s own idea');

  // A new sortie, and nobody has typed anything yet. Judging the first writes against
  // yesterday's prompt charges for a list from a conversation that is over.
  launch({ mode: 'strike' });
  assert.deepEqual(price(write('b.md')), []);
});
