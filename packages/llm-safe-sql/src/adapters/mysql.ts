import mysql from 'mysql2/promise';
import type { Adapter, ColumnShape, Row, DeleteAbility, ProbeOutcome, Savepoint, SelfCheckMode, TableShape, WriteAbility } from '../adapter.js';
import { AdapterUnusable, probeDeleteAbility, probeWriteAbility } from '../adapter.js';

/**
 * What this connection is allowed to *see*, as opposed to what it may do.
 *
 * MySQL answers two of the questions `introspect` asks out of privilege-filtered
 * views, and it filters them by returning fewer rows rather than an error. So
 * "there are no triggers on this table" and "you may not know whether there are
 * triggers on this table" arrive as the same `COUNT(*) = 0`, and an inbound
 * foreign key whose child table you cannot see arrives as an empty list.
 *
 * The source is `SHOW GRANTS` and not `information_schema.SCHEMA_PRIVILEGES`,
 * because that choice is measurable and I measured it: with the TRIGGER privilege
 * held through an active role, `SHOW GRANTS` reports
 * `GRANT SELECT, TRIGGER ON \`db\`.* TO ...` while `SCHEMA_PRIVILEGES` returns no
 * rows at all. Reading the structured view would have called a role-based
 * deployment blind and refused it.
 */
interface Grants {
  /** Privileges held on `*.*`. */
  readonly global: ReadonlySet<string>;
  /** Privileges held on `db.*`, by database. */
  readonly schema: ReadonlyMap<string, ReadonlySet<string>>;
  /** Privileges held on `db.table`, keyed `db.table`. */
  readonly table: ReadonlyMap<string, ReadonlySet<string>>;
}

const NO_GRANTS: Grants = { global: new Set(), schema: new Map(), table: new Map() };

/**
 * Privileges that make a table appear in `information_schema` at all.
 *
 * Held at `db.*` or `*.*`, any one of them means every table in that database is
 * visible — including the child tables whose rows carry the foreign keys pointing
 * back at ours. `CREATE TEMPORARY TABLES` is deliberately absent: it is granted at
 * schema scope and confers no visibility of anything, which is why the
 * recommended role held it and still saw one table out of three.
 */
const TABLE_VISIBILITY = new Set([
  'ALL PRIVILEGES',
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'CREATE',
  'DROP',
  'REFERENCES',
  'INDEX',
  'ALTER',
  'CREATE VIEW',
  'SHOW VIEW',
  'TRIGGER',
]);

const unquote = (s: string): string => s.replace(/`/g, '');

/** `GRANT SELECT, INSERT ON \`db\`.\`t\` TO ...` — one row of `SHOW GRANTS`. */
function readGrantLine(line: string, into: { global: Set<string>; schema: Map<string, Set<string>>; table: Map<string, Set<string>> }): void {
  // Role grants (`GRANT \`r\`@\`%\` TO \`u\`@\`%\``) have no ON clause and are skipped:
  // their privileges are already expanded into the other rows.
  const m = /^GRANT\s+(.+?)\s+ON\s+(\S+)\s+TO\s/i.exec(line);
  if (m === null) return;
  // A column-scoped privilege reads `SELECT (a, b)`, and those commas are not
  // separators. Removing the parenthesised part keeps the privilege name.
  const privileges = new Set(
    (m[1] ?? '')
      .replace(/\([^)]*\)/g, '')
      .split(',')
      .map((p) => p.trim().toUpperCase())
      .filter((p) => p.length > 0),
  );
  const object = m[2] ?? '';
  if (object === '*.*') {
    for (const p of privileges) into.global.add(p);
    return;
  }
  const dot = object.lastIndexOf('.');
  if (dot === -1) return;
  const db = unquote(object.slice(0, dot));
  const rest = object.slice(dot + 1);
  const target = rest === '*' ? into.schema : into.table;
  const key = rest === '*' ? db : `${db}.${unquote(rest)}`;
  const set = target.get(key) ?? new Set<string>();
  for (const p of privileges) set.add(p);
  target.set(key, set);
}

export function parseGrants(lines: readonly string[]): Grants {
  const into = { global: new Set<string>(), schema: new Map<string, Set<string>>(), table: new Map<string, Set<string>>() };
  for (const line of lines) readGrantLine(line, into);
  return into;
}

function holds(g: Grants, privilege: string, db: string, table?: string): boolean {
  const any = (s: ReadonlySet<string> | undefined): boolean =>
    s !== undefined && (s.has(privilege) || s.has('ALL PRIVILEGES'));
  return any(g.global) || any(g.schema.get(db)) || (table !== undefined && any(g.table.get(`${db}.${table}`)));
}

/**
 * Whether this connection would be shown a trigger on `db.table` if one existed.
 *
 * Exported for its own test: it is the single line standing between a count of
 * zero that means "there are none" and a count of zero that means "you may not
 * look", and the two are the same value.
 */
export function canSeeTriggers(g: Grants, db: string, table: string): boolean {
  return holds(g, 'TRIGGER', db, table);
}

/** Whether every table in `db` is visible to this connection, not just ours. */
export function canSeeWholeSchema(g: Grants, db: string): boolean {
  const any = (s: ReadonlySet<string> | undefined): boolean => {
    if (s === undefined) return false;
    for (const p of s) if (TABLE_VISIBILITY.has(p)) return true;
    return false;
  };
  return any(g.global) || any(g.schema.get(db));
}

/**
 * Whether MySQL refused this statement **for the privilege**, rather than for
 * anything else.
 *
 * Measured against MySQL 8.4: a role holding `SELECT, INSERT` and no `DELETE`
 * answers `1142 ER_TABLEACCESS_DENIED_ERROR`. The refusal this exists to
 * exclude is `1792 ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION`, which `root` gets
 * too and which says nothing about what `root` may do.
 */
const PRIVILEGE_DENIED = new Set([
  1044, // ER_DBACCESS_DENIED_ERROR
  1142, // ER_TABLEACCESS_DENIED_ERROR
  1143, // ER_COLUMNACCESS_DENIED_ERROR
]);

function refusedForPrivilege(e: unknown): boolean {
  const errno = (e as { errno?: unknown } | null | undefined)?.errno;
  return typeof errno === 'number' && PRIVILEGE_DENIED.has(errno);
}

export { AdapterUnusable };

export interface MysqlConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export class MysqlAdapter implements Adapter {
  readonly dialect = 'mysql' as const;
  /**
   * This used to read "both are real here, so there is nothing to disclaim",
   * which was wrong in the way that matters: `max_execution_time` is real, and it
   * applies to read-only `SELECT` only. MySQL has no statement timeout for an
   * UPDATE or a DELETE at all — measured, and pinned by
   * `test/integration/adapters.test.ts`, in this repository, while this array
   * stayed empty. So the engine copied nothing onto the card, `check` printed
   * nothing, and `limits.statementMs` looked enforced on the one engine where the
   * write it is meant to bound is not bounded by it.
   *
   * SQLite declares the same gap and always has. An adapter that cannot do
   * something and says so is a known trade; the same adapter saying nothing is
   * the ambush E5 exists to prevent.
   */
  readonly limitations: readonly string[] = [
    'MySQL cannot bound how long an UPDATE or DELETE runs: max_execution_time applies to read-only ' +
      'SELECT only, so the statement time limit does not constrain a write here. What does constrain ' +
      'one is innodb_lock_wait_timeout plus the row ceiling, so neither is optional on MySQL.',
  ];
  private readonly conn: mysql.Connection;
  private open = false;
  private savepoints = 0;
  /** Asked once: `SHOW GRANTS` does not change under a connection. */
  private grants?: { grants: Grants; db: string };

  private constructor(conn: mysql.Connection) {
    this.conn = conn;
  }

  static async connect(cfg: MysqlConfig): Promise<MysqlAdapter> {
    const conn = await mysql.createConnection({
      ...cfg,
      // Ask for FOUND_ROWS explicitly so affectedRows means rows *matched*.
      // mysql2 happens to enable it by default, but "happens to" is not a
      // guarantee: without it MySQL reports rows *changed* there instead, both
      // numbers become the same one, and the reconciliation that is supposed to
      // catch "rows changed that you were never shown" compares a value against
      // itself and can never fail. selfCheck proves the flag took effect.
      flags: ['+FOUND_ROWS'],
      multipleStatements: false,
      // BIGINT and DECIMAL must arrive as strings. A double cannot hold a 64-bit
      // id or a money value exactly, and the digits it loses are the ones that
      // differ — so a real change becomes invisible in the diff.
      supportBigNumbers: true,
      bigNumberStrings: true,
      decimalNumbers: false,
      // Dates as text, for the same reason as BIGINT above. A JS Date holds
      // milliseconds; DATETIME(6) holds microseconds. Parsing to a Date discards
      // the last three digits, so a change confined to them is invisible in the
      // diff and rides along under whatever else the statement touches. It also
      // makes MySQL's zero date arrive as 1899-11-30, which is a value the
      // database does not contain being shown to somebody for approval.
      dateStrings: true,
    });

    // Make the server agree with the parser about what the text means.
    //
    // The lexer reads MySQL with the server's defaults: `"x"` is a *string*, and
    // a backslash escapes inside one. Two sql_mode flags change that, and both
    // are ordinary things to find on a real server:
    //
    //   ANSI_QUOTES          `"api_token"` becomes an identifier. The lexer sees
    //                        a string, so it is not an identifier reference —
    //                        and `denyIdentifiers`, which is the rule that stops
    //                        a credential column being read, never fires while
    //                        MySQL happily returns the column.
    //   NO_BACKSLASH_ESCAPES a backslash stops escaping, so the lexer and the
    //                        server disagree about where a string literal ends,
    //                        which is a disagreement about how many statements
    //                        there are.
    //
    // Cleared per session rather than probed-and-refused: a server default of
    // ANSI_QUOTES is somebody's whole application, and refusing to run at all
    // would be a worse answer than making our own session unambiguous. Built
    // from the current value so nothing else — STRICT_TRANS_TABLES above all —
    // is dropped on the way. selfCheck then proves it took.
    const [modeRows] = await conn.query<mysql.RowDataPacket[]>('SELECT @@SESSION.sql_mode AS m');
    const modes = String(modeRows[0]?.['m'] ?? '')
      .split(',')
      .map((m) => m.trim())
      .filter((m) => m !== '' && m !== 'ANSI_QUOTES' && m !== 'NO_BACKSLASH_ESCAPES' && m !== 'ANSI');
    await conn.query('SET SESSION sql_mode = ?', [modes.join(',')]);

    return new MysqlAdapter(conn);
  }

  /**
   * Prove the four things this library's guarantees rest on, using a TEMPORARY
   * table so no user data is touched.
   */
  async selfCheck(mode: SelfCheckMode = 'full'): Promise<void> {
    // 1. Is the session sticky? A transaction-pooling proxy can hand our session
    //    to somebody else between statements, which would leave an open dry-run
    //    transaction — and its locks — in a stranger's hands. True of reads too:
    //    a read served from someone else's session is still a wrong answer.
    await this.conn.query("SET @llm_safe_sql_probe = 'sticky'");
    const [stick] = await this.conn.query<mysql.RowDataPacket[]>('SELECT @llm_safe_sql_probe AS v');
    if (stick[0]?.['v'] !== 'sticky') {
      throw new AdapterUnusable(
        'Session state does not survive between statements. A connection pooler in transaction mode ' +
          'cannot be used: a dry run could be left open on a connection handed to another caller.',
      );
    }

    // 1b. The parser and the server still read the same text the same way. This
    //     is checked on the read path too: the identifier rule that keeps a
    //     credential column from being read is the one ANSI_QUOTES defeats, and
    //     reads are what an injected instruction reaches first.
    const [modeRows] = await this.conn.query<mysql.RowDataPacket[]>('SELECT @@SESSION.sql_mode AS m');
    const active = String(modeRows[0]?.['m'] ?? '').split(',');
    for (const bad of ['ANSI_QUOTES', 'NO_BACKSLASH_ESCAPES', 'ANSI']) {
      if (active.includes(bad)) {
        throw new AdapterUnusable(
          `This session still has sql_mode ${bad}, which changes what the text of a statement means — ` +
            'so the parser in this library and the server would disagree about which parts are identifiers ' +
            'and where a string ends. It is cleared when the connection is opened, so something reset it ' +
            '(a proxy, or a connection handed over between statements).',
        );
      }
    }

    // Everything below needs CREATE TEMPORARY TABLES and the privilege to write.
    // The read path has neither, by design, and demanding them of it refuses the
    // configuration this setting exists to encourage.
    if (mode === 'read') return;

    let probe: mysql.RowDataPacket[];
    try {
      await this.conn.query('CREATE TEMPORARY TABLE llm_safe_sql_probe (id INT PRIMARY KEY, v INT NOT NULL) ENGINE=InnoDB');
    } catch (e) {
      throw new AdapterUnusable(
        'Cannot create a TEMPORARY table, so the environment cannot be verified. ' +
          `Grant CREATE TEMPORARY TABLES to this user. (${String(e)})`,
      );
    }

    try {
      await this.conn.query('INSERT INTO llm_safe_sql_probe VALUES (1, 10)');

      // 2. Does a rollback actually undo? A non-transactional engine accepts
      //    ROLLBACK, reports success, and changes nothing back — turning every
      //    dry run into an unannounced write.
      await this.conn.query('START TRANSACTION');
      await this.conn.query('UPDATE llm_safe_sql_probe SET v = 999 WHERE id = 1');
      await this.conn.query('ROLLBACK');
      [probe] = await this.conn.query<mysql.RowDataPacket[]>('SELECT v FROM llm_safe_sql_probe WHERE id = 1');
      if (Number(probe[0]?.['v']) !== 10) {
        throw new AdapterUnusable(
          'A rollback did not undo the change. This storage engine is not transactional, ' +
            'so a dry run here would write to production and stay written.',
        );
      }

      // 3. Does "rows affected" mean matched or changed? Every reconciliation in
      //    this library depends on the answer, and it is configurable.
      //    Both halves must be checked. An earlier version asserted only that a
      //    same-value UPDATE reports 0 changed, which is true whether or not
      //    FOUND_ROWS is on — so the number this adapter calls `rowsMatched` was
      //    never verified to be a count of matches at all.
      const [same] = await this.conn.query<mysql.ResultSetHeader>(
        'UPDATE llm_safe_sql_probe SET v = 10 WHERE v = 10',
      );
      if (same.changedRows !== 0) {
        throw new AdapterUnusable(
          `Expected changedRows to be 0 for a same-value UPDATE, got ${same.changedRows}. ` +
            'The reconciliation between "rows the database changed" and "rows we showed you" cannot be trusted here.',
        );
      }
      if (same.affectedRows !== 1) {
        throw new AdapterUnusable(
          `Expected affectedRows to be 1 (rows matched) for a same-value UPDATE, got ${same.affectedRows}. ` +
            'This connection reports rows changed instead of rows matched, so the two counts this library ' +
            'reconciles against each other are the same number and the check cannot fail.',
        );
      }
    } finally {
      await this.conn.query('DROP TEMPORARY TABLE IF EXISTS llm_safe_sql_probe').catch(() => {});
    }
  }

  /**
   * Bound the session in time.
   *
   * 🔴 A limitation worth knowing: MySQL's `max_execution_time` applies to
   * read-only SELECTs only. There is no statement timeout for an UPDATE or
   * DELETE on MySQL at all. The reference implementation's optimizer hint was
   * therefore doubly ineffective — ignored by other engines, and never applicable
   * to the writes it was meant to bound even on its own.
   *
   * What actually protects a write here is `innodb_lock_wait_timeout` plus the
   * engine's own row-count ceiling, so neither of those is optional on MySQL.
   */
  async applyLimits(limits: { statementMs: number; lockMs: number }): Promise<void> {
    await this.conn.query(`SET SESSION max_execution_time = ${Math.max(0, Math.floor(limits.statementMs))}`);
    // innodb_lock_wait_timeout is in whole seconds, minimum 1.
    const secs = Math.max(1, Math.ceil(limits.lockMs / 1000));
    await this.conn.query(`SET SESSION innodb_lock_wait_timeout = ${secs}`);
  }

  /**
   * What this connection may see, cached.
   *
   * A failure here is not allowed to become "you can see everything": it becomes
   * no grants at all, which makes both visibility flags false, which makes the
   * engine refuse and say why. That is the direction this whole release is about.
   */
  private async visibility(): Promise<{ grants: Grants; db: string }> {
    if (this.grants !== undefined) return this.grants;
    let grants = NO_GRANTS;
    let db = '';
    try {
      const [dbRows] = await this.conn.query<mysql.RowDataPacket[]>('SELECT DATABASE() AS d');
      db = String(dbRows[0]?.['d'] ?? '');
      const [rows] = await this.conn.query<mysql.RowDataPacket[]>('SHOW GRANTS');
      grants = parseGrants(rows.map((r) => String(Object.values(r)[0] ?? '')));
    } catch {
      grants = NO_GRANTS;
    }
    this.grants = { grants, db };
    return this.grants;
  }

  async introspect(table: string): Promise<TableShape> {
    const [cols] = await this.conn.query<mysql.RowDataPacket[]>(
      `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, EXTRA
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION`,
      [table],
    );
    if (cols.length === 0) throw new AdapterUnusable(`Table \`${table}\` was not found.`);

    const [pk] = await this.conn.query<mysql.RowDataPacket[]>(
      `SELECT COLUMN_NAME
         FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = 'PRIMARY'
        ORDER BY SEQ_IN_INDEX`,
      [table],
    );

    // A trigger can change any column on update, and nothing in the column
    // definitions says so. When one exists we cannot claim to know which columns
    // move by themselves — and a wrong "none" is indistinguishable, at approval
    // time, from someone else editing the row.
    const [trig] = await this.conn.query<mysql.RowDataPacket[]>(
      `SELECT COUNT(*) AS c FROM information_schema.TRIGGERS
        WHERE EVENT_OBJECT_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE = ?`,
      [table],
    );
    const triggerCount = Number(trig[0]?.['c'] ?? 0);

    // The storage engine is a per-table property, so a probe table proves nothing
    // about this one. MyISAM accepts a ROLLBACK, reports success, and keeps the
    // write — turning the dry run into a permanent change announced as harmless.
    const [eng] = await this.conn.query<mysql.RowDataPacket[]>(
      `SELECT ENGINE FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [table],
    );
    const engine = String(eng[0]?.['ENGINE'] ?? '').toUpperCase();
    const transactional = engine === 'INNODB' || engine === 'NDBCLUSTER' || engine === 'ROCKSDB';

    // Foreign keys pointing AT this table. With CASCADE or SET NULL, changing an
    // approved row also changes rows in another table that were never displayed.
    // Both of the questions in this method were answered out of privilege-filtered views,
    // and both of them answer "no" and "you may not ask" with the same value.
    const { grants, db } = await this.visibility();
    const triggersVisible = canSeeTriggers(grants, db, table);
    const inboundCascadesKnown = canSeeWholeSchema(grants, db);

    // `CONSTRAINT_SCHEMA` is the CHILD's database, not this table's. Filtering on
    // it therefore asked "which children of mine live in my own database", and a
    // child in another database was never found — while `inboundCascadesKnown`
    // still said true, so nothing downstream hesitated. Measured on MySQL 8.4.11:
    // a table in `archive` with `ON DELETE CASCADE` onto a table here read as no
    // cascades at all, and the DELETE was offered for approval as "1 row".
    //
    // `UNIQUE_CONSTRAINT_SCHEMA` is the referenced side — this table's database —
    // which is the question that was meant. The join stays on the child's schema,
    // because that is where `KEY_COLUMN_USAGE` keeps the row.
    const [fks] = await this.conn.query<mysql.RowDataPacket[]>(
      `SELECT k.TABLE_SCHEMA AS child_schema, k.TABLE_NAME AS child, r.CONSTRAINT_NAME AS name,
              r.DELETE_RULE AS del, r.UPDATE_RULE AS upd
         FROM information_schema.REFERENTIAL_CONSTRAINTS r
         JOIN information_schema.KEY_COLUMN_USAGE k
           ON k.CONSTRAINT_SCHEMA = r.CONSTRAINT_SCHEMA
          AND k.CONSTRAINT_NAME = r.CONSTRAINT_NAME
        WHERE r.UNIQUE_CONSTRAINT_SCHEMA = DATABASE() AND r.REFERENCED_TABLE_NAME = ?
        GROUP BY k.TABLE_SCHEMA, k.TABLE_NAME, r.CONSTRAINT_NAME, r.DELETE_RULE, r.UPDATE_RULE`,
      [table],
    );
    const inboundCascades = fks.map((f) => {
      const schema = String(f['child_schema'] ?? '');
      const child = String(f['child']);
      return {
        // Qualified when it is somewhere else, because "rows in `order_history`
        // would go with it" is a different warning depending on which database
        // that is, and the operator is the one who has to recognise the name.
        table: schema === '' || schema === db ? child : `${schema}.${child}`,
        constraint: String(f['name']),
        onDelete: String(f['del'] ?? 'NO ACTION').toUpperCase(),
        onUpdate: String(f['upd'] ?? 'NO ACTION').toUpperCase(),
      };
    });

    const columns: ColumnShape[] = cols.map((c) => ({
      name: String(c['COLUMN_NAME']),
      type: String(c['DATA_TYPE']),
      nullable: String(c['IS_NULLABLE']).toUpperCase() === 'YES',
      autoUpdated: /on update/i.test(String(c['EXTRA'] ?? '')),
    }));

    return {
      table,
      columns,
      primaryKey: pk.map((r) => String(r['COLUMN_NAME'])),
      autoColumnsKnown: triggersVisible && triggerCount === 0,
      triggersVisible,
      inboundCascadesKnown,
      transactional,
      inboundCascades,
      triggerCount,
    };
  }

  async begin(isolation: 'default' | 'repeatable-read' | 'read-only' = 'default'): Promise<void> {
    // MySQL's default already is REPEATABLE READ, so the request is a no-op here;
    // it is set explicitly anyway so a server configured otherwise still gives the
    // dry run one consistent view.
    if (isolation === 'repeatable-read') {
      await this.conn.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    }
    await this.conn.query(isolation === 'read-only' ? 'START TRANSACTION READ ONLY' : 'START TRANSACTION');
    this.open = true;
  }

  async commit(): Promise<void> {
    await this.conn.query('COMMIT');
    this.open = false;
  }

  async rollback(): Promise<void> {
    await this.conn.query('ROLLBACK');
    this.open = false;
  }

  inTransaction(): boolean {
    return this.open;
  }

  async savepoint(): Promise<Savepoint> {
    const name = `llm_safe_sql_sp_${++this.savepoints}`;
    await this.conn.query(`SAVEPOINT ${name}`);
    const conn = this.conn;
    return {
      name,
      async rollback() {
        await conn.query(`ROLLBACK TO SAVEPOINT ${name}`);
      },
      async release() {
        await conn.query(`RELEASE SAVEPOINT ${name}`);
      },
    };
  }

  async query<T = Row>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    const [rows] = await this.conn.query<mysql.RowDataPacket[]>(sql, params as unknown[]);
    return rows as unknown as T[];
  }

  async execute(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<{ rowsMatched: number; rowsChanged: number; changedIsMeaningful: boolean }> {
    const [res] = await this.conn.query<mysql.ResultSetHeader>(sql, params as unknown[]);
    return {
      rowsMatched: res.affectedRows,
      // Defined for UPDATE. DELETE reports 0 here and its real count in
      // affectedRows, so callers must pick the right one for the statement.
      rowsChanged: res.changedRows,
      changedIsMeaningful: true,
    };
  }

  quoteIdent(name: string): string {
    return '`' + name.replace(/`/g, '``') + '`';
  }

  /**
   * Ask MySQL whether this account may change the allowlisted tables.
   *
   * No savepoints here, unlike Postgres: MySQL leaves a transaction usable after
   * a statement is refused, so each attempt already starts from a clean session.
   * The surrounding transaction is belt and braces — `WHERE 1 = 0` matches
   * nothing, so there is nothing to undo, and the rollback is there in case a
   * future MySQL disagrees with that.
   */
  /**
   * `CURRENT_USER()` is the grantee row privileges are read from — not the name
   * that was sent, the one MySQL matched — and `@@server_uuid` identifies the
   * instance, so two hostnames reaching one server do not read as two servers.
   */
  async identity(): Promise<string> {
    const rows = await this.query<Row>(
      'SELECT CURRENT_USER() AS u, DATABASE() AS d, @@server_uuid AS s',
    );
    const r = rows[0] ?? {};
    return `${String(r['u'])}/${String(r['d'])} on ${String(r['s'])}`;
  }

  async probeDeletable(table: string): Promise<DeleteAbility> {
    return probeDeleteAbility(
      table,
      (n) => this.quoteIdent(n),
      async () => {
        try {
          await this.introspect(table);
          return true;
        } catch {
          return false;
        }
      },
      async (sql): Promise<ProbeOutcome> => {
        try {
          await this.query(sql);
          return 'ok';
        } catch (e) {
          return refusedForPrivilege(e) ? 'denied' : 'unclear';
        }
      },
    );
  }

  async probeWritable(tables: readonly string[]): Promise<WriteAbility> {
    // Never inside a caller's transaction: the rollback below would discard
    // their work. Nothing was established, so say exactly that.
    if (this.inTransaction()) return 'unknown';
    await this.conn.query('START TRANSACTION');
    try {
      return await probeWriteAbility(
        tables,
        async (t) => (await this.introspect(t)).columns.map((c) => c.name),
        (n) => this.quoteIdent(n),
        async (sql): Promise<ProbeOutcome> => {
          try {
            await this.conn.query(sql);
            return 'ok';
          } catch (e) {
            return refusedForPrivilege(e) ? 'denied' : 'unclear';
          }
        },
      );
    } finally {
      await this.conn.query('ROLLBACK').catch(() => {});
    }
  }

  rowLockClause(): string {
    return ' FOR UPDATE';
  }

  async close(): Promise<void> {
    await this.conn.end();
  }
}
