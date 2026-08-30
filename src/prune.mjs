/**
 * habit prune — drop the stored bodies that can no longer earn their keep.
 *
 * `artifacts/` holds the full text of every distinct file the agent has ever written, keyed by
 * a hash of the path, and nothing has ever deleted one. Finish a project, delete the file,
 * rename it — the body stays, forever, in a user-global directory. On a machine that works
 * across many clients that is the one part of habit that quietly accumulates other people's
 * source code.
 *
 * A body exists for exactly one purpose: to diff against the *next* write of that same file.
 * So a body whose file is gone can never be used again, and one untouched for a month almost
 * certainly will not be. Both are dropped; **the hash and the metadata stay**, so detection is
 * untouched — the next write to that path is still noticed, it just reports "the contents were
 * not kept, read the file before writing over it", which is a path the code already has.
 *
 * Nothing is removed on a schedule and nothing runs this on its own. It is a command, it
 * defaults to a dry run, and it prints what it would drop before it drops anything.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { artifactsDir } from './habit.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Decide what to drop, and drop it only when asked.
 *
 * @param {object}  opts
 * @param {number}  opts.days   bodies untouched for longer than this are stale (default 30)
 * @param {number}  opts.now    epoch ms, injectable so the tests do not depend on the clock
 * @param {boolean} opts.apply  false (default) reports; true rewrites the records
 */
export function prune({ days = 30, now = Date.now(), apply = false } = {}) {
  const dir = artifactsDir();
  const out = { scanned: 0, gone: [], stale: [], keptWithBody: 0, alreadyBare: 0, freed: 0, applied: apply };
  if (!existsSync(dir)) return out;

  const cutoff = now - days * DAY_MS;

  for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    const full = join(dir, f);
    let rec;
    try {
      rec = JSON.parse(readFileSync(full, 'utf8'));
    } catch {
      continue; // an unreadable record is not something to start deleting over
    }
    out.scanned += 1;

    if (rec.text == null) {
      out.alreadyBare += 1;
      continue;
    }

    const missing = !rec.file || !existsSync(rec.file);
    const written = Date.parse(rec.writtenAt || '');
    const stale = Number.isFinite(written) && written < cutoff;

    if (!missing && !stale) {
      out.keptWithBody += 1;
      continue;
    }

    const bytes = Buffer.byteLength(rec.text);
    out.freed += bytes;
    const row = { file: basename(rec.file || f), bytes, writtenAt: rec.writtenAt || null };
    (missing ? out.gone : out.stale).push(row);

    if (apply) {
      // The hash is what detection runs on, so it stays. Only the body goes.
      writeFileSync(full, JSON.stringify({
        ...rec,
        text: null,
        withheld: missing ? 'pruned-gone' : 'pruned-stale',
        prunedAt: new Date(now).toISOString(),
      }), 'utf8');
    }
  }

  return out;
}

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;

export function report(r, { days }) {
  const lines = [];
  const total = r.gone.length + r.stale.length;

  lines.push(`habit: ${r.scanned} artifact(s) — ${r.keptWithBody} keep their body, ${r.alreadyBare} already have none`);
  if (!total) {
    lines.push('Nothing to prune. Every stored body is for a file that still exists and was written recently.');
    return lines.join('\n');
  }

  lines.push(`${total} body/bodies can go, freeing ${kb(r.freed)}. The hash stays on all of them, so edits are still detected.`);
  if (r.gone.length) {
    lines.push(`\n  the file no longer exists (${r.gone.length}):`);
    for (const g of r.gone.slice(0, 12)) lines.push(`    ${g.file.padEnd(34)} ${kb(g.bytes)}`);
    if (r.gone.length > 12) lines.push(`    … and ${r.gone.length - 12} more`);
  }
  if (r.stale.length) {
    lines.push(`\n  untouched for over ${days} days (${r.stale.length}):`);
    for (const s of r.stale.slice(0, 12)) lines.push(`    ${s.file.padEnd(34)} ${kb(s.bytes)}  last written ${String(s.writtenAt).slice(0, 10)}`);
    if (r.stale.length > 12) lines.push(`    … and ${r.stale.length - 12} more`);
  }

  lines.push(r.applied
    ? '\nDone. Those records now say the contents were not kept; the next write to each path reads the file first.'
    : '\nNothing was changed. Run again with --apply to drop them.');
  return lines.join('\n');
}
