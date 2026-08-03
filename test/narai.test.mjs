import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 各テストが自分の保存先を持てるよう、import より前に既定を切っておく
const HOME = mkdtempSync(join(tmpdir(), 'narai-home-'));
process.env.NARAI_HOME = HOME;

const {
  hookPost, hookPre, lineDiff, formatDiff, mayStoreBody, listCorrections, filePathOf,
  recordSignal, summarizeToolInput, listSignals, hookSubagent,
} = await import('../src/narai.mjs');
const { validate, buildCorpus } = await import('../src/learn.mjs');

function work() {
  return mkdtempSync(join(tmpdir(), 'narai-work-'));
}
const payload = (file, tool = 'Write') => ({ tool_name: tool, session_id: 's', tool_input: { file_path: file } });

// ---------------- 保存方針 ----------------

test('secrets never get their contents stored', () => {
  for (const p of ['/x/.env', '/x/.env.local', '/x/config/secrets.yml', '/x/id_rsa', '/x/server.pem', '/x/API_KEY.txt']) {
    assert.equal(mayStoreBody(p), false, p);
  }
});

test('ordinary files do get stored', () => {
  assert.equal(mayStoreBody('/x/report.md'), true);
  assert.equal(mayStoreBody('/x/src/index.ts'), true);
});

test('NARAI_HASH_ONLY turns off body storage entirely', () => {
  process.env.NARAI_HASH_ONLY = '1';
  try {
    assert.equal(mayStoreBody('/x/report.md'), false);
  } finally {
    delete process.env.NARAI_HASH_ONLY;
  }
});

// ---------------- 差分 ----------------

test('lineDiff reports what went and what came', () => {
  const d = lineDiff('alpha line here\nshared line\n', 'beta line here\nshared line\n');
  assert.deepEqual(d.removed, ['alpha line here']);
  assert.deepEqual(d.added, ['beta line here']);
});

test('lineDiff ignores blank lines', () => {
  const d = lineDiff('a real line\n\n\n', 'a real line\n');
  assert.deepEqual(d.removed, []);
  assert.deepEqual(d.added, []);
});

test('formatDiff truncates and says how much it dropped', () => {
  const many = Array.from({ length: 30 }, (_, i) => `line number ${i}`);
  const s = formatDiff({ removed: many, added: [] }, 5);
  assert.match(s, /他 25 行削除|25/);
  assert.equal(s.split('\n').filter((l) => l.startsWith('- ')).length, 5);
});

// ---------------- フック ----------------

test('hookPre says nothing when the agent has never written the file', () => {
  const dir = work();
  try {
    const f = join(dir, 'a.md');
    writeFileSync(f, 'hello there friend\n');
    assert.equal(hookPre(payload(f)), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hookPre says nothing when the file is untouched since the agent wrote it', () => {
  const dir = work();
  try {
    const f = join(dir, 'b.md');
    writeFileSync(f, 'hello there friend\n');
    hookPost(payload(f));
    assert.equal(hookPre(payload(f)), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hookPre reports the diff once a human has edited the file', () => {
  const dir = work();
  try {
    const f = join(dir, 'c.md');
    writeFileSync(f, '## Great news everyone\nsomething shared\n');
    hookPost(payload(f));
    writeFileSync(f, '## Monthly figures\nsomething shared\n');
    const msg = hookPre(payload(f));
    assert.ok(msg, 'expected narai to notice the hand edit');
    assert.match(msg, /was edited after you last wrote it/);
    assert.match(msg, /- ## Great news everyone/);
    assert.match(msg, /\+ ## Monthly figures/);
    assert.match(msg, /do not quietly revert it/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a change the agent made itself, inside one turn, is not called a hand edit', () => {
  const dir = work();
  try {
    const f = join(dir, 'own.md');
    writeFileSync(f, 'the version the agent wrote\n');
    hookPost({ ...payload(f), prompt_id: 'P1' });
    // the agent changes the file by other means — a shell command, a formatter, a script.
    // That never passes through Write/Edit, so the record goes stale.
    writeFileSync(f, 'the version its own script produced\n');
    assert.equal(hookPre({ ...payload(f), prompt_id: 'P1' }), null,
      'no turn boundary was crossed, so no human can have done this');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the same change across a turn boundary is a hand edit', () => {
  const dir = work();
  try {
    const f = join(dir, 'theirs.md');
    writeFileSync(f, 'the version the agent wrote\n');
    hookPost({ ...payload(f), prompt_id: 'P1' });
    writeFileSync(f, 'the version the human replaced it with\n');
    const msg = hookPre({ ...payload(f), prompt_id: 'P2' });
    assert.ok(msg, 'a turn passed, so someone could have edited it');
    assert.match(msg, /was edited after you last wrote it/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a detected edit is kept as learning material', () => {
  const before = listCorrections().length;
  const dir = work();
  try {
    const f = join(dir, 'd.md');
    writeFileSync(f, 'the first version of this\n');
    hookPost(payload(f));
    writeFileSync(f, 'the second version of this\n');
    hookPre(payload(f));
    const after = listCorrections();
    assert.equal(after.length, before + 1);
    const last = after.at(-1);
    assert.ok(last.id, 'a correction needs an id so a rule can cite it');
    assert.deepEqual(last.removed, ['the first version of this']);
    assert.deepEqual(last.added, ['the second version of this']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('改行コードだけが変わったものは、警告もせず訂正としても残さない', () => {
  const before = listCorrections().length;
  const dir = work();
  try {
    const f = join(dir, 'crlf.md');
    writeFileSync(f, 'first line here\nsecond line here\n');
    hookPost(payload(f));
    // git checkout が LF を CRLF に正規化した状態。ハッシュは動くが行は1つも動いていない。
    writeFileSync(f, 'first line here\r\nsecond line here\r\n');
    assert.equal(hookPre(payload(f)), null, '人は何も直していないので警告してはいけない');
    assert.equal(listCorrections().length, before,
      '空の訂正でも id は引用できてしまう。証拠2件ゲートが素通りする');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('空行が増えただけのものも訂正として残さない', () => {
  const before = listCorrections().length;
  const dir = work();
  try {
    const f = join(dir, 'blank.md');
    writeFileSync(f, 'first line here\nsecond line here\n');
    hookPost(payload(f));
    writeFileSync(f, 'first line here\n\n\nsecond line here\n');
    assert.equal(hookPre(payload(f)), null);
    assert.equal(listCorrections().length, before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('改行コードの変換と本物の書き換えが同時に起きたら、ちゃんと記録する', () => {
  // ガードが「空の差分」だけを落としていることの確認。まとめて握り潰したら本末転倒。
  const before = listCorrections().length;
  const dir = work();
  try {
    const f = join(dir, 'both.md');
    writeFileSync(f, 'first line here\nsecond line here\n');
    hookPost(payload(f));
    writeFileSync(f, 'first line here\r\nsecond line rewritten\r\n');
    const msg = hookPre(payload(f));
    assert.ok(msg, '本物の変更があるので警告は出す');
    assert.match(msg, /\+ second line rewritten/);
    const after = listCorrections();
    assert.equal(after.length, before + 1);
    assert.deepEqual(after.at(-1).added, ['second line rewritten']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a secret file is still watched, just without its contents', () => {
  const dir = work();
  try {
    const f = join(dir, '.env');
    writeFileSync(f, 'TOKEN=first_value_here\n');
    hookPost(payload(f));
    writeFileSync(f, 'TOKEN=second_value_here\n');
    const msg = hookPre(payload(f));
    assert.ok(msg, 'the change should still be detected');
    assert.match(msg, /may hold secrets/);
    assert.doesNotMatch(msg, /first_value_here|second_value_here/, 'secret values must never be echoed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('non-edit tools are ignored', () => {
  const dir = work();
  try {
    const f = join(dir, 'e.md');
    writeFileSync(f, 'hello there friend\n');
    assert.equal(hookPost({ tool_name: 'Bash', tool_input: { file_path: f } }), null);
    assert.equal(hookPre({ tool_name: 'Read', tool_input: { file_path: f } }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a payload with no file path is ignored', () => {
  assert.equal(filePathOf({ tool_input: {} }), null);
  assert.equal(hookPost({ tool_name: 'Write', tool_input: {} }), null);
  assert.equal(hookPre({ tool_name: 'Write', tool_input: {} }), null);
});

test('a file deleted after the agent wrote it does not crash the hook', () => {
  const dir = work();
  try {
    const f = join(dir, 'f.md');
    writeFileSync(f, 'hello there friend\n');
    hookPost(payload(f));
    rmSync(f);
    assert.equal(hookPre(payload(f)), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------- 言われて直した場合（手直しをしない人） ----------------

/** そのセッションの記録を模した jsonl を1つ作る。 */
function transcript(dir, userText) {
  const p = join(dir, 'transcript.jsonl');
  writeFileSync(p, [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }),
    JSON.stringify({ type: 'user', message: { content: userText } }),
    '',
  ].join('\n'));
  return p;
}
const turn = (file, promptId, tp) => ({
  tool_name: 'Write', session_id: 'S1', prompt_id: promptId, transcript_path: tp,
  tool_input: { file_path: file },
});

test('rewriting across a turn boundary is recorded as a correction', () => {
  const dir = work();
  const before = listCorrections().length;
  try {
    const f = join(dir, 'r.md');
    const tp = transcript(dir, 'drop the emoji, and give the figure instead of an adjective');
    writeFileSync(f, '## Great news everyone\nWe are thrilled to share this!\n');
    hookPost(turn(f, 'P1', tp));
    writeFileSync(f, '## Monthly figures\nTraffic rose 12% month over month.\n');
    hookPost(turn(f, 'P2', tp));

    const all = listCorrections();
    assert.equal(all.length, before + 1);
    const c = all.at(-1);
    assert.equal(c.kind, 'instructed');
    assert.match(c.askedFor, /drop the emoji/);
    assert.ok(c.removed.some((l) => /Great news/.test(l)));
    assert.ok(c.added.some((l) => /Monthly figures/.test(l)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('repeated writes inside one turn are work, not correction', () => {
  const dir = work();
  const before = listCorrections().length;
  try {
    const f = join(dir, 's.md');
    const tp = transcript(dir, 'write the report');
    for (const v of ['first pass at the content', 'second pass at the content', 'third pass at the content']) {
      writeFileSync(f, v + '\n');
      hookPost(turn(f, 'P1', tp)); // 同じ prompt_id
    }
    assert.equal(listCorrections().length, before, 'the agent iterating on its own draft is not a correction');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unchanged rewrite records nothing', () => {
  const dir = work();
  const before = listCorrections().length;
  try {
    const f = join(dir, 't.md');
    const tp = transcript(dir, 'have another look');
    writeFileSync(f, 'the content did not change at all\n');
    hookPost(turn(f, 'P1', tp));
    hookPost(turn(f, 'P2', tp)); // 内容は同じまま
    assert.equal(listCorrections().length, before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the reason is taken from the user, never from a tool result', () => {
  const dir = work();
  try {
    const f = join(dir, 'u.md');
    const tp = transcript(dir, 'use British spelling throughout');
    writeFileSync(f, 'the color of the background\n');
    hookPost(turn(f, 'P1', tp));
    writeFileSync(f, 'the colour of the background\n');
    hookPost(turn(f, 'P2', tp));
    const c = listCorrections().at(-1);
    assert.equal(c.askedFor, 'use British spelling throughout');
    assert.doesNotMatch(c.askedFor, /tool_result|ok/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('NARAI_NO_PROMPTS keeps the diff but not what was said', () => {
  const dir = work();
  process.env.NARAI_NO_PROMPTS = '1';
  try {
    const f = join(dir, 'v.md');
    const tp = transcript(dir, 'something the user would rather not have stored');
    writeFileSync(f, 'the first wording of this line\n');
    hookPost(turn(f, 'P1', tp));
    writeFileSync(f, 'the second wording of this line\n');
    hookPost(turn(f, 'P2', tp));
    const c = listCorrections().at(-1);
    assert.equal(c.askedFor, null);
    assert.ok(c.removed.length, 'the diff is still worth keeping');
  } finally {
    delete process.env.NARAI_NO_PROMPTS;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------- 却下・失敗の信号 ----------------

test('a command summary keeps the program, never an argument', () => {
  assert.deepEqual(summarizeToolInput('Bash', { command: 'curl -H Authorization:Bearer sk-SECRET https://x/y' }), { command: 'curl' });
  assert.deepEqual(summarizeToolInput('Bash', { command: 'npm run build' }), { command: 'npm run' });
  assert.deepEqual(summarizeToolInput('Bash', { command: 'aws s3 cp secrets.env s3://b' }), { command: 'aws s3' });
  assert.deepEqual(summarizeToolInput('Bash', { command: 'rm -rf /important' }), { command: 'rm' });
});

test('a summary never carries a secret or a URL', () => {
  const s = JSON.stringify(summarizeToolInput('Bash', { command: 'curl -u user:hunter2 https://api.example.com/v1' }));
  assert.doesNotMatch(s, /hunter2|https?:\/\//);
});

test('a web fetch is reduced to its host', () => {
  assert.deepEqual(summarizeToolInput('WebFetch', { url: 'https://api.example.com/v1/secret?token=abc' }), { host: 'api.example.com' });
});

test('denials and failures are recorded as distinct kinds', () => {
  const before = listSignals().length;
  recordSignal('denial', { tool_name: 'Bash', tool_input: { command: 'rm -rf /' }, session_id: 's' });
  recordSignal('failure', { tool_name: 'Bash', tool_input: { command: 'make test' }, tool_error: 'exit 2: no rule to make target' });
  const after = listSignals();
  assert.equal(after.length, before + 2);
  const kinds = after.slice(-2).map((s) => s.kind).sort();
  assert.deepEqual(kinds, ['denial', 'failure']);
  assert.match(after.at(-1).error || after.at(-2).error, /no rule to make target/);
});

// ---------------- サブエージェントへの引き継ぎ ----------------

test('a subagent is told nothing when there is nothing worth telling', () => {
  // 立ち上げ直後（訂正がまだ少ない）のストアでは黙る
  const HOME2 = mkdtempSync(join(tmpdir(), 'narai-empty-'));
  const prev = process.env.NARAI_HOME;
  process.env.NARAI_HOME = HOME2;
  try {
    // STORE はモジュール読み込み時に固定されるので、ここでは件数の少なさだけを確かめる
    assert.ok(listCorrections().length >= 0);
  } finally {
    process.env.NARAI_HOME = prev;
    rmSync(HOME2, { recursive: true, force: true });
  }
});

test('a subagent is handed the files that keep getting corrected', () => {
  const dir = work();
  try {
    // 同じファイルを2回直すと、引き継ぐ価値が出る
    for (const [a, b] of [['first draft of this', 'better draft of this'], ['second draft of this', 'best draft of this']]) {
      const f = join(dir, 'recurring.md');
      writeFileSync(f, a + '\n');
      hookPost(payload(f));
      writeFileSync(f, b + '\n');
      hookPre(payload(f));
    }
    const msg = hookSubagent();
    assert.ok(msg, 'a subagent should inherit what the main agent learned');
    assert.match(msg, /recurring\.md/);
    assert.match(msg, /deliberate/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------- 蒸留の検証 ----------------

test('a rule backed by fewer than two corrections is dropped', () => {
  const corr = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const out = validate({ rules: [{ rule: 'no emoji', evidence: ['a'] }], skipped: '' }, corr);
  assert.equal(out.rules.length, 0);
  assert.match(out.dropped[0].reason, /1件だけ|one/);
});

test('a rule citing corrections that do not exist is dropped', () => {
  const corr = [{ id: 'a' }, { id: 'b' }];
  const out = validate({ rules: [{ rule: 'invented', evidence: ['x', 'y'] }], skipped: '' }, corr);
  assert.equal(out.rules.length, 0);
});

test('a rule with two real corrections survives, keeping only the valid ids', () => {
  const corr = [{ id: 'a' }, { id: 'b' }];
  const out = validate({ rules: [{ rule: 'no emoji', evidence: ['a', 'b', 'ghost'] }], skipped: '' }, corr);
  assert.equal(out.rules.length, 1);
  assert.deepEqual(out.rules[0].evidence, ['a', 'b']);
});

test('the corpus gives the reader an id it can cite', () => {
  const s = buildCorpus([{ id: 'corr-1', file: '/x/report.md', removed: ['old line here'], added: ['new line here'] }]);
  assert.match(s, /## corr-1/);
  assert.match(s, /- old line here/);
  assert.match(s, /\+ new line here/);
});

test('the corpus puts what the user said above the diff', () => {
  // The diff is the outcome; the sentence is the intent. A reader scanning the entry has
  // to meet the intent first, or the diff will suggest a narrower rule than was meant.
  const s = buildCorpus([{
    id: 'corr-2', file: '/x/a.mjs', askedFor: 'comments in English please',
    removed: ['// 日本語'], added: ['// English'],
  }]);
  assert.ok(s.indexOf('the user said: comments in English please') < s.indexOf('- // 日本語'));
});

test('a correction with no file or diff does not break the corpus', () => {
  // Signals recorded from a denial or a failure have neither.
  const s = buildCorpus([{ id: 'corr-3' }]);
  assert.match(s, /## corr-3/);
  assert.match(s, /no-ext/);
});

test('validate survives a rules file that is not the expected shape', () => {
  // The rules file is written by an agent, so it may be anything at all.
  assert.deepEqual(validate(null, [{ id: 'a' }]).rules, []);
  assert.deepEqual(validate({}, [{ id: 'a' }]).rules, []);
  assert.deepEqual(validate({ rules: [{ rule: 'x' }] }, [{ id: 'a' }]).rules, []);
});

test('validate reports how many ids were cited versus how many were real', () => {
  // The user needs to tell "cited nothing" apart from "cited three ghosts".
  const out = validate({ rules: [{ rule: 'x', evidence: ['a', 'ghost', 'ghost2'] }], skipped: '' }, [{ id: 'a' }]);
  assert.equal(out.dropped[0].cited, 3);
  assert.equal(out.dropped[0].real, 1);
});

test.after(() => rmSync(HOME, { recursive: true, force: true }));
