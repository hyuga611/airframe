/**
 * Turning two versions of a file into the lines that changed.
 *
 * This is the only part of habit that is pure: text in, changed lines out, no disk and no store.
 * Keeping it that way is why the caps live here as arguments rather than as a peek at the
 * configuration — everything about what is kept is decided by the caller.
 */
import { MAX_LINES, MAX_LINE } from './store.mjs';

// ---------------- diffing ----------------

/** A plain line diff. Set difference rather than LCS — enough granularity, and no dependency. */
export function lineDiff(before, after) {
  const b = before.split(/\r?\n/);
  const a = after.split(/\r?\n/);
  const bSet = new Map();
  for (const l of b) bSet.set(l, (bSet.get(l) || 0) + 1);
  const aSet = new Map();
  for (const l of a) aSet.set(l, (aSet.get(l) || 0) + 1);

  const removed = [];
  for (const [l, n] of bSet) {
    const keep = n - (aSet.get(l) || 0);
    for (let i = 0; i < keep; i++) if (l.trim()) removed.push(l);
  }
  const added = [];
  for (const [l, n] of aSet) {
    const keep = n - (bSet.get(l) || 0);
    for (let i = 0; i < keep; i++) if (l.trim()) added.push(l);
  }
  return { removed, added };
}

/**
 * Cut a diff down to what a correction is allowed to keep.
 *
 * Every path that *displays* a line has capped its length for a long time — 160 characters in
 * `formatDiff`, 200 in the corpus — while the path that *stores* one capped only how many.
 * One edit to a minified bundle is a single line of half a megabyte, and corrections are never
 * pruned, so it stayed forever. Nothing downstream ever reads past this, so nothing is lost
 * that was being used, and markers stay comparable because past and future lines are cut the
 * same way.
 */
export function storableLines(lines) {
  return lines.slice(0, MAX_LINES).map((l) => l.slice(0, MAX_LINE));
}

export function formatDiff({ removed, added }, limit = 12) {
  const out = [];
  for (const l of removed.slice(0, limit)) out.push('- ' + l.trim().slice(0, 160));
  if (removed.length > limit) out.push(`  … and ${removed.length - limit} more removed`);
  for (const l of added.slice(0, limit)) out.push('+ ' + l.trim().slice(0, 160));
  if (added.length > limit) out.push(`  … and ${added.length - limit} more added`);
  return out.join('\n');
}
