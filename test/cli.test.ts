import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const run = promisify(execFile);
const CLI = join(process.cwd(), 'dist', 'src', 'cli.js');

/**
 * The flags, checked before anything opens a connection.
 *
 * Every case here is rejected by `parse()`, so none of it needs a database — and
 * that is the point of testing it separately. An argument that survives parsing
 * is an argument the rest of the program treats as meaningful, and two of these
 * used to.
 */
async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...argv], { encoding: 'utf8' });
    return { code: 0, out: stdout, err: stderr };
  } catch (e) {
    const x = e as { code?: number; stdout?: string; stderr?: string };
    return { code: x.code ?? -1, out: x.stdout ?? '', err: x.stderr ?? '' };
  }
}

test('a status nothing can hold is a usage error, not an empty queue', async () => {
  // `--status pendign` reached the query as typed, matched nothing, and printed
  // "No plans." — which reads as "nothing is waiting for you". An approval queue
  // that answers a typo with silence is how an approval goes unread.
  const r = await cli('list', '--status', 'pendign');
  assert.equal(r.code, 2, 'wrong usage exits 2');
  assert.match(r.err, /--status takes one of: pending, approved, applying, applied, failed, cancelled/);
  assert.doesNotMatch(r.out, /No plans/);
});

test('a row cap that is not a number is a usage error, not a stack trace', async () => {
  // `--limit abc` became NaN, travelled into the SQL, and came back as
  // `no such column: NaN` over a stack trace pointing into this library.
  const r = await cli('read', 'SELECT 1', '--limit', 'abc');
  assert.equal(r.code, 2);
  assert.match(r.err, /--limit takes a whole number of rows, 1 or more\. Got "abc"/);
  assert.doesNotMatch(r.err, /at .*\.js:\d+/, 'no stack trace where a sentence belongs');
});

test('zero, negative and fractional row caps are refused rather than passed to the dialect', async () => {
  for (const bad of ['0', '-5', '1.5', '1e999']) {
    const r = await cli('read', 'SELECT 1', '--limit', bad);
    assert.equal(r.code, 2, `--limit ${bad} should be refused`);
    assert.match(r.err, /whole number of rows/);
  }
});

test('a flag with no value says which flag, and exits as wrong usage', async () => {
  const r = await cli('read', 'SELECT 1', '--limit');
  assert.equal(r.code, 2);
  assert.match(r.err, /--limit needs a value/);
});

test('the statuses the parser accepts are the ones the store can hold', async () => {
  // Spelled out so that adding a status to the store and forgetting this list
  // fails here rather than in an operator's console.
  for (const s of ['pending', 'approved', 'applying', 'applied', 'failed', 'cancelled']) {
    const r = await cli('list', '--status', s, '--config', 'no-such-config.json');
    assert.notEqual(r.code, 2, `--status ${s} must parse; it failed as a usage error`);
  }
});

/**
 * The escaping is wired in, not merely written.
 *
 * Testing `escapeInvisibles` on its own proves the function works. It says
 * nothing about whether the command that prints rows calls it, and a check that
 * holds a property in isolation while nothing tests the call site is how the
 * comparison bug in 0.4.3 stayed green for a week. So this goes through the
 * actual command, against a real file, and reads what a person would see.
 */
const HAS_SQLITE = await import('node:sqlite').then(
  () => true,
  () => false,
);

test('rows printed by `read` carry no raw invisible characters', { skip: HAS_SQLITE ? undefined : 'no node:sqlite' }, async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = await mkdtemp(join(tmpdir(), 'llm-safe-sql-cli-'));
  try {
    const file = join(dir, 'app.db');
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
    db.prepare('INSERT INTO notes VALUES (1, ?)').run('\u202edrawkcab\u200b');
    db.close();

    const cfgPath = join(dir, 'llm-safe-sql.config.json');
    await writeFile(
      cfgPath,
      JSON.stringify({
        dialect: 'sqlite',
        connection: { file },
        policy: { allow: ['notes'], impact: { notes: 'test table' } },
      }),
      'utf8',
    );

    const r = await cli('read', 'SELECT body FROM notes', '--config', cfgPath);
    assert.equal(r.code, 0, r.err);
    assert.doesNotMatch(r.out, /[\u202e\u200b]/, 'the override reached the terminal unescaped');
    assert.match(r.out, /\\u202e/);

    // Still JSON, and still the same value underneath.
    const printed = JSON.parse(r.out.slice(0, r.out.lastIndexOf(']') + 1));
    assert.equal(printed[0].body, '\u202edrawkcab\u200b');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('check compares who the connections are, not how they were spelled', { skip: HAS_SQLITE ? undefined : 'no node:sqlite' }, async () => {
  // One SQLite file, named two ways: an apply connection that is not a separate
  // database at all. Comparing the config strings called these two credentials
  // and printed the separation this library is built around as present. Measured
  // on 0.4.5 against PostgreSQL, where `localhost` and `127.0.0.1` are two
  // spellings of one role and both connections answered current_user = postgres.
  const { DatabaseSync } = await import('node:sqlite');
  const dir = await mkdtemp(join(tmpdir(), 'llm-safe-sql-sep-'));
  try {
    const file = join(dir, 'app.db');
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
    db.close();

    // Two strings, one database. `connectionIdentity` compares them as text and
    // calls them two credentials; the file itself has one identity and SQLite
    // knows it.
    assert.notEqual(file, `${dir}/./app.db`, 'the two spellings must differ as text, or this proves nothing');

    const cfgPath = join(dir, 'cfg.json');
    await writeFile(
      cfgPath,
      JSON.stringify({
        dialect: 'sqlite',
        connection: { file },
        applyConnection: { file: `${dir}/./app.db` },
        policy: { allow: ['notes'], impact: { notes: 'test table' } },
      }),
      'utf8',
    );

    await cli('migrate', '--config', cfgPath);
    const r = await cli('check', '--config', cfgPath);
    assert.match(r.out, /apply uses the SAME credential as plan/, r.out);
    assert.doesNotMatch(r.out, /four different accounts/, 'and it must not claim the opposite');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('check says whether the audit record can be erased by the account that writes it', { skip: HAS_SQLITE ? undefined : 'no node:sqlite' }, async () => {
  // The worked examples grant the store account INSERT and no DELETE, and say
  // why. Nothing verified it until 0.4.8: the property was a sentence in the
  // documentation, which is the same shape as comparing credentials by reading
  // the config file. SQLite has no accounts to grant, so the honest answer here
  // is that the trail is editable — and saying so is the point.
  const { DatabaseSync } = await import('node:sqlite');
  const dir = await mkdtemp(join(tmpdir(), 'llm-safe-sql-audit-'));
  try {
    const file = join(dir, 'app.db');
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
    db.close();

    const cfgPath = join(dir, 'cfg.json');
    await writeFile(
      cfgPath,
      JSON.stringify({
        dialect: 'sqlite',
        connection: { file },
        policy: { allow: ['notes'], impact: { notes: 'test table' } },
      }),
      'utf8',
    );

    await cli('migrate', '--config', cfgPath);
    const r = await cli('check', '--config', cfgPath);
    assert.match(r.out, /can also erase it/, r.out);
    assert.match(r.out, /llm_safe_sql_audit/);
    assert.doesNotMatch(r.out, /cannot be erased/, 'and it must not claim the opposite');

    // The probe must not be the thing that erases it.
    const after = new DatabaseSync(file);
    const rows = after.prepare('SELECT count(*) AS n FROM llm_safe_sql_audit').all();
    after.close();
    assert.equal(Number((rows[0] as { n: number }).n), 0, 'nothing was written or removed by check');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
