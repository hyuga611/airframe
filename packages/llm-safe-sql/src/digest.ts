import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
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
 * (P5), that applying needs a credential the model does not have, and — where an
 * operator configures one — the keyed seal below, which the store credential
 * alone cannot produce.
 *
 * "Exactly what a human approved" has to mean the whole card, and until 0.4.0 it
 * did not. `impact` and `warnings` were left out, and those are the two fields a
 * non-engineer actually reads: `impact` is the sentence the policy calls "the
 * rule that keeps human approval real" — *changing the ship date moves which
 * month this supplier gets paid in* — and `warnings` is where an adapter's
 * unenforceable limits are surfaced. Editing either in the stored row changed
 * what the next person was shown while the digest still verified. A tamper check
 * that covers the numbers and not the sentence explaining them protects the part
 * nobody was going to be misled by.
 */
function planParts(plan: Plan): string[] {
  const parts: string[] = [
    // v2 added impact and warnings; v3 added the covered-column snapshot; v4 added
    // the trigger baseline. Plans stored by an older version no longer verify,
    // which is the correct direction to fail: a plan whose covered surface is
    // smaller than this version believes is a plan this version cannot vouch for.
    'llm-safe-sql/plan/v4',
    plan.dialect,
    plan.op,
    plan.table,
    plan.sql,
    String(plan.rowsMatched),
    String(plan.rowsChanged),
    String(plan.rowsChangedIsMeaningful),
    plan.impact,
    // Printed on the card as "across N columns: a, b", and read back from the
    // stored body verbatim rather than re-derived, so it was editable without
    // breaking the checksum.
    String(plan.columnsTouched.length),
    ...[...plan.columnsTouched].sort(),
    // Order is meaningful here — it is the order they are printed in.
    String(plan.warnings.length),
    ...plan.warnings,
    // How many triggers the table had when this was measured. Not on the card, and
    // load-bearing twice in the apply: it is the baseline the SCHEMA_CHANGED check
    // compares a fresh introspect against, and — because a count is not a
    // definition — it is also what decides whether the apply counts the whole
    // table on both sides to catch a trigger that was swapped for a different one.
    // Left out of the digest until 0.9.0, so editing it in the stored body turned
    // that second guard off silently: set to zero, an apply against a triggered
    // table stopped watching for the rows a trigger moves, and the check that
    // would have said so had been rewritten to agree.
    'trig',
    plan.triggerCount === undefined ? 'absent' : String(plan.triggerCount),
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
    // And every column the statement writes, which is a wider set: a column
    // assigned its own current value is not in `changed` and is still written.
    // The apply verifies these before and after, so a stored plan with one of
    // them removed would have that column written unchecked.
    for (const c of [...r.covered].sort()) {
      parts.push('cov', c, canonical(r.before[c]), canonical(r.after[c]));
    }
  }
  return parts;
}

/**
 * Length-prefixed rather than joined by a separator: any separator can also occur
 * inside a value, and two different plans that differ only in where a separator
 * falls would otherwise hash the same.
 */
function absorb(update: (s: string) => void, parts: readonly string[]): void {
  for (const p of parts) update(`${p.length}:${p}`);
}

export function planDigest(plan: Plan): string {
  const h = createHash('sha256');
  absorb((s) => void h.update(s), planParts(plan));
  return h.digest('hex');
}

/** What a seal is bound to, beyond the plan's own content. */
export interface SealContext {
  /** The row the plan lives in. Without it a sealed body can be copied to a second row. */
  readonly id: string;
  /** Who proposed it. Without it the name that decides SELF_APPROVAL is editable. */
  readonly createdBy: string;
}

/**
 * The same bytes, keyed.
 *
 * `planDigest` answers "has this record changed since it was written", which is
 * the right question for a partial write or a well-meaning edit and the wrong one
 * for an adversary: the function is public, so anyone who can write the plan table
 * can write a different plan and the checksum that matches it. That is not a
 * hypothetical — it is one `UPDATE` against a table this library's own store
 * account holds write on, and every message printed afterwards still says
 * "approved".
 *
 * The seal is an HMAC over the identical parts, so a party holding the store
 * credential and nothing else can no longer produce a record that verifies. The
 * key belongs to the planning and applying processes; it must not be reachable
 * from the store credential, or this is decoration.
 *
 * Two things it deliberately does not do, both pinned in `test/seal.test.ts`:
 *
 *  * **It does not defend against a compromised planning process.** That process
 *    mints seals, so it can seal anything. Symmetric or asymmetric makes no
 *    difference to this: whoever measures the plan is trusted to measure honestly.
 *  * **It does not cover `status` or `approved_by`.** Those change legitimately
 *    after the plan seal is minted, so they are sealed separately, when the
 *    approval happens — see {@link approvalSeal}. This function covers what the
 *    plan says; that one covers whether anybody agreed to it.
 */
export function planSeal(plan: Plan, ctx: SealContext, key: string): string {
  const h = createHmac('sha256', key);
  absorb((s) => void h.update(s), [
    'llm-safe-sql/seal/v1',
    ctx.id,
    ctx.createdBy,
    ...planParts(plan),
  ]);
  return h.digest('hex');
}

/** What an approval seal is bound to. */
export interface ApprovalContext {
  /** The row the approval belongs to. */
  readonly id: string;
  /** The plan's own seal, so an approval cannot be lifted onto a different plan. */
  readonly planSeal: string;
  /** The name recorded as having approved it — the field the whole seal exists to protect. */
  readonly approvedBy: string;
}

/**
 * The other half: proof that the approval itself happened.
 *
 * Sealing the plan stops the store credential changing *what* gets written, and
 * leaves it able to change *whether anybody agreed to it*. `status` and
 * `approved_by` are two ordinary columns; setting them to `'approved'` and a
 * plausible name is one `UPDATE`, and the apply then commits a measured,
 * correctly sealed plan that no human ever read. For a library whose entire
 * subject is the gap between "the model proposed this" and "a person agreed to
 * it", that is the more embarrassing of the two holes, and it was open until
 * 0.9.0.
 *
 * Bound to the plan's own seal rather than to its id alone, so an approval cannot
 * be lifted from one plan onto another, and so re-sealing the plan invalidates
 * every approval of the version it replaced.
 *
 * The one thing it does not stop is a status rollback: `applied` set back to
 * `approved` replays a genuine approval, and this seal still verifies because
 * nothing about it is false. That replay is caught a layer down instead — the
 * rows now hold the values the plan calls `after`, so the pre-apply comparison
 * refuses with `ROW_CHANGED`, and a re-run `DELETE` refuses with `ROWS_MOVED`.
 * Sealing a monotonic status chain would be the general answer and is out of
 * proportion to what it adds over a measurement that already refuses.
 */
export function approvalSeal(ctx: ApprovalContext, key: string): string {
  const h = createHmac('sha256', key);
  absorb((s) => void h.update(s), [
    'llm-safe-sql/approval/v1',
    ctx.id,
    ctx.planSeal,
    ctx.approvedBy,
  ]);
  return h.digest('hex');
}

/**
 * Compare two seals without leaking where they first differ.
 *
 * `===` on a hex string returns as soon as it finds a mismatched character, which
 * over enough attempts is a way to learn a valid seal one character at a time.
 * The threat is thin here — an attacker who can write the plan table can also read
 * the seal — but the cost of doing it properly is one function, and the habit is
 * worth more than the reasoning that would justify skipping it.
 */
export function sealMatches(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on a length mismatch, which is itself the comparison
  // for hex strings of a fixed width.
  return x.length === y.length && timingSafeEqual(x, y);
}
