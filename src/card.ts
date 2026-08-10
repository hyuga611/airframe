import type { Plan, PlanRow } from './engine.js';
import type { StoredPlan } from './store.js';
import { fingerprint, inline, looksTheSame, showValue } from './show.js';

/**
 * The confirmation card.
 *
 * There is exactly one renderer, used by every surface — the model's tool output,
 * the CLI, anything built on top. That is on purpose: if the text the assistant
 * relays and the text the approver reads are produced by different code, they
 * will eventually disagree, and the disagreement will be discovered by someone
 * approving a change they did not understand. The rendering of a single value
 * lives in `show.ts` for the same reason, and is shared with the refusals that
 * quote values back.
 *
 * The card leads with what is at stake in words, not with SQL. Someone who can
 * read SQL will read it anyway; someone who cannot is exactly the person whose
 * approval must still mean something.
 */

const ARROW = ' -> ';

function keyText(row: PlanRow): string {
  return Object.entries(row.key)
    .map(([k, v]) => `${k} = ${showValue(v)}`)
    .join(', ');
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * One line of the diff, and the check that the line is worth reading.
 *
 * Every column reaching this function was measured as changed, so the two sides
 * are two different stored values. If they arrive at the reader as the same text,
 * the line says "nothing happened" about something that did, on the one line they
 * are there to check.
 *
 * Escaping removes the invisible characters, and cannot remove the ambiguous
 * ones — `а` and `a` are two characters and one picture. So this does not trust
 * the escaping to have been exhaustive. It looks at the pair it is about to print
 * and, when the two would read the same, prints a digest of each value: the same
 * device `clip` in `show.ts` uses when truncation makes two values collide.
 */
function diffLine(col: string, before: unknown, after: unknown): { line: string; ambiguous: boolean } {
  const b = showValue(before);
  const a = showValue(after);
  if (!looksTheSame(b, a)) return { line: `      ${col}: ${b}${ARROW}${a}`, ambiguous: false };
  return {
    line: `      ${col}: ${b} (${fingerprint(before)})${ARROW}${a} (${fingerprint(after)})`,
    ambiguous: true,
  };
}

/** The body of the card: what changes, row by row, as measured. */
export function planBody(plan: Plan): string {
  const out: string[] = [];
  // The statement is the model's text. It has been normalised — comments removed,
  // one statement only — but nothing has stopped it containing a newline, and a
  // newline here lets it draw the lines below it: a complete second card, with
  // its own row list and its own harmless-looking diff, above the real one.
  out.push(`  ${inline(plan.sql)}`);
  out.push('');
  out.push('What this touches');
  out.push(`  ${plan.table} — ${plan.impact}`);

  let ambiguous = false;

  if (plan.op === 'DELETE') {
    out.push(`  ${plural(plan.rows.length, 'row')} would be deleted outright.`);
    out.push('');
    out.push('The rows, as they are now');
    for (const r of plan.rows) {
      out.push(`  ${keyText(r)}`);
      const shown = r.changed.filter((c) => r.before[c] !== null && r.before[c] !== undefined);
      const empty = r.changed.length - shown.length;
      for (const c of shown) out.push(`      ${c}: ${showValue(r.before[c])}`);
      if (empty > 0) out.push(`      (${plural(empty, 'other column')}, all empty)`);
    }
  } else {
    const changing = plan.rows.filter((r) => r.changed.length > 0);
    out.push(
      `  ${plural(changing.length, 'row')} would change, ` +
        `across ${plural(plan.columnsTouched.length, 'column')}: ${plan.columnsTouched.join(', ')}`,
    );
    if (changing.length !== plan.rows.length) {
      out.push(`  (${plan.rows.length - changing.length} more match the condition but are already correct.)`);
    }
    out.push('');
    out.push('Measured by running the statement and rolling it back');
    for (const r of changing) {
      out.push(`  ${keyText(r)}`);
      for (const c of r.changed) {
        const { line, ambiguous: same } = diffLine(c, r.before[c], r.after[c]);
        out.push(line);
        if (same) ambiguous = true;
      }
    }
  }

  if (ambiguous) {
    out.push('');
    out.push(
      '  Note: a line above shows the same text on both sides. Those two values are ' +
        'different in the database — the digests are how you tell them apart. A value ' +
        'that reads as no change and is one is worth understanding before you approve.',
    );
  }

  if (plan.warnings.length > 0) {
    out.push('');
    out.push('Before you approve');
    for (const w of plan.warnings) out.push(`  - ${w}`);
  }
  return out.join('\n');
}

/** The full card, including the plan's identity and how to act on it. */
export function planCard(rec: StoredPlan, opts: { cli?: string } = {}): string {
  const cli = opts.cli ?? 'llm-safe-sql';
  const head =
    rec.status === 'pending'
      ? `Plan ${rec.id} — proposed, not applied. Nothing in the database has changed.`
      : `Plan ${rec.id} — ${rec.status}.`;

  const foot: string[] = [];
  if (rec.status === 'pending') {
    foot.push('', 'This needs a person. Neither the assistant nor this tool can approve it:');
    foot.push(`  ${cli} approve ${rec.id} --as you@example.com`);
    foot.push(`  ${cli} apply ${rec.id} --as you@example.com`);
  } else if (rec.status === 'approved') {
    foot.push('', `Approved by ${rec.approvedBy ?? 'unknown'}. Not yet applied:`);
    foot.push(`  ${cli} apply ${rec.id} --as you@example.com`);
  }

  return [head, '', planBody(rec.plan), ...foot].join('\n');
}
