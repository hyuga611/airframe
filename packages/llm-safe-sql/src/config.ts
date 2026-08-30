import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { Adapter } from './adapter.js';
import type { Dialect } from './lexer.js';
import { Policy, type PolicyOptions } from './policy.js';
import { Refusal } from './refusal.js';

/**
 * One JSON file describing what this deployment is allowed to touch.
 *
 * The alternative — configuring the allowlist and the impact statements in code
 * — sounds tidier and is worse in practice: the person who knows that changing
 * `invoices.status` decides when a supplier gets paid is not usually the person
 * who deploys. A file they can read, review and put under version control is the
 * thing that gets this right, and a diff on it is a meaningful thing to approve.
 *
 * Secrets are not in it. Any string may contain `${VAR}` and is filled in from
 * the environment at load time, so the file itself stays safe to commit.
 */

export class ConfigError extends Refusal {
  constructor(message: string) {
    super('CONFIG_INVALID', message);
  }
}

export interface ServerConnectionConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
  /**
   * PostgreSQL only: the schema unqualified table names resolve against.
   * Defaults to `public`, and is pinned on the connection rather than inherited.
   *
   * PostgreSQL's own default is `"$user", public`, which resolves differently for
   * every role — so with the plan and the apply on different roles, as this
   * library recommends, the same statement can measure one table and write
   * another. Set this when your tables do not live in `public`.
   */
  readonly schema?: string;
}

/**
 * A SQLite database is a file, so there is no credential to separate.
 *
 * That matters for the plan/apply split this library is built around. On MySQL
 * and Postgres you point `applyConnection` at a different database user and the
 * separation stops depending on this library being correct. Here the equivalent
 * is `readOnly`: the model side opens the file read-only and SQLite itself
 * refuses every write on that handle, whatever the policy layer does or fails to
 * do. It is a weaker boundary than a separate credential — the process can still
 * open a second, writable handle — but it is enforced by the engine rather than
 * by us, which is more than a shared credential gives you.
 */
export interface SqliteConnectionConfig {
  readonly file: string;
  readonly readOnly?: boolean;
}

export type ConnectionConfig = ServerConnectionConfig | SqliteConnectionConfig;

export function isSqliteConnection(c: ConnectionConfig): c is SqliteConnectionConfig {
  return typeof (c as SqliteConnectionConfig).file === 'string';
}

/**
 * How this connection would appear to the database, with no secret in it.
 *
 * Used to answer one question the operator cannot otherwise check: are the
 * connections this deployment separates actually different credentials? Two
 * config blocks that differ only in whitespace look like a boundary in the
 * config file and are none, and nothing else in the system will ever say so.
 * The password is deliberately not part of it — two entries with the same user
 * and different passwords are the same identity to the database's audit log.
 */
export function connectionIdentity(c: ConnectionConfig): string {
  if (isSqliteConnection(c)) return `file:${c.file}${c.readOnly === true ? ' (read-only)' : ''}`;
  // The schema is part of the identity, not decoration: two connections that
  // differ only by it resolve every unqualified table name to different tables,
  // and `check` exists to show exactly that kind of difference.
  const schema = c.schema === undefined || c.schema === 'public' ? '' : ` schema=${c.schema}`;
  return `${c.user}@${c.host}:${String(c.port)}/${c.database}${schema}`;
}

export interface LimitsConfig {
  readonly maxUpdateRows?: number;
  readonly maxDeleteRows?: number;
  readonly maxReadRows?: number;
  readonly statementMs?: number;
  readonly lockMs?: number;
}

export interface Config {
  readonly dialect: Dialect;
  /** The connection used for reads and dry runs. Should be able to write, but never commits. */
  readonly connection: ConnectionConfig;
  /**
   * The connection used to apply approved plans. Defaults to `connection`.
   *
   * Point it at a different database user, and the separation this library is
   * built around stops depending on this library being correct: the credential
   * the model's tools can reach is then not the credential that can commit.
   */
  readonly applyConnection?: ConnectionConfig;
  /** Where plans and audit records live. Defaults to `connection`. Must not be the apply connection's session. */
  readonly storeConnection?: ConnectionConfig;
  /**
   * The connection used for reads. Defaults to `connection`.
   *
   * Point it at a role the database will not let write, and the read path stops
   * depending on this library being correct. That matters more than it sounds:
   * the allowlist and the secret-column check run in this process holding a
   * credential that can write, so they are guards a bug can get past. A role
   * without write privileges is enforced by the database, below us.
   *
   * The dry run deliberately cannot use this connection — planning executes the
   * statement for real before rolling it back — which is why it is a separate
   * setting rather than a flag on `connection`.
   */
  readonly readConnection?: ConnectionConfig;
  readonly policy: PolicyOptions;
  readonly limits?: LimitsConfig;
  readonly autoColumns?: Readonly<Record<string, readonly string[]>>;
  /**
   * A secret that seals each plan against whoever holds the store credential.
   *
   * Write it as `"${LLM_SAFE_SQL_SEAL_KEY}"` — like every other secret here, the
   * file itself stays committable and the value arrives from the environment.
   *
   * Without it, `planDigest` is the only tamper check on a stored plan, and it is
   * a checksum over public bytes: anything that can write the plan table can
   * replace an approved plan with a different one and recompute it, and the apply
   * will commit what it finds. With it, that party would also need this value.
   *
   * It has to be the same on the process that plans and the process that applies,
   * and it must not be readable from the store account. Set on one side only,
   * every plan is refused — deliberately, because the alternative is a deployment
   * that believes it is sealing and is not.
   */
  readonly sealKey?: string;
}

/**
 * A key this library does not recognise is a mistake, and refusing it is the only
 * way the author finds out.
 *
 * This reasoning was already written down for the connection object. It was not
 * applied to `policy`, which is where the security controls live, and the
 * consequence was measured: `denyIdentifers` — one letter short of
 * `denyIdentifiers` — parsed, loaded and ran, and an UPDATE to `password_hash`
 * was planned and displayed as an ordinary change. The denylist was simply not
 * there, and no line of output said so.
 *
 * A key beginning with `//` is a comment. The template and the worked examples
 * are written that way, JSON having no comments of its own.
 */
function rejectUnknown(o: Record<string, unknown>, known: readonly string[], path: string): void {
  const unknown = Object.keys(o).filter((k) => !k.startsWith('//') && !known.includes(k));
  if (unknown.length === 0) return;
  const near = (k: string): string => {
    const hit = known.find((v) => v.toLowerCase() === k.toLowerCase() || close(v, k));
    return hit === undefined ? '' : ` (did you mean "${hit}"?)`;
  };
  const list = unknown.map((k) => `"${k}"${near(k)}`).join(', ');
  throw new ConfigError(
    `${path} has ${list}, which this library does not know. ` +
      `Valid keys are: ${known.join(', ')}. ` +
      'A misspelled key would otherwise be ignored silently, and a control nobody notices is missing is ' +
      'worse than one nobody configured.',
  );
}

/** Within one edit of each other: a dropped letter, a swap, a typed extra. */
function close(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  const [x, y] = a.length >= b.length ? [a.toLowerCase(), b.toLowerCase()] : [b.toLowerCase(), a.toLowerCase()];
  let i = 0;
  let j = 0;
  let slips = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      i += 1;
      j += 1;
      continue;
    }
    slips += 1;
    if (slips > 1) return false;
    i += 1;
    if (x.length === y.length) j += 1;
  }
  return slips + (x.length - i) + (y.length - j) <= 1;
}

/** Fill `${VAR}` from the environment, everywhere, and say which one is missing. */
function expand(value: unknown, path: string, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
      const got = env[name];
      if (got === undefined) {
        throw new ConfigError(
          `${path} refers to \${${name}}, but that environment variable is not set. ` +
            'Set it, or replace the reference with a literal value.',
        );
      }
      return got;
    });
  }
  if (Array.isArray(value)) return value.map((v, i) => expand(v, `${path}[${i}]`, env));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = expand(v, `${path}.${k}`, env);
    }
    return out;
  }
  return value;
}

function connectionOf(raw: unknown, path: string, dialect: Dialect): ConnectionConfig {
  if (raw === null || typeof raw !== 'object') {
    throw new ConfigError(
      dialect === 'sqlite'
        ? `${path} must be an object with a file path, e.g. {"file": "./app.db"}.`
        : `${path} must be an object with host, port, user, password and database.`,
    );
  }
  const o = raw as Record<string, unknown>;

  if (dialect === 'sqlite') {
    if (typeof o['file'] !== 'string' || o['file'] === '') {
      throw new ConfigError(`${path}.file must be a path to a SQLite database file.`);
    }
    // ':memory:' is refused rather than quietly accepted. Each connection gets its
    // own private in-memory database, so the plan written by one process would be
    // invisible to the process approving it — every plan would come back "not
    // found", with nothing to suggest why.
    if (o['file'] === ':memory:') {
      throw new ConfigError(
        `${path}.file cannot be ":memory:". An in-memory database is private to a single connection, so a ` +
          'plan created here could never be read back by the process that applies it. Use a file path.',
      );
    }
    return {
      file: String(o['file']),
      ...(o['readOnly'] === undefined ? {} : { readOnly: Boolean(o['readOnly']) }),
    };
  }

  for (const k of ['host', 'user', 'database']) {
    if (typeof o[k] !== 'string' || o[k] === '') throw new ConfigError(`${path}.${k} must be a non-empty string.`);
  }
  const port = Number(o['port']);
  if (!Number.isInteger(port) || port <= 0) throw new ConfigError(`${path}.port must be a port number.`);
  // `schema` is copied through, not dropped. It was dropped in the change that
  // introduced it, which made the whole setting inert from a config file: the
  // adapter fell back to `public` on every connection, and `connectionIdentity`
  // — which reports two roles as separated partly by schema — compared two
  // objects that no longer had one. An unknown key is refused rather than
  // ignored, for the same reason: a typo in a security-relevant setting must not
  // read as "not configured".
  rejectUnknown(o, ['host', 'port', 'user', 'password', 'database', 'schema'], path);
  if (o['schema'] !== undefined && (typeof o['schema'] !== 'string' || o['schema'] === '')) {
    throw new ConfigError(`${path}.schema must be a schema name.`);
  }
  return {
    host: String(o['host']),
    port,
    user: String(o['user']),
    password: String(o['password'] ?? ''),
    database: String(o['database']),
    ...(o['schema'] === undefined ? {} : { schema: String(o['schema']) }),
  };
}

/**
 * Limits, checked rather than cast.
 *
 * `cfg['limits'] as LimitsConfig` believed whatever was in the file. A row cap
 * written as a string compares against a row count by coercion, and a cap of
 * `"20"` or `0` is not the cap anyone thought they had set.
 */
function limitsOf(raw: unknown): LimitsConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('config.limits must be an object of caps, e.g. {"maxUpdateRows": 200}.');
  }
  const o = raw as Record<string, unknown>;
  const known = ['maxUpdateRows', 'maxDeleteRows', 'maxReadRows', 'statementMs', 'lockMs'] as const;
  rejectUnknown(o, known, 'config.limits');
  const out: Record<string, number> = {};
  for (const k of known) {
    if (o[k] === undefined) continue;
    const n = o[k];
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1) {
      throw new ConfigError(`config.limits.${k} must be a whole number, 1 or more. Got ${JSON.stringify(n)}.`);
    }
    out[k] = n;
  }
  return out as LimitsConfig;
}

export function parseConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env): Config {
  const cfg = expand(raw, 'config', env) as Record<string, unknown>;

  rejectUnknown(
    cfg,
    [
      'dialect',
      'connection',
      'readConnection',
      'applyConnection',
      'storeConnection',
      'policy',
      'limits',
      'autoColumns',
      'sealKey',
    ],
    'config',
  );

  const dialect = cfg['dialect'];
  if (dialect !== 'mysql' && dialect !== 'postgres' && dialect !== 'sqlite') {
    throw new ConfigError('config.dialect must be "mysql", "postgres" or "sqlite".');
  }

  const connection = connectionOf(cfg['connection'], 'config.connection', dialect);

  const p = (cfg['policy'] ?? {}) as Record<string, unknown>;
  rejectUnknown(p, ['allow', 'impact', 'denyIdentifiers', 'denyWriteColumns', 'planTable', 'auditTable'], 'config.policy');
  const allow = p['allow'];
  if (!Array.isArray(allow) || allow.length === 0 || allow.some((x) => typeof x !== 'string')) {
    throw new ConfigError(
      'config.policy.allow must list the tables this deployment may touch. It is empty by design: ' +
        'nothing is reachable until you name it.',
    );
  }
  const impact = (p['impact'] ?? {}) as Record<string, string>;
  const missing = (allow as string[]).filter((t) => typeof impact[t] !== 'string' || impact[t] === '');
  if (missing.length > 0) {
    throw new ConfigError(
      `config.policy.impact has no entry for ${missing.join(', ')}. Write one sentence per table saying what ` +
        'changing it means in business terms. It is the sentence the person approving a change actually reads: ' +
        'without it they are being shown a list of column names and asked to judge it, which they cannot do.',
    );
  }

  const policy: PolicyOptions = {
    allow: allow as string[],
    impact,
    ...(p['denyIdentifiers'] === undefined ? {} : { denyIdentifiers: p['denyIdentifiers'] as Record<string, string> }),
    ...(p['denyWriteColumns'] === undefined
      ? {}
      : { denyWriteColumns: p['denyWriteColumns'] as Record<string, string> }),
    ...(p['planTable'] === undefined ? {} : { planTable: String(p['planTable']) }),
    ...(p['auditTable'] === undefined ? {} : { auditTable: String(p['auditTable']) }),
  };

  return {
    dialect,
    connection,
    ...(cfg['applyConnection'] === undefined
      ? {}
      : { applyConnection: connectionOf(cfg['applyConnection'], 'config.applyConnection', dialect) }),
    ...(cfg['storeConnection'] === undefined
      ? {}
      : { storeConnection: connectionOf(cfg['storeConnection'], 'config.storeConnection', dialect) }),
    ...(cfg['readConnection'] === undefined
      ? {}
      : { readConnection: connectionOf(cfg['readConnection'], 'config.readConnection', dialect) }),
    policy,
    ...(cfg['limits'] === undefined ? {} : { limits: limitsOf(cfg['limits']) }),
    ...(cfg['autoColumns'] === undefined
      ? {}
      : { autoColumns: cfg['autoColumns'] as Record<string, string[]> }),
    ...(cfg['sealKey'] === undefined ? {} : { sealKey: sealKeyOf(cfg['sealKey']) }),
  };
}

/**
 * A short key is worse than none: it reads as a control in the config file and in
 * `check`, and it is the one setting whose whole value is that guessing it is not
 * worth trying. Refused rather than warned about, because a warning printed at
 * startup is a warning nobody sees again.
 */
function sealKeyOf(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ConfigError(
      'config.sealKey must be a non-empty string, normally "${LLM_SAFE_SQL_SEAL_KEY}". Remove the key ' +
        'entirely to run without sealing.',
    );
  }
  if (raw.length < 32) {
    throw new ConfigError(
      `config.sealKey is ${String(raw.length)} characters. It is the one secret standing between somebody ` +
        'who can write the plan table and an approved-looking plan of their own, so it must be at least 32. ' +
        'Generate one with: node -e "console.log(crypto.randomBytes(32).toString(\'hex\'))"',
    );
  }
  return raw;
}

export async function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): Promise<Config> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    throw new ConfigError(`Could not read the config file at ${path}: ${String(e)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`${path} is not valid JSON: ${String(e)}`);
  }
  return resolveFiles(parseConfig(raw, env), dirname(resolve(path)));
}

/**
 * Make every SQLite path mean the same database wherever the command is run from.
 *
 * A relative `"file"` used to be resolved against the process's working
 * directory, so `llm-safe-sql apply` from one directory and the MCP server
 * started from another pointed at two different files — and SQLite creates a
 * missing one rather than complaining, so the second was an empty database that
 * answered every question about the first perfectly quietly. Relative to the
 * config file is the only reading under which the same config always names the
 * same database.
 */
function resolveFiles(cfg: Config, base: string): Config {
  const fix = <T extends ConnectionConfig | undefined>(c: T): T =>
    c !== undefined && isSqliteConnection(c) && !isAbsolute(c.file) ? ({ ...c, file: resolve(base, c.file) } as T) : c;
  return {
    ...cfg,
    connection: fix(cfg.connection),
    ...(cfg.readConnection === undefined ? {} : { readConnection: fix(cfg.readConnection) }),
    ...(cfg.applyConnection === undefined ? {} : { applyConnection: fix(cfg.applyConnection) }),
    ...(cfg.storeConnection === undefined ? {} : { storeConnection: fix(cfg.storeConnection) }),
  };
}

export function policyOf(cfg: Config): Policy {
  return new Policy(cfg.policy);
}

/**
 * Load the driver on demand.
 *
 * Static imports of both drivers would make a Postgres-only installation fail at
 * import time because `mysql2` is not there — for a package the user is
 * installing precisely to be careful with, that is a bad first impression and an
 * unnecessary one.
 */
export async function connectAdapter(dialect: Dialect, conn: ConnectionConfig): Promise<Adapter> {
  try {
    if (dialect === 'sqlite') {
      if (!isSqliteConnection(conn)) {
        throw new ConfigError('A sqlite connection needs a "file" path, not host/port/user.');
      }
      const { SqliteAdapter } = await import('./adapters/sqlite.js');
      return SqliteAdapter.connect(conn);
    }
    if (isSqliteConnection(conn)) {
      throw new ConfigError(`A ${dialect} connection needs host, port, user, password and database — not "file".`);
    }
    if (dialect === 'mysql') {
      const { MysqlAdapter } = await import('./adapters/mysql.js');
      return await MysqlAdapter.connect(conn);
    }
    const { PostgresAdapter } = await import('./adapters/postgres.js');
    return await PostgresAdapter.connect(conn);
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    const missing = missingPackage(e);
    if (missing !== undefined) {
      throw new ConfigError(`The ${missing} driver is not installed. Run: npm install ${missing}`);
    }
    throw e;
  }
}

/**
 * The package Node could not find, taken from the error rather than guessed.
 *
 * This used to infer the name from the dialect — `mysql` meant `mysql2`, and
 * anything else meant `pg` — which is right only while the guess and the reality
 * agree. They stopped agreeing when the Postgres adapter imported a shared error
 * class from the MySQL adapter: loading Postgres then loaded `mysql2`, and a
 * Postgres-only install was told *"The pg driver is not installed"* with `pg`
 * sitting in `node_modules`. Reading the name out of the error cannot drift from
 * what actually failed, and if the specifier is unrecognisable the original
 * error is rethrown rather than replaced with a confident wrong one.
 */
function missingPackage(e: unknown): string | undefined {
  const msg = String((e as { message?: unknown })?.message ?? e);
  if (!msg.includes('ERR_MODULE_NOT_FOUND') && !msg.includes('Cannot find package')) return undefined;
  const named = /Cannot find package '([^']+)'/.exec(msg) ?? /Cannot find module '([^']+)'/.exec(msg);
  const spec = named?.[1];
  if (spec === undefined) return undefined;
  // Only report a bare package name. A relative specifier means one of our own
  // files is missing, which is a broken install, not a driver the user forgot.
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('file:')) return undefined;
  return spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : (spec.split('/')[0] as string);
}
