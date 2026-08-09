import type { Plan, PlanRow } from './engine.js';
import type { StoredPlan } from './store.js';

/**
 * The confirmation card.
 *
 * There is exactly one renderer, used by every surface — the model's tool output,
 * the CLI, anything built on top. That is on purpose: if the text the assistant
 * relays and the text the approver reads are produced by different code, they
 * will eventually disagree, and the disagreement will be discovered by someone
 * approving a change they did not understand.
 *
 * The card leads with what is at stake in words, not with SQL. Someone who can
 * read SQL will read it anyway; someone who cannot is exactly the person whose
 * approval must still mean something.
 */

const ARROW = ' -> ';

function value(v: unknown): string {
  if (v === null || v === undefined) return '(empty)';
  if (typeof v === 'string') return v.length > 80 ? `'${v.slice(0, 77)}...'` : `'${v}'`;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(v)) return `<${v.length} bytes of binary>`;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    const s = JSON.stringify(v);
    return s.length > 80 ? `${s.slice(0, 77)}...` : s;
  }
  return String(v);
}

function keyText(row: PlanRow): string {
  return Object.entries(row.key)
    .map(([k, v]) => `${k} = ${value(v)}`)
    .join(', ');
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The body of the card: what changes, row by row, as measured. */
export function planBody(plan: Plan): string {
  const out: string[] = [];
  out.push(`  ${plan.sql}`);
  out.push('');
  out.push('What this touches');
  out.push(`  ${plan.table} — ${plan.impact}`);

  if (plan.op === 'DELETE') {
    out.push(`  ${plural(plan.rows.length, 'row')} would be deleted outright.`);
    out.push('');
    out.push('The rows, as they are now');
    for (const r of plan.rows) {
      out.push(`  ${keyText(r)}`);
      const shown = r.changed.filter((c) => r.before[c] !== null && r.before[c] !== undefined);
      const empty = r.changed.length - shown.length;
      for (const c of shown) out.push(`      ${c}: ${value(r.before[c])}`);
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
        out.push(`      ${c}: ${value(r.before[c])}${ARROW}${value(r.after[c])}`);
      }
    }
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
