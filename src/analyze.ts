import type { Token } from './lexer.js';
import { lower } from './statement.js';

/**
 * Shape checks on a write statement.
 *
 * Each of these was found by adversarial review of an earlier version that
 * accepted the statement and produced a plan describing something other than what
 * would happen. They are not stylistic restrictions: every one of them is a case
 * where the confirmation card and the database disagree.
 */

function significant(tokens: readonly Token[]): Token[] {
  return tokens.filter((t) => t.kind !== 'ws' && t.kind !== 'comment');
}

/** Keywords after which the next name is a table, not a clause. */
const TABLE_LEAD = new Set(['from', 'join', 'update']);

/** Bare keywords appearing outside any parentheses — i.e. in the statement itself. */
export function topLevelWords(tokens: readonly Token[]): Set<string> {
  const out = new Set<string>();
  let depth = 0;
  for (const t of significant(tokens)) {
    if (t.kind === 'punct') {
      if (t.value === '(') depth++;
      else if (t.value === ')') depth--;
      continue;
    }
    if (depth === 0 && t.kind === 'ident') out.add(lower(t.value));
  }
  return out;
}

/**
 * True when the statement writes to more than one table.
 *
 * Both engines have a multi-table write syntax that reads like a single-table
 * one: `UPDATE a, b SET ...` and MySQL's `DELETE a FROM a JOIN b`. A planner that
 * only inspects the first table name shows the human one table's rows while the
 * statement modifies another table entirely.
 */
export function isMultiTableWrite(tokens: readonly Token[]): boolean {
  const toks = significant(tokens);
  const first = toks[0];
  if (first === undefined || first.kind !== 'ident') return false;
  const lead = lower(first.value);

  if (lead === 'update') {
    // Anything before SET is the table list. A comma there means several tables.
    let depth = 0;
    for (let i = 1; i < toks.length; i++) {
      const t = toks[i];
      if (t === undefined) continue;
      if (t.kind === 'punct') {
        if (t.value === '(') depth++;
        else if (t.value === ')') depth--;
        else if (t.value === ',' && depth === 0) return true;
        continue;
      }
      if (depth === 0 && t.kind === 'ident' && lower(t.value) === 'set') return false;
    }
    return false;
  }

  if (lead === 'delete') {
    // The single-table form is `DELETE FROM t`. `DELETE a FROM ...` and
    // `DELETE FROM a, b` are the multi-table forms.
    const second = toks[1];
    if (second === undefined) return false;
    if (!(second.kind === 'ident' && lower(second.value) === 'from')) return true;
    let depth = 0;
    for (let i = 2; i < toks.length; i++) {
      const t = toks[i];
      if (t === undefined) continue;
      if (t.kind === 'punct') {
        if (t.value === '(') depth++;
        else if (t.value === ')') depth--;
        else if (t.value === ',' && depth === 0) return true;
        continue;
      }
      if (depth === 0 && t.kind === 'ident' && lower(t.value) === 'where') return false;
    }
  }

  return false;
}

/**
 * The alias given to the target table, if the author gave it one.
 *
 * `UPDATE orders o SET ... WHERE o.id = 1` is ordinary SQL and an assistant will
 * write it. The engine builds its own `SELECT COUNT(*) FROM orders WHERE o.id = 1`
 * from the same condition text, which the server answers with `missing FROM-clause
 * entry for table "o"` — an error about a table the operator never mentioned,
 * arriving from a tool that was supposed to be explaining things to them.
 *
 * Supporting the alias would mean carrying it through the count, the snapshot and
 * the post-apply read; getting that wrong anywhere means measuring one row set
 * and writing another. Refusing costs the author one edit and says so.
 */
export function targetAlias(tokens: readonly Token[]): string | undefined {
  const toks = significant(tokens);
  const first = toks[0];
  if (first === undefined || first.kind !== 'ident') return undefined;
  const lead = lower(first.value);

  let i: number;
  let stop: Set<string>;
  if (lead === 'update') {
    i = 1;
    stop = new Set(['set']);
  } else if (lead === 'delete') {
    const second = toks[1];
    if (second === undefined || second.kind !== 'ident' || lower(second.value) !== 'from') return undefined;
    i = 2;
    stop = new Set(['where', 'using', 'returning']);
  } else {
    return undefined;
  }

  // Step over the (possibly schema-qualified) table name.
  if (toks[i]?.kind !== 'ident' && toks[i]?.kind !== 'quotedIdent') return undefined;
  i++;
  while (toks[i]?.kind === 'punct' && toks[i]?.value === '.') i += 2;

  let next = toks[i];
  if (next?.kind === 'ident' && lower(next.value) === 'as') {
    next = toks[i + 1];
  }
  if (next === undefined) return undefined;
  if (next.kind !== 'ident' && next.kind !== 'quotedIdent') return undefined;
  if (next.kind === 'ident' && stop.has(lower(next.value))) return undefined;
  return next.value;
}

/**
 * Functions whose value changes between evaluations.
 *
 * The engine reads the target rows, executes, reads them again, and later applies
 * the same statement for real. A volatile function makes those four evaluations
 * disagree: `WHERE random() < 0.5` selects different rows each time, so the rows
 * shown are provably not the rows changed, and `SET updated_at = now()` writes a
 * value the human was never shown.
 *
 * Both are refused with an instruction to pass a literal instead, because the
 * alternative is a confirmation that does not mean what it says.
 */
const VOLATILE = new Set([
  'rand', 'random', 'uuid', 'uuid_short', 'gen_random_uuid', 'newid',
  'now', 'sysdate', 'curdate', 'curtime', 'current_timestamp', 'current_date',
  'current_time', 'localtime', 'localtimestamp', 'unix_timestamp', 'utc_timestamp',
  'utc_date', 'utc_time', 'clock_timestamp', 'statement_timestamp', 'transaction_timestamp',
  'timeofday', 'nextval', 'lastval', 'currval', 'last_insert_id', 'connection_id',
  'found_rows', 'row_count',
]);

/**
 * SQLite's date functions, which are volatile only when handed `'now'`.
 *
 * `date(created_at)` is deterministic and ordinary; `date('now')` is not. Putting
 * these in VOLATILE outright would refuse the first kind too, so the argument has
 * to be looked at. Without this, `SET status = strftime('%Y-%m-%d','now')` reached
 * planning and was caught only after the write by the result comparison — a
 * refusal that arrives after the fact reads as a bug in the tool, not as a bad
 * statement.
 */
const VOLATILE_WITH_NOW = new Set(['strftime', 'datetime', 'date', 'time', 'julianday', 'unixepoch']);

/** True if the call starting at `open` passes a `'now'` string literal. */
function callTakesNow(toks: readonly Token[], open: number): boolean {
  let depth = 0;
  for (let i = open; i < toks.length; i++) {
    const t = toks[i];
    if (t === undefined) continue;
    if (t.kind === 'punct' && t.value === '(') depth++;
    else if (t.kind === 'punct' && t.value === ')') {
      depth--;
      if (depth === 0) return false;
    } else if (t.kind === 'string' && lower(t.value).trim() === 'now') return true;
  }
  return false;
}

/** Volatile function names used by this statement, in the order they appear. */
export function volatileCalls(tokens: readonly Token[]): string[] {
  const out: string[] = [];
  const toks = significant(tokens);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === undefined || t.kind !== 'ident') continue;
    const name = lower(t.value);
    if (VOLATILE_WITH_NOW.has(name)) {
      const open = toks[i + 1];
      if (open?.kind === 'punct' && open.value === '(' && callTakesNow(toks, i + 1)) out.push(name);
      continue;
    }
    if (!VOLATILE.has(name)) continue;
    // `CURRENT_TIMESTAMP` is legal with or without parentheses; the others need
    // them, and a column happening to be called "now" is not a call.
    const next = toks[i + 1];
    const called = next?.kind === 'punct' && next.value === '(';
    const bareKeyword =
      name === 'current_timestamp' || name === 'current_date' || name === 'current_time' ||
      name === 'localtime' || name === 'localtimestamp' || name === 'sysdate';
    if (called || bareKeyword) out.push(name);
  }
  return out;
}

/**
 * Clause detectors that look at position, not at the mere presence of a word.
 *
 * `UPDATE order SET ...` targets a table called "order"; `UPDATE t SET ... ORDER
 * BY x` is the construct we refuse. Matching the bare word rejects the first one
 * too, and a refusal that names the wrong problem is worse than no refusal — the
 * operator changes something unrelated and tries again.
 */
export function hasTopLevelOrderBy(tokens: readonly Token[]): boolean {
  const toks = significant(tokens);
  let depth = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === undefined) continue;
    if (t.kind === 'punct') {
      if (t.value === '(') depth++;
      else if (t.value === ')') depth--;
      continue;
    }
    const next = toks[i + 1];
    if (
      depth === 0 &&
      t.kind === 'ident' &&
      lower(t.value) === 'order' &&
      next?.kind === 'ident' &&
      lower(next.value) === 'by'
    ) {
      return true;
    }
  }
  return false;
}

/** `LIMIT` in clause position: followed by a number or a placeholder. */
export function hasTopLevelLimit(tokens: readonly Token[]): boolean {
  const toks = significant(tokens);
  let depth = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === undefined) continue;
    if (t.kind === 'punct') {
      if (t.value === '(') depth++;
      else if (t.value === ')') depth--;
      continue;
    }
    if (depth === 0 && t.kind === 'ident' && lower(t.value) === 'limit') {
      const next = toks[i + 1];
      if (next === undefined) continue;
      if (next.kind === 'number') return true;
      if (next.kind === 'punct' && (next.value === '?' || next.value === '$')) return true;
    }
  }
  return false;
}

/**
 * A `JOIN` joining something, rather than a table that happens to be called
 * "join". In a real join the keyword follows a table reference; in
 * `UPDATE join SET ...` it follows UPDATE.
 */
export function hasJoin(tokens: readonly Token[]): boolean {
  const toks = significant(tokens);
  for (let i = 1; i < toks.length; i++) {
    const t = toks[i];
    const prev = toks[i - 1];
    if (t === undefined || prev === undefined) continue;
    if (t.kind !== 'ident' || lower(t.value) !== 'join') continue;
    if (prev.kind === 'ident' && TABLE_LEAD.has(lower(prev.value))) continue; // it is the table
    return true;
  }
  return false;
}
