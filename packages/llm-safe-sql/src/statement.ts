import type { Token } from './lexer.js';

export const lower = (s: string): string => s.toLowerCase();

/**
 * Keywords that end a FROM/JOIN clause, so an alias or column is not read as a table.
 * `ON` and `USING` are not among them: `JOIN b ON a.id = b.id, c` goes on to name
 * `c`, and treating the join condition as the end of the list hid it.
 */
const CLAUSE_END = new Set([
  'where', 'group', 'having', 'order', 'limit', 'offset', 'fetch', 'union', 'except',
  'intersect', 'set', 'returning', 'window', 'for', 'into',
]);

/** Words that open a query, so a parenthesis they follow holds a query and not a table. */
const SUBQUERY_LEAD = new Set(['select', 'with', 'values', 'table']);

/**
 * Keywords that end a WHERE clause. `ORDER`/`LIMIT` are refused on a write before
 * this is ever called; `RETURNING` is not, and is legal on Postgres.
 */
const WHERE_END = new Set(['returning', 'order', 'limit', 'offset', 'fetch', 'for']);

/** Keywords after which the next qualified name is a table. */
// `TABLE t` is Postgres and MySQL 8 for `SELECT * FROM t`, and it is legal as a
// subquery: `WHERE id IN (TABLE secrets)` read every row of a table this walk
// never reported, so the allowlist never saw it.
const TABLE_LEAD = new Set(['from', 'join', 'update', 'table']);

/** Significant tokens only — whitespace and comments carry no meaning here. */
function significant(tokens: readonly Token[]): Token[] {
  return tokens.filter((t) => t.kind !== 'ws' && t.kind !== 'comment');
}

/**
 * Table references, in order of appearance, case-folded and de-duplicated.
 *
 * This walks the token stream rather than parsing: names that follow FROM, JOIN or
 * UPDATE are tables, and a clause keyword ends the list so that an alias is not
 * mistaken for one. A sub-select's own FROM is reached by the same walk.
 */
export function tableRefs(tokens: readonly Token[]): string[] {
  const toks = significant(tokens);
  const out: string[] = [];
  const seen = new Set<string>();

  // Common table expressions are names this statement defines, not tables it
  // reads. Reporting them made `WITH x AS (...) SELECT * FROM x` refuse `x` as
  // not allowlisted — so SPEC's "SELECT and WITH" could not hold for any usable
  // WITH. A CTE's own body is scanned by the same walk, so
  // `WITH orders AS (SELECT * FROM secrets) SELECT * FROM orders` still reports
  // `secrets`.
  //
  // A name is dropped only where that CTE is in scope and spelled so that every
  // dialect resolves it to the CTE. Dropping every reference that shared a CTE's
  // name let a CTE defined inside a subquery hide the real table of that name
  // outside it.
  const scopes = cteScopes(toks);
  for (const site of refSites(toks).sites) {
    const one = site.parts.length === 1 ? toks[site.at] : undefined;
    if (one !== undefined && scopes.some((c) => c.from <= site.at && site.at < c.to && sameCteName(c.name, one))) {
      continue;
    }
    // Keep the author's spelling: it is what a human will recognise in an error
    // message. Comparisons are done case-folded at the call sites.
    const name = site.parts.join('.');
    const k = lower(name);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(name);
    }
  }
  return out;
}

interface RefSite {
  parts: string[];
  /** Index in the significant tokens of the first and last token of the name. */
  at: number;
  end: number;
}

/**
 * Every place a table is named, and the closing parenthesis of every parenthesised
 * join, whose alias names the joined row.
 */
function refSites(toks: readonly Token[]): { sites: RefSite[]; groupEnds: number[] } {
  const sites: RefSite[] = [];
  const groupEnds: number[] = [];
  let expect = false;
  // One entry per open bracket: whether a comma at that level separates tables,
  // and whether the bracket is itself a parenthesised table reference.
  const levels: { inFrom: boolean; group: boolean }[] = [{ inFrom: false, group: false }];

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === undefined) continue;
    const level = levels[levels.length - 1] ?? { inFrom: false, group: false };

    if (t.kind === 'punct') {
      if (t.value === '(' || t.value === '[') {
        // A parenthesis where a table name was expected is either a derived
        // table, `FROM (SELECT ...) AS x`, or a table reference in parentheses,
        // `FROM (secrets s) CROSS JOIN ...`. The first once left `expect` set, so
        // the keyword SELECT was recorded as the table; clearing it for both hid
        // the table in the second. The tables inside a derived table are still
        // found: this scan does not stop at the parenthesis.
        const next = toks[i + 1];
        const group = expect && t.value === '(' && !(next?.kind === 'ident' && SUBQUERY_LEAD.has(lower(next.value)));
        levels.push({ inFrom: group, group });
        if (!group) expect = false;
      } else if (t.value === ')' || t.value === ']') {
        if (levels.length > 1) levels.pop();
        if (level.group) groupEnds.push(i);
      } else if (t.value === ',' && level.inFrom) expect = true;
      continue;
    }

    // Order matters: when a table name is expected, the next identifier IS the
    // table even if it happens to spell a clause keyword. `UPDATE order SET ...`
    // targets a table called "order"; reading it as the start of ORDER BY loses
    // the target entirely.
    if (!expect && t.kind === 'ident' && TABLE_LEAD.has(lower(t.value))) {
      expect = true;
      level.inFrom = true;
      continue;
    }

    if (!expect && t.kind === 'ident' && CLAUSE_END.has(lower(t.value))) {
      level.inFrom = false;
      continue;
    }

    if (expect && (t.kind === 'ident' || t.kind === 'quotedIdent')) {
      // Keep the whole qualified name. Reducing `other.orders` to `orders` lets a
      // statement be measured against one table while it writes to another, and
      // lets it pass an allowlist that never mentioned it.
      const at = i;
      const parts = [t.value];
      while (
        i + 2 < toks.length &&
        toks[i + 1]?.kind === 'punct' &&
        toks[i + 1]?.value === '.' &&
        (toks[i + 2]?.kind === 'ident' || toks[i + 2]?.kind === 'quotedIdent')
      ) {
        parts.push(toks[i + 2]?.value ?? '');
        i += 2;
      }
      sites.push({ parts, at, end: i });
      expect = false;
      continue;
    }
  }
  return { sites, groupEnds };
}

/** Words after which a `*` is selecting columns rather than multiplying numbers. */
const STAR_LEAD = new Set(['select', 'distinct', 'distinctrow', 'all']);

/**
 * Whether the statement projects a `*` — a wildcard that hands back whichever
 * columns the table happens to have.
 *
 * This exists because `denyIdentifiers` matches identifier *references*, and a
 * wildcard names nothing. `SELECT * FROM users` therefore returned a column the
 * operator had marked as never-readable, while `SELECT password_hash FROM users`
 * was refused — the simplest spelling of the query walked past the guard that the
 * clever one hit.
 *
 * `COUNT(*)` is not projection: the `*` sits behind `(` and no column comes back.
 * Nor is arithmetic, where the `*` follows a value. Both are excluded by looking
 * at the token before it rather than by trying to parse the select list.
 *
 * A spelling this misses is a wildcard that gets fetched. It is not a wildcard
 * that gets *returned* — {@link Engine.read} checks the column names that came
 * back as well, and that check needs no parser to be right. This one is here so
 * that in the ordinary case the value never leaves the database at all.
 */
export function hasProjectionStar(tokens: readonly Token[]): boolean {
  const toks = significant(tokens);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t?.kind !== 'punct' || t.value !== '*') continue;
    const prev = toks[i - 1];
    if (prev === undefined) continue;
    if (prev.kind === 'punct' && (prev.value === ',' || prev.value === '.')) return true;
    if (prev.kind === 'ident' && STAR_LEAD.has(lower(prev.value))) return true;
  }
  return false;
}

/** Words that follow a table reference without being its alias. */
const NOT_AN_ALIAS = new Set([
  ...CLAUSE_END, 'on', 'using', 'as', 'join', 'left', 'right', 'inner', 'outer', 'cross', 'natural', 'full',
  'lateral', 'tablesample', 'select', 'from', 'update', 'table', 'where',
]);

const isName = (t: Token | undefined): boolean => t?.kind === 'ident' || t?.kind === 'quotedIdent';
const isPunct = (t: Token | undefined, value: string): boolean => t?.kind === 'punct' && t.value === value;

/** The index of the parenthesis that closes the one at `open`, or the length when none does. */
function closing(toks: readonly Token[], open: number): number {
  let d = 0;
  for (let i = open; i < toks.length; i++) {
    if (isPunct(toks[i], '(')) d++;
    else if (isPunct(toks[i], ')') && --d === 0) return i;
  }
  return toks.length;
}

/**
 * Every name a select list can use to mean "the whole row": each table referenced,
 * its unqualified name, the alias it was given, and the alias of a parenthesised
 * join. They are found by the same walk as {@link tableRefs}, so a table that walk
 * reports — after a comma, inside parentheses — is one whose row is looked for.
 */
function rowNames(toks: readonly Token[]): ReadonlySet<string> {
  const names = new Set<string>();
  const alias = (j: number): void => {
    let a = toks[j];
    if (a?.kind === 'ident' && lower(a.value) === 'as') a = toks[j + 1];
    if (a !== undefined && (a.kind === 'quotedIdent' || (a.kind === 'ident' && !NOT_AN_ALIAS.has(lower(a.value))))) {
      names.add(lower(a.value));
    }
  };
  const { sites, groupEnds } = refSites(toks);
  for (const site of sites) {
    names.add(lower(site.parts.join('.')));
    names.add(lower(site.parts[site.parts.length - 1] ?? ''));
    alias(site.end + 1);
  }
  for (const end of groupEnds) alias(end + 1);
  return names;
}

/**
 * Whether one select-list item uses a whole row anywhere in it. `SELECT u`,
 * `to_jsonb(u)`, `(u)`, `u::text` and `format('%s', u)` all hand back every column
 * of the row under a name of the author's choosing, so an item is judged by the
 * names it touches rather than by matching the shapes known so far — the shapes
 * were a list, and a list had room to step around.
 *
 * A name is not the row where it cannot be: qualified by something before it, the
 * name an `AS` gives, a function that happens to share it, or an alias written
 * without `AS` after a value that could not take an argument.
 */
function isRowItem(item: readonly Token[], names: ReadonlySet<string>): boolean {
  for (let i = 0; i < item.length; i++) {
    const t = item[i];
    if (t === undefined) continue;
    if (t.kind === 'punct') {
      // A subquery's select list is judged on its own when its SELECT is reached,
      // and its FROM names tables without projecting them.
      const next = item[i + 1];
      if (t.value === '(' && next?.kind === 'ident' && SUBQUERY_LEAD.has(lower(next.value))) i = closing(item, i);
      continue;
    }
    if (!isName(t)) continue;
    const at = i;
    const parts = [t.value];
    while (isPunct(item[i + 1], '.') && isName(item[i + 2])) {
      parts.push(item[i + 2]?.value ?? '');
      i += 2;
    }
    if (!names.has(lower(parts.join('.')))) continue;
    const prev = item[at - 1];
    if (isPunct(prev, '.')) continue;
    if (prev?.kind === 'ident' && lower(prev.value) === 'as') continue;
    if (isPunct(item[i + 1], '(')) continue;
    if (i === item.length - 1 && parts.length === 1 && endsValue(item, at - 1)) continue;
    return true;
  }
  return false;
}

/** Whether the token at `k` can only end a value, so a bare name after it is an alias. */
function endsValue(item: readonly Token[], k: number): boolean {
  const t = item[k];
  if (t === undefined) return false;
  if (t.kind === 'number' || t.kind === 'string' || t.kind === 'quotedIdent') return true;
  return t.kind === 'ident' && isPunct(item[k - 1], '.');
}

/**
 * Whether a select list hands back a whole row under one name — the same hole as
 * a `*`, spelled without one. `SELECT u FROM users u` and `SELECT to_jsonb(users)
 * FROM users` both return every column, including a denied one, and the column
 * that comes back is called `u` or `to_jsonb`, so R2a cannot see it either.
 *
 * Judged the way {@link hasProjectionStar} is: on the tokens, per select list,
 * item by item. A column that happens to share its name with a table it is not
 * read from is not matched, because the names are taken from this statement's own
 * FROM clauses. A column named after its own table is refused: Postgres would have
 * resolved that spelling to the row as well.
 */
export function projectsRow(tokens: readonly Token[]): boolean {
  const toks = significant(tokens);
  const names = rowNames(toks);
  if (names.size === 0) return false;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t?.kind !== 'ident' || lower(t.value) !== 'select') continue;
    let j = i + 1;
    const q = toks[j];
    if (q?.kind === 'ident' && (lower(q.value) === 'distinct' || lower(q.value) === 'distinctrow' || lower(q.value) === 'all')) j++;
    let depth = 0;
    let item: Token[] = [];
    const items: Token[][] = [];
    for (; j < toks.length; j++) {
      const u = toks[j];
      if (u === undefined) continue;
      if (u.kind === 'punct') {
        if (u.value === '(') depth++;
        else if (u.value === ')') {
          if (depth === 0) break;
          depth--;
        } else if (u.value === ',' && depth === 0) {
          items.push(item);
          item = [];
          continue;
        }
      } else if (depth === 0 && u.kind === 'ident' && lower(u.value) === 'from') {
        break;
      }
      item.push(u);
    }
    items.push(item);
    if (items.some((it) => isRowItem(it, names))) return true;
  }
  return false;
}

interface CteScope {
  name: Token;
  /** The significant-token range in which a reference to `name` means the CTE. */
  from: number;
  to: number;
}

/**
 * The names introduced by each `WITH name AS (…), name AS (…)`, and where each one
 * is visible: from the end of its own body — from the start of it under
 * `RECURSIVE` — to the end of the query the WITH belongs to. A CTE defined inside a
 * subquery is not visible outside that subquery, and outside it the same name is
 * the real table.
 */
function cteScopes(toks: readonly Token[]): CteScope[] {
  const out: CteScope[] = [];
  for (let w = 0; w < toks.length; w++) {
    const t = toks[w];
    if (t?.kind !== 'ident' || lower(t.value) !== 'with') continue;
    let i = w + 1;
    const recursive = toks[i]?.kind === 'ident' && lower(toks[i]?.value ?? '') === 'recursive';
    if (recursive) i++;
    const defined: { name: Token; open: number; close: number }[] = [];
    for (;;) {
      const name = toks[i];
      if (name === undefined || !isName(name)) break;
      let j = i + 1;
      // `name (col, col) AS (…)` is legal too; skip the column list.
      if (isPunct(toks[j], '(')) j = closing(toks, j) + 1;
      if (toks[j]?.kind !== 'ident' || lower(toks[j]?.value ?? '') !== 'as' || !isPunct(toks[j + 1], '(')) break;
      const close = closing(toks, j + 1);
      defined.push({ name, open: j + 1, close });
      i = close + 1;
      if (!isPunct(toks[i], ',')) break;
      i++;
    }
    if (defined.length === 0) continue;

    let to = toks.length;
    for (let d = 0; i < toks.length; i++) {
      if (isPunct(toks[i], '(')) d++;
      else if (isPunct(toks[i], ')') && d-- === 0) {
        to = i;
        break;
      }
    }
    for (const c of defined) out.push({ name: c.name, from: recursive ? c.open : c.close, to });
  }
  return out;
}

/**
 * Whether a reference is certainly to the CTE and not to a table. Postgres folds an
 * unquoted name to lower case and keeps a quoted one as written; MySQL compares CTE
 * names as written on a case-sensitive file system. Only a spelling that means the
 * same name under both is taken as the CTE — anything else is reported as a table,
 * which at worst refuses a statement that could have run.
 */
function sameCteName(cte: Token, ref: Token): boolean {
  return cte.value === ref.value && (cte.kind === ref.kind || ref.value === lower(ref.value));
}

/**
 * Column names on the left of each assignment in an UPDATE ... SET clause.
 *
 * This feeds `denyWriteColumns`, so a column it fails to report is a column that
 * guard does not protect. Two spellings used to escape it, and both were silent —
 * the statement ran, the denied column was written, and nothing refused:
 *
 *   `SET orders.price = 1`      — it took the first identifier after `SET`, so it
 *                                 reported the *table* as the column name. Legal
 *                                 SQL on MySQL and Postgres alike.
 *   `SET (qty, price) = (1, 2)` — Postgres' multi-column form. The comma inside
 *                                 the parentheses was ignored because it was not
 *                                 at depth 0, so only the first column was seen.
 *                                 Putting the denied column anywhere but first
 *                                 was enough.
 *
 * So the shape is parsed properly rather than approximated: a qualified name
 * reduces to its last component, and the parenthesised column list is read as a
 * list. When the left side cannot be understood at all, the name is reported as
 * `undefined` — see {@link setColumnsAreCertain} — because a guard that cannot
 * read a statement must not report that the statement is clean.
 */
export function setColumns(tokens: readonly Token[]): string[] {
  return setTargets(tokens).filter((c): c is string => c !== undefined);
}

/**
 * False when the SET clause contained an assignment whose target could not be
 * identified. The policy treats that as a refusal rather than as an absence.
 */
export function setColumnsAreCertain(tokens: readonly Token[]): boolean {
  return !setTargets(tokens).includes(undefined);
}

function setTargets(tokens: readonly Token[]): (string | undefined)[] {
  const toks = significant(tokens);
  const out: (string | undefined)[] = [];
  let depth = 0;
  let i = 0;

  // Find the top-level SET.
  for (; i < toks.length; i++) {
    const t = toks[i];
    if (t === undefined) continue;
    if (t.kind === 'punct') {
      if (t.value === '(') depth++;
      else if (t.value === ')') depth--;
      continue;
    }
    if (depth === 0 && t.kind === 'ident' && lower(t.value) === 'set') {
      i++;
      break;
    }
  }
  if (i >= toks.length) return out;

  const isName = (t: Token | undefined): boolean => t?.kind === 'ident' || t?.kind === 'quotedIdent';

  /** `db.tbl.col` is a name for `col`. Consumes the whole dotted run. */
  const qualified = (): string | undefined => {
    if (!isName(toks[i])) return undefined;
    let last = toks[i]?.value;
    i++;
    while (toks[i]?.kind === 'punct' && toks[i]?.value === '.') {
      i++;
      if (!isName(toks[i])) return undefined; // `t.` with nothing after it
      last = toks[i]?.value;
      i++;
    }
    return last;
  };

  /** Skip the assigned expression, stopping at the comma that starts the next one. */
  const skipValue = (): void => {
    let d = 0;
    for (; i < toks.length; i++) {
      const t = toks[i];
      if (t === undefined) continue;
      if (t.kind === 'punct') {
        if (t.value === '(') d++;
        else if (t.value === ')') d--;
        else if (t.value === ',' && d === 0) {
          i++;
          return;
        }
        continue;
      }
      // FROM belongs to Postgres' UPDATE ... FROM, which normalize refuses
      // separately; either way the SET clause has ended.
      if (d === 0 && t.kind === 'ident' && SET_END.has(lower(t.value))) {
        i = toks.length;
        return;
      }
    }
  };

  while (i < toks.length) {
    const t = toks[i];
    if (t === undefined) break;
    if (t.kind === 'ident' && SET_END.has(lower(t.value))) break;

    if (t.kind === 'punct' && t.value === '(') {
      // Postgres' `SET (a, b, c) = (...)`: every name in the list is a target.
      i++;
      for (;;) {
        const name = qualified();
        out.push(name);
        const next = toks[i];
        if (next?.kind === 'punct' && next.value === ',') {
          i++;
          continue;
        }
        if (next?.kind === 'punct' && next.value === ')') i++;
        break;
      }
      skipValue();
      continue;
    }

    if (isName(t)) {
      out.push(qualified());
      skipValue();
      continue;
    }

    // Something unexpected on the left of an assignment. Record that a target
    // exists and could not be read, rather than moving on quietly.
    out.push(undefined);
    skipValue();
  }

  return out;
}

/** Words that end the SET clause of an UPDATE. */
const SET_END: ReadonlySet<string> = new Set(['where', 'from', 'returning', 'order', 'limit']);

/**
 * The text of the top-level WHERE clause, or undefined when there is none.
 *
 * The engine needs this to ask "how many rows does this actually match?" without
 * running the write, and to re-ask the same question immediately before applying.
 * Finding it by scanning tokens rather than by regex matters: a `WHERE` inside a
 * string literal or a sub-select is not the clause we mean, and taking the wrong
 * one produces a row count for a different question than the one being approved.
 */
export function whereClause(tokens: readonly Token[]): string | undefined {
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
    if (depth === 0 && t.kind === 'ident' && lower(t.value) === 'where') {
      // Stop at a clause that follows the condition rather than belonging to it.
      // `DELETE FROM t WHERE id = 1 RETURNING id` is a perfectly good statement,
      // but the engine reuses this text to ask `SELECT COUNT(*) FROM t WHERE …`,
      // and a RETURNING carried into that produces a syntax error about a word
      // the operator wrote in a place where it was legal.
      const rest: Token[] = [];
      let d = 0;
      for (const x of tokens.slice(tokens.indexOf(t) + 1)) {
        if (x.kind === 'punct') {
          if (x.value === '(') d++;
          else if (x.value === ')') d--;
        }
        if (d === 0 && x.kind === 'ident' && WHERE_END.has(lower(x.value))) break;
        rest.push(x);
      }
      const text = rest.map((x) => x.raw).join('').trim();
      return text === '' ? undefined : text;
    }
  }
  return undefined;
}
