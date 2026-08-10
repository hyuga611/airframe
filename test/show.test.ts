import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeInvisibles, inline, showValue } from '../src/show.js';

/**
 * What a value is allowed to do to the display it appears in.
 *
 * The card's claim is that a person can read it and know what they are agreeing
 * to. That claim is only as good as the rendering, and the rendering takes its
 * input from two places that are not trusted: the database, and the model.
 */

test('a value cannot forge the lines around it', () => {
  assert.equal(inline('a\nb'), 'a\\nb');
  assert.equal(inline('a\r\nb'), 'a\\r\\nb');
  assert.equal(inline('a\tb'), 'a\\tb');
  // An ANSI escape can repaint or erase what is already on screen.
  assert.equal(inline('\u001b[2Kfake'), '\\x1b[2Kfake');
  assert.equal(inline('\u0000'), '\\x00');
});

test('a value cannot reverse the line it is printed on', () => {
  // U+202E RIGHT-TO-LEFT OVERRIDE reorders everything after it in any renderer
  // implementing the bidirectional algorithm — which is every browser and chat
  // client the card reaches, and most terminals. Left alone, a stored value can
  // invert the arrow and show the change running the other way.
  assert.equal(inline('\u202ednetterp'), '\\u{202e}dnetterp');
  assert.equal(inline('\u202aa\u202bb\u202cc'), '\\u{202a}a\\u{202b}b\\u{202c}c');
  assert.equal(inline('\u2066x\u2069'), '\\u{2066}x\\u{2069}');
});

test('a value cannot be invisible', () => {
  // Each of these renders as nothing at all, so 'viewer' and 'viewer<this>' are
  // the same picture and a real change reads as no change.
  assert.equal(inline('viewer\u200b'), 'viewer\\u{200b}');
  assert.equal(inline('\ufeffa'), '\\u{feff}a');
  assert.equal(inline('a\u00adb'), 'a\\xadb');
  assert.equal(inline('a\u2060b'), 'a\\u{2060}b');
  // Tag characters carry whole hidden strings past a reader.
  assert.equal(inline('a\u{E0041}'), 'a\\u{e0041}');
});

test('a value cannot smuggle a line break past the escaping', () => {
  // U+2028 and U+2029 are newlines in a browser and in several terminals, and
  // they are not control characters, so a class-based check misses them.
  assert.equal(inline('a\u2028b'), 'a\\u{2028}b');
  assert.equal(inline('a\u2029b'), 'a\\u{2029}b');
});

test('ordinary text is left alone, including text that is not English', () => {
  // Escaping is not free: if it fired on normal values the card would be unreadable
  // and people would stop reading it, which is the same failure by a longer route.
  assert.equal(inline('Ada Lovelace'), 'Ada Lovelace');
  assert.equal(inline('神奈川県横浜市'), '神奈川県横浜市');
  assert.equal(inline('Ångström — naïve'), 'Ångström — naïve');
  assert.equal(inline('R-1/2026 (100%)'), 'R-1/2026 (100%)');
});

test('a truncated value carries its length and a digest of the whole thing', () => {
  const a = `${'x'.repeat(100)}A`;
  const b = `${'x'.repeat(100)}B`;
  const sa = showValue(a);
  const sb = showValue(b);
  assert.ok(sa.includes('101 chars'), sa);
  assert.ok(/sha256:[0-9a-f]{8}/.test(sa), sa);
  assert.notEqual(sa, sb, 'two values sharing a prefix must not render as the same text');
});

test('the empty string and no value at all are different on the page', () => {
  assert.equal(showValue(''), "''");
  assert.equal(showValue(null), '(empty)');
  assert.equal(showValue(undefined), '(empty)');
  // And a string that spells the placeholder is not the placeholder.
  assert.equal(showValue('(empty)'), "'(empty)'");
});

test('binary is summarised with a digest, not dumped and not decoded', () => {
  const s = showValue(Buffer.from([0xde, 0xad, 0xbe, 0xef]));
  assert.match(s, /^<4 bytes of binary, sha256:[0-9a-f]{8}>$/);
  assert.notEqual(s, showValue(Buffer.from([0xde, 0xad, 0xbe, 0xee])));
});

test('an invisible letter is escaped, not passed through', () => {
  // Default_Ignorable, not Cf: a check on character category walks past both of
  // these. U+3164 is a letter and U+115F is a letter, and both draw nothing.
  assert.equal(inline('viewer\u3164'), 'viewer\\u{3164}');
  assert.equal(inline('a\u115fb'), 'a\\u{115f}b');
});

test('JSON on its way to a terminal or a model carries no invisible characters', () => {
  // `JSON.stringify` escapes what JSON requires and nothing more, so a
  // right-to-left override or a tag character reaches the reader intact. Reads
  // are the larger surface here: no write privilege is needed to put a value in
  // front of a model, and the tag block at U+E0000 can carry a whole sentence
  // that no reader will ever see.
  const rows = [{ note: '\u202edrawkcab', tag: 'a\u{E0041}b', zwsp: 'view\u200ber' }];
  const raw = JSON.stringify(rows);
  assert.ok(raw.includes('\u202e'), 'JSON.stringify leaves it alone — that is the problem');

  const safe = escapeInvisibles(raw);
  assert.doesNotMatch(safe, /[\u202e\u200b]/, 'no raw invisible characters survive');
  assert.match(safe, /\\u202e/);
  assert.match(safe, /\\udb40\\udc41/, 'both halves of the surrogate pair, or the value is lost');

  // Lossless: this is an escape, not a strip. Anything reading the output as
  // data gets exactly the value that was stored.
  assert.deepEqual(JSON.parse(safe), rows);
});

test('ordinary rows come back untouched', () => {
  const rows = [{ name: '神奈川県', city: 'Ångström — naïve', n: 42, nothing: null }];
  const raw = JSON.stringify(rows, null, 2);
  assert.equal(escapeInvisibles(raw), raw);
});
