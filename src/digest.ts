import { createHash } from 'node:crypto';
import { canonical } from './compare.js';
import type { Plan } from './engine.js';

/**
 * A fingerprint of exactly what a human approved.
 *
 * Between planning and applying, the plan lives in a table. The threat is not
 * only a malicious edit: a well-meaning operator can "fix" a value in the plan
 * row, and a partially written record can be read back as a plan that looks
 * complete. Either way the apply would proceed against something nobody agreed
 * to, while every message on screen still says "approved".
 *
 * So the digest covers the statement *and* the measured before/after values, and
 * it is checked before approval and again before applying. It is a tamper check,
 * not a security boundary — anyone who can write the plan table can recompute it.
 * The boundary is that the plan table is refused to callers of this library
 * (P5), and that applying needs a credential the model does not have.
 */
export function planDigest(plan: Plan): string {
  const parts: string[] = [
    'llm-safe-sql/plan/v1',
    plan.dialect,
    plan.op,
    plan.table,
    plan.sql,
    String(plan.rowsMatched),
    String(plan.rowsChanged),
    String(plan.rowsChangedIsMeaningful),
  ];

  for (const r of plan.rows) {
    parts.push('row');
    for (const k of Object.keys(r.key).sort()) {
      parts.push('key', k, canonical(r.key[k]));
    }
    // Sorted, because the display order of columns is not part of what was
    // agreed; the values are.
    for (const c of [...r.changed].sort()) {
      parts.push('col', c, canonical(r.before[c]), canonical(r.after[c]));
    }
  }

  // Length-prefixed rather than joined by a separator: any separator can also
  // occur inside a value, and two different plans that differ only in where a
  // separator falls would otherwise hash the same.
  const h = createHash('sha256');
  for (const p of parts) h.update(`${p.length}:${p}`);
  return h.digest('hex');
}
