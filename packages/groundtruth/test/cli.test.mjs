/**
 * Start the CLI itself and check what it does.
 *
 * The tests that existed imported the functions and never once ran the bin, so flag parsing —
 * the easiest route there is to silencing this gate — went entirely unexercised.
 *
 * Everything the 2026-08 audit found had one shape: degrading quietly instead of refusing.
 *   --bogus value      matched no expectation and fell through to the default, nonempty
 *   --count with no value   became Number(true) === 1
 *   an empty contract file  reported "all confirmed"
 * A gate one typo turns into "anything that printed passes" is not a gate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// import.meta.dirname only exists from Node 20.11, and engines says ">=18".
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, '..', 'src', 'cli.mjs');

/** A probe command that writes s to stdout and exits 0. */
// Wrapped in single quotes: cmd.exe cannot handle nested double quotes.
const emit = (s) => `node -e "process.stdout.write('${s}')"`;

function run(args, cwd) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

test('an unknown flag is a usage error, not a quiet fall-through to the default', () => {
  const r = run(['verify', '--probe', emit('anything'), '--bogus', 'value']);
  assert.equal(r.code, 64, r.out);
  assert.match(r.out, /unknown option/);
});

test('an expectation flag with no value dies, so --count cannot become 1', () => {
  for (const flag of ['--count', '--at-least', '--contains', '--equals', '--matches']) {
    const r = run(['verify', '--probe', emit('1'), flag]);
    assert.equal(r.code, 64, `${flag}: ${r.out}`);
    assert.match(r.out, /needs a value/);
  }
});

test('a threshold that is not a number, or is negative, dies', () => {
  assert.equal(run(['verify', '--probe', emit('1'), '--count', 'abc']).code, 64);
  assert.equal(run(['verify', '--probe', emit('1'), '--at-least', '-1']).code, 64);
});

test('empty output satisfies neither --count 0 nor --at-least 0', () => {
  assert.equal(run(['verify', '--probe', 'node -e ""', '--count', '0']).code, 1);
  assert.equal(run(['verify', '--probe', 'node -e ""', '--at-least', '0']).code, 1);
});

test('a real measurement goes through', () => {
  assert.equal(run(['verify', '--probe', emit('45'), '--count', '45']).code, 0);
  assert.equal(run(['verify', '--probe', emit('0'), '--count', '0']).code, 0);
  assert.equal(run(['verify', '--probe', emit('ok'), '--contains', 'ok']).code, 0);
});

test('--version reads package.json, because a stale constant goes unnoticed', () => {
  const pkg = JSON.parse(readFileSync(resolve(HERE, '..', 'package.json'), 'utf8'));
  const r = run(['--version']);
  assert.equal(r.out.trim(), pkg.version);
});

// ---- guard ----

function withContracts(body, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'groundtruth-guard-'));
  try {
    writeFileSync(join(dir, 'contracts.jsonl'), body);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a file holding no contracts is not reported as "all confirmed"', () => {
  for (const body of ['', '   \n\n\t']) {
    const r = withContracts(body, (d) => run(['guard', 'contracts.jsonl'], d));
    assert.equal(r.code, 2, `body=${JSON.stringify(body)}: ${r.out}`);
    assert.match(r.out, /no contracts/);
  }
});

test('a contract with no expect is not counted as met', () => {
  for (const c of [{ action: 'a', probe: emit('present') }, { action: 'a', probe: emit('present'), expect: {} }]) {
    const r = withContracts(JSON.stringify(c), (d) => run(['guard', 'contracts.jsonl'], d));
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /bad-expect/);
  }
});

test('a properly written contract passes', () => {
  const c = { action: 'rows inserted', probe: emit('45'), expect: { type: 'count', value: 45 } };
  const r = withContracts(JSON.stringify(c), (d) => run(['guard', 'contracts.jsonl'], d));
  assert.equal(r.code, 0, r.out);
});

/**
 * Start the Claude Code Stop hook in adapters/ and check what it does.
 *
 * When 0.4.1 closed `groundtruth guard`'s silent fall-through to nonempty, the hook — which
 * held a copy of the same reading — was not fixed. The hook is the side the README tells
 * people to wire up, so the side that stayed broken was the side actually in use. Two
 * versions could live separate lives because nothing here was under test.
 */
const HOOK = resolve(HERE, '..', 'adapters', 'claude-code', 'groundtruth-stop-hook.mjs');

function runHook(lines, dir) {
  const file = join(dir, 'pending.jsonl');
  writeFileSync(file, Array.isArray(lines) ? lines.map((l) => JSON.stringify(l)).join('\n') : lines);
  return spawnSync(process.execPath, [HOOK], {
    encoding: 'utf8',
    env: { ...process.env, GROUNDTRUTH_PENDING: file },
  });
}

test('Stop hook: an unknown expect.type is not read as "passes if non-empty"', () => {
  const dir = mkdtempSync(join(tmpdir(), 'groundtruth-hook-'));
  try {
    // The probe returns "0". If cnt degrades to nonempty, "0" is non-empty and passes.
    const r = runHook([{ action: 'insert 45 rows', probe: 'echo 0', expect: { type: 'cnt', value: 45 } }], dir);
    assert.equal(r.status, 2, 'an unknown expectation must block completion');
    assert.match(r.stderr, /bad-expect/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Stop hook: a contract that forgot its expect is not confirmed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'groundtruth-hook-'));
  try {
    const r = runHook([{ action: 'insert 45 rows', probe: 'echo 0' }], dir);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /expectation confirms nothing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Stop hook: a broken hook lets nothing through — it fails closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'groundtruth-hook-'));
  try {
    // A pending path that is a directory makes readFileSync throw EISDIR. Returning "could
    // not verify" as "verified" is the exact shape this gate prevents.
    const r = spawnSync(process.execPath, [HOOK], {
      encoding: 'utf8',
      env: { ...process.env, GROUNDTRUTH_PENDING: dir },
    });
    assert.equal(r.status, 2, 'a hook that fell over must not exit 0 and pass the claim');
    assert.match(r.stderr, /stop-hook error/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Stop hook: a met contract goes through and an unmet one blocks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'groundtruth-hook-'));
  try {
    const ok = runHook([{ action: 'insert 45 rows', probe: 'echo 45', expect: { type: 'count', value: 45 } }], dir);
    assert.equal(ok.status, 0);
    const bad = runHook([{ action: 'insert 45 rows', probe: 'echo 0', expect: { type: 'count', value: 45 } }], dir);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /\[count\(45\)\]/, 'it must print the question it asked');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI and the hook read a contract through the same module', async () => {
  // Two copies living separate lives was the hole in 0.4.1.
  const { expectFromSpec } = await import('../src/contract.mjs');
  assert.equal(expectFromSpec({ type: 'count', value: 45 }).groundtruthLabel, 'count(45)');
  assert.equal(expectFromSpec({ type: 'nonEmpty' }).groundtruthLabel, 'nonEmpty', 'case is not a different expectation');
  assert.throws(() => expectFromSpec({ type: 'nope' }), /unknown expect\.type/);
  assert.throws(() => expectFromSpec(undefined), /confirms nothing/);
});
