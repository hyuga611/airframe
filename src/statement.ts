import type { Token } from './lexer.js';

export const lower = (s: string): string => s.toLowerCase();

/** Keywords that end a FROM/JOIN clause, so an alias or column is not read as a table. */
const CLAUSE_END = new Set([
  'where', 'group', 'having', 'order', 'limit', 'offset', 'fetch', 'union', 'except',
  'intersect', 'on', 'using', 'set', 'returning', 'window', 'for', 'into',
]);

/** Keywords after which the next qualified name is a table. */
const TABLE_LEAD = new Set(['from', 'join', 'update']);

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
  let expect = false;
  let inFrom = false;
  let depth = 0;
  let fromDepth = 0;

  // Keep the author's spelling: it is what a human will recognise in an error
  // message. Comparisons are done case-folded at the call sites.
  const add = (name: string): void => {
    const k = lower(name);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(name);
    }
  };

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === undefined) continue;

    if (t.kind === 'punct') {
      if (t.value === '(') depth++;
      else if (t.value === ')') depth--;
      else if (t.value === ',' && inFrom && depth === fromDepth) expect = true;
      continue;
    }

    // Order matters: when a table name is expected, the next identifier IS the
    // table even if it happens to spell a clause keyword. `UPDATE order SET ...`
    // targets a table called "order"; reading it as the start of ORDER BY loses
    // the target entirely.
    if (!expect && t.kind === 'ident' && TABLE_LEAD.has(lower(t.value))) {
      expect = true;
      inFrom = true;
      fromDepth = depth;
      continue;
    }

    if (!expect && t.kind === 'ident' && CLAUSE_END.has(lower(t.value))) {
      inFrom = false;
      continue;
    }

    if (expect && (t.kind === 'ident' || t.kind === 'quotedIdent')) {
      // Keep the whole qualified name. Reducing `other.orders` to `orders` lets a
      // statement be measured against one table while it writes to another, and
      // lets it pass an allowlist that never mentioned it.
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
      add(parts.join('.'));
      expect = false;
      continue;
    }
  }

  return out;
}

/** Column names on the left of each assignment in an UPDATE ... SET clause. */
export function setColumns(tokens: readonly Token[]): string[] {
  const toks = significant(tokens);
  const out: string[] = [];
  let depth = 0;
  let inSet = false;
  let atColumn = false;

  for (const t of toks) {
    if (t.kind === 'punct') {
      if (t.value === '(') depth++;
      else if (t.value === ')') depth--;
      else if (t.value === ',' && inSet && depth === 0) atColumn = true;
      continue;
    }
    if (t.kind === 'ident' && lower(t.value) === 'set' && !inSet) {
      inSet = true;
      atColumn = true;
      continue;
    }
    if (t.kind === 'ident' && lower(t.value) === 'where' && depth === 0) {
      inSet = false;
      continue;
    }
    if (inSet && atColumn && (t.kind === 'ident' || t.kind === 'quotedIdent')) {
      out.push(t.value); // author's spelling; callers fold case to compare
      atColumn = false;
    }
  }

  return out;
}

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
      const rest = tokens.slice(tokens.indexOf(t) + 1);
      const text = rest.map((x) => x.raw).join('').trim();
      return text === '' ? undefined : text;
    }
  }
  return undefined;
}
