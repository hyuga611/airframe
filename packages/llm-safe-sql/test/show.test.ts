import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { clip, escapeInvisibles, fingerprint, inline, showValue } from '../src/show.js';

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

describe('showValue, one branch at a time', () => {
  /**
   * Every case below was found by mutation testing rather than by reading:
   * Stryker changed the line, ran the suite, and nothing went red. 74% of the
   * mutants in this file survived, and the ones that mattered were all of the
   * same kind — the type branches of the function that renders every value a
   * human is shown before approving it. `show.test.ts` had strings and
   * invisibles covered thoroughly and the other seven types not at all.
   */

  test('a string exactly at the limit is not truncated, and one character more is', () => {
    // The boundary itself: `s.length <= LIMIT` and `s.length < LIMIT` differ on
    // exactly one input, and nothing had ever supplied it.
    const at = 'a'.repeat(80);
    assert.equal(showValue(at), `'${at}'`);
    assert.equal(clip(at, 'truncated'), at);

    const over = 'a'.repeat(81);
    const clipped = clip(over, 'truncated');
    assert.notEqual(clipped, over);
    assert.match(clipped, /^a{77}\.\.\. \(truncated, 81 chars, sha256:[0-9a-f]{8}\)$/);
  });

  test('the visible prefix is short enough to leave room for the marker', () => {
    // `LIMIT - 3` became `LIMIT + 3` and no test noticed, which means nothing
    // measured how much of the value survives truncation.
    const clipped = clip('b'.repeat(500), 'truncated');
    assert.equal(clipped.indexOf('...'), 77);
    assert.equal(clipped.slice(0, 77), 'b'.repeat(77));
  });

  test('the digest is short, and it is of the whole value rather than the visible part', () => {
    const a = `${'c'.repeat(200)}X`;
    const b = `${'c'.repeat(200)}Y`;
    const [ca, cb] = [clip(a, 'truncated'), clip(b, 'truncated')];
    assert.notEqual(ca, cb, 'two values with the same visible prefix must not render alike');
    assert.match(ca, /sha256:[0-9a-f]{8}\)/);
    assert.equal(/sha256:([0-9a-f]+)\)/.exec(ca)?.[1]?.length, 8);
  });

  test('a Buffer is described, never decoded', () => {
    const s = showValue(Buffer.from([0x00, 0x01, 0x02]));
    assert.match(s, /^<3 bytes of binary, sha256:[0-9a-f]{8}>$/);
    assert.notEqual(showValue(Buffer.from([1, 2, 3])), showValue(Buffer.from([1, 2, 4])));
  });

  test('a Uint8Array is described the same way a Buffer is', () => {
    // The reason this branch exists: SQLite hands back a plain Uint8Array, so the
    // same plan rendered one card in the process that proposed it and a different
    // one in the process that approved it. Nothing tested it.
    assert.equal(showValue(new Uint8Array([0x00, 0x01, 0x02])), showValue(Buffer.from([0x00, 0x01, 0x02])));
    assert.match(showValue(new Uint8Array([9])), /^<1 bytes of binary, sha256:[0-9a-f]{8}>$/);
  });

  test('a view of part of a buffer describes that part, not the whole buffer', () => {
    const backing = Uint8Array.from([1, 2, 3, 4, 5, 6]);
    const window = new Uint8Array(backing.buffer, 2, 3);
    assert.equal(showValue(window), showValue(Buffer.from([3, 4, 5])));
  });

  test('a DataView is not treated as bytes', () => {
    // `!(v instanceof DataView)` was mutated to `v instanceof DataView` and the
    // suite stayed green in both directions.
    const s = showValue(new DataView(new ArrayBuffer(4)));
    assert.ok(!s.startsWith('<'), `a DataView should not render as binary, got ${s}`);
  });

  test('a Date is an instant, not whatever the locale would print', () => {
    assert.equal(showValue(new Date(Date.UTC(2026, 7, 11, 12, 0, 0))), '2026-08-11T12:00:00.000Z');
  });

  test('a bigint keeps every digit', () => {
    assert.equal(showValue(9007199254740993n), '9007199254740993');
    assert.equal(showValue(0n), '0');
  });

  test('an object is rendered as JSON, and a long one is truncated like any other value', () => {
    assert.equal(showValue({ a: 1, b: 'x' }), '{"a":1,"b":"x"}');
    assert.equal(showValue([1, 2, 3]), '[1,2,3]');
    assert.match(showValue({ k: 'z'.repeat(200) }), /\.\.\. \(truncated, \d+ chars, sha256:[0-9a-f]{8}\)$/);
  });

  test('numbers and booleans fall through to the last line, and are not quoted', () => {
    assert.equal(showValue(7), '7');
    assert.equal(showValue(-0.5), '-0.5');
    assert.equal(showValue(true), 'true');
    assert.equal(showValue(false), 'false');
    assert.equal(showValue(Number.NaN), 'NaN');
  });

  test('a string is quoted and the others are not, which is how a reader tells 7 from "7"', () => {
    assert.equal(showValue('7'), "'7'");
    assert.equal(showValue(7), '7');
    assert.notEqual(showValue('7'), showValue(7));
  });
});

describe('the last three the mutation run could still break', () => {
  /**
   * A second pass over `show.ts` took it from 74% to 89%, and twelve mutants
   * survived. Nine of them are equivalent — changing the line cannot change the
   * output — and chasing those would mean writing tests that assert nothing.
   * Dropping `typeof v === 'bigint'` is the clearest: the value falls through to
   * `String(v)` on the last line and renders identically, so no input
   * distinguishes the two programs.
   *
   * These three are not equivalent. They were the rest.
   */

  test('an escape is padded to four hex digits, so it is still valid JSON', () => {
    // `padStart(4, '0')` became `padStart(4, '')` and nothing noticed, because
    // every invisible in this file's other tests has a code point above 0x0fff.
    // Below that the escape comes out as \u7 — which JSON.parse rejects, on the
    // one path whose entire job is to hand back something a reader can parse.
    const raw = JSON.stringify({ note: 'a\u0007b' });
    const safe = escapeInvisibles(raw);
    assert.ok(safe.includes(String.fromCharCode(92) + 'u0007'), `expected a four-digit escape, got ${safe}`);
    assert.deepEqual(JSON.parse(safe), JSON.parse(raw), 'and it still parses back to the same value');
  });

  test('a fingerprint is short enough to read and long enough to differ', () => {
    // `.slice(0, 8)` could be dropped and every test stayed green: nothing had
    // ever asserted the shape of the digest the card prints beside two values
    // that render alike.
    const f = fingerprint('a'.repeat(300));
    assert.match(f, /^sha256:[0-9a-f]{8}$/);
    assert.notEqual(fingerprint('x'), fingerprint('y'));
    assert.equal(fingerprint('x'), fingerprint('x'));
  });

  test('a long string says it was truncated, in those words', () => {
    // The label is what tells a reader the rest of the value exists. It could be
    // replaced with an empty string undetected.
    const s = showValue('z'.repeat(200));
    assert.match(s, /\(truncated, 200 chars, sha256:[0-9a-f]{8}\)'$/);
  });
});
