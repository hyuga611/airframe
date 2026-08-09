import { readFile } from 'node:fs/promises';
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

export interface ConnectionConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
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
  readonly policy: PolicyOptions;
  readonly limits?: LimitsConfig;
  readonly autoColumns?: Readonly<Record<string, readonly string[]>>;
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

function connectionOf(raw: unknown, path: string): ConnectionConfig {
  if (raw === null || typeof raw !== 'object') {
    throw new ConfigError(`${path} must be an object with host, port, user, password and database.`);
  }
  const o = raw as Record<string, unknown>;
  for (const k of ['host', 'user', 'database']) {
    if (typeof o[k] !== 'string' || o[k] === '') throw new ConfigError(`${path}.${k} must be a non-empty string.`);
  }
  const port = Number(o['port']);
  if (!Number.isInteger(port) || port <= 0) throw new ConfigError(`${path}.port must be a port number.`);
  return {
    host: String(o['host']),
    port,
    user: String(o['user']),
    password: String(o['password'] ?? ''),
    database: String(o['database']),
  };
}

export function parseConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env): Config {
  const cfg = expand(raw, 'config', env) as Record<string, unknown>;

  const dialect = cfg['dialect'];
  if (dialect !== 'mysql' && dialect !== 'postgres') {
    throw new ConfigError('config.dialect must be "mysql" or "postgres".');
  }

  const connection = connectionOf(cfg['connection'], 'config.connection');

  const p = (cfg['policy'] ?? {}) as Record<string, unknown>;
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
      : { applyConnection: connectionOf(cfg['applyConnection'], 'config.applyConnection') }),
    ...(cfg['storeConnection'] === undefined
      ? {}
      : { storeConnection: connectionOf(cfg['storeConnection'], 'config.storeConnection') }),
    policy,
    ...(cfg['limits'] === undefined ? {} : { limits: cfg['limits'] as LimitsConfig }),
    ...(cfg['autoColumns'] === undefined
      ? {}
      : { autoColumns: cfg['autoColumns'] as Record<string, string[]> }),
  };
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
  return parseConfig(raw, env);
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
    if (dialect === 'mysql') {
      const { MysqlAdapter } = await import('./adapters/mysql.js');
      return await MysqlAdapter.connect(conn);
    }
    const { PostgresAdapter } = await import('./adapters/postgres.js');
    return await PostgresAdapter.connect(conn);
  } catch (e) {
    const driver = dialect === 'mysql' ? 'mysql2' : 'pg';
    if (String(e).includes('ERR_MODULE_NOT_FOUND') || String(e).includes(`Cannot find package '${driver}'`)) {
      throw new ConfigError(`The ${driver} driver is not installed. Run: npm install ${driver}`);
    }
    throw e;
  }
}
