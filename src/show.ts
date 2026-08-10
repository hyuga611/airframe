import { createHash } from 'node:crypto';
import { canonical } from './compare.js';

/**
 * Rendering a stored value for a person to read.
 *
 * One renderer, and only one. The confirmation card quotes values, and so does
 * every refusal that says "this was X when the plan was made and is Y now" —
 * which is a sentence somebody acts on. When those two are produced by different
 * code they drift, and the drift is discovered by someone deciding on the basis
 * of the one that was wrong. `apply.ts` carried its own copy for four releases:
 * it escaped nothing and cut strings at 60 characters with no way to tell two
 * long values apart, in the message whose entire job was to say which value had
 * moved.
 *
 * The rules here exist because the reader has no way to check the rendering
 * against the database. Whatever this prints is, for them, what is there.
 */

/**
 * Strip anything that lets a value rewrite the display around it.
 *
 * Every string on a card comes out of the database or out of the model, and both
 * reach a terminal, a chat client and a browser. Three separate powers have to be
 * taken away:
 *
 *  - **Control characters.** A newline lets a value forge the lines beneath it;
 *    an escape sequence can repaint or erase what is already on screen.
 *  - **Line and paragraph separators** (U+2028, U+2029). Newlines under another
 *    name in a browser, in JSON embedded in a script, and in several terminals.
 *  - **Format characters** (Unicode `Cf`), which is where the interesting ones
 *    live. U+202E RIGHT-TO-LEFT OVERRIDE reverses the rest of the line in any
 *    renderer implementing the bidirectional algorithm — every browser and chat
 *    client, and most terminals — so a stored value can invert the arrow and show
 *    a change running the other way. U+200B and U+FEFF are invisible, so two
 *    different values render as the same text. The tag characters at U+E0000
 *    carry entire hidden messages.
 *
 * Escaping U+200D costs something real: emoji sequences and correct Devanagari
 * and Persian text come out with a visible \u200d escape. That is the right side to
 * err on here. A name that reads awkwardly is a nuisance; a value that renders
 * as a different value is the failure this whole library is against.
 *
 * `Default_Ignorable_Code_Point` is the standard's own answer to "renders as
 * nothing", and it covers what a category check misses: U+3164 HANGUL FILLER is a
 * letter and U+E0041 is a tag, and both are invisible and both are caught here.
 *
 * It is still not everything, and the gap is the interesting part. U+2800 BRAILLE
 * PATTERN BLANK is a symbol that draws nothing, and the Cyrillic `а` is a
 * different character from the Latin `a` and the same picture. No escape rule
 * fixes those, because they are not invisible — they are ambiguous. That is why
 * {@link looksTheSame} exists and why the card checks the rendered pair rather
 * than trusting this function to have been exhaustive.
 */
export function inline(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]|\p{Cf}|\p{Default_Ignorable_Code_Point}/gu, (c) => {
    if (c === '\n') return '\\n';
    if (c === '\r') return '\\r';
    if (c === '\t') return '\\t';
    const cp = c.codePointAt(0) ?? 0;
    return cp <= 0xff ? `\\x${cp.toString(16).padStart(2, '0')}` : `\\u{${cp.toString(16)}}`;
  });
}

/**
 * Truncation has to be visible and has to be unambiguous.
 *
 * Cutting both sides of a diff at the same length renders `a…x` and `a…y` as the
 * same text, so a real change reads as `'aaa...' -> 'aaa...'` — no change at all,
 * on the line the reader is there to check. So a truncated value carries its full
 * length and a digest of the whole thing: two different values then differ on the
 * card even when their visible prefixes do not.
 */
const LIMIT = 80;

export function clip(s: string, what: string): string {
  if (s.length <= LIMIT) return s;
  const h = createHash('sha256').update(s).digest('hex').slice(0, 8);
  return `${s.slice(0, LIMIT - 3)}... (${what}, ${s.length} chars, sha256:${h})`;
}

function binary(b: Buffer): string {
  const h = createHash('sha256').update(b).digest('hex').slice(0, 8);
  return `<${b.length} bytes of binary, sha256:${h}>`;
}

/** How a single column value appears to a human, anywhere in this library. */
export function showValue(v: unknown): string {
  if (v === null || v === undefined) return '(empty)';
  if (typeof v === 'string') return `'${clip(inline(v), 'truncated')}'`;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(v)) return binary(v);
  // Not only Buffer: SQLite hands back a plain Uint8Array, so the same plan
  // rendered one card in the process that proposed it and a different one in the
  // process that approved it — `<3 bytes of binary>` in one and the decoded text
  // in the other, which for a BLOB is whatever bytes happen to look like.
  if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
    return binary(Buffer.from(v.buffer as ArrayBuffer, v.byteOffset, v.byteLength));
  }
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'object') return clip(inline(JSON.stringify(v) ?? String(v)), 'truncated');
  return clip(inline(String(v)), 'truncated');
}

/**
 * A short digest of what a value actually is, for the case where two of them
 * render the same.
 *
 * Taken over {@link canonical} rather than over the rendered text, because the
 * rendered text is the thing that has already failed to tell them apart.
 */
export function fingerprint(v: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(v)).digest('hex').slice(0, 8)}`;
}

/**
 * Would a reader take these two rendered values for the same text?
 *
 * Not "are they the same string" — that question is already answered by the
 * engine, which only puts a column in `changed` when the two differ. This asks
 * the question the reader is actually stuck with: after the font has had its way,
 * do these two lines look identical? Compatibility normalisation answers it for
 * the cases a normal form knows about — the ligature `ﬁ` against `fi`, fullwidth
 * against ASCII — on top of the escaping above, which has already made anything
 * invisible visible.
 *
 * What it does not answer: a Cyrillic `а` beside a Latin `a` is two characters
 * and one picture, and no normal form maps between them. Catching that needs the
 * confusables table, which is thousands of entries this package will not carry.
 * So this is a backstop, and the card says what it found rather than claiming
 * the pair is safe.
 */
export function looksTheSame(a: string, b: string): boolean {
  return a === b || a.normalize('NFKC') === b.normalize('NFKC');
}
