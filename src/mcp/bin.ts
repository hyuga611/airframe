#!/usr/bin/env node
import { loadConfig } from '../config.js';
import { recordPlan } from '../store.js';
import { openReadSession, type ReadSession } from '../session.js';
import { McpServer, serveStdio, type McpTools } from './server.js';
import { VERSION } from '../version.js';

/**
 * `llm-safe-sql-mcp` — the model-facing half.
 *
 * It can read allowlisted tables and it can propose a change. It holds no object
 * capable of committing one: the apply path needs an {@link Applier}, and this
 * process never constructs one. That is a stronger statement than "the apply tool
 * is not registered", and it is the statement worth being able to make, because
 * everything reachable from here is also reachable by prompt injection.
 */

const USAGE = `llm-safe-sql-mcp — expose a database to an assistant, read-only plus proposals.

  llm-safe-sql-mcp [--config <path>]

  --config <path>   Configuration file. Defaults to $LLM_SAFE_SQL_CONFIG,
                    then ./llm-safe-sql.config.json

Speaks MCP over stdio. Diagnostics go to stderr; stdout is the protocol.
`;

function configPath(argv: string[]): string {
  const i = argv.indexOf('--config');
  if (i >= 0) {
    const p = argv[i + 1];
    if (p === undefined) throw new Error('--config needs a path');
    return p;
  }
  return process.env['LLM_SAFE_SQL_CONFIG'] ?? 'llm-safe-sql.config.json';
}

/** A short description of what is open, so the model does not have to guess column names. */
async function describe(session: ReadSession): Promise<string> {
  const lines: string[] = ['Tables this connection may touch:', ''];
  for (const table of session.cfg.policy.allow) {
    const impact = session.cfg.policy.impact?.[table] ?? '';
    lines.push(`${table} — ${impact}`);
    try {
      const shape = await session.engine.adapter.introspect(table);
      lines.push(`  primary key: ${shape.primaryKey.join(', ') || '(none — writes are impossible here)'}`);
      lines.push(`  columns: ${shape.columns.map((c) => `${c.name} ${c.type}${c.nullable ? '' : ' NOT NULL'}`).join(', ')}`);
      if (shape.triggerCount > 0) lines.push(`  ${shape.triggerCount} trigger(s): some columns may move by themselves`);
    } catch (e) {
      lines.push(`  (could not be inspected: ${e instanceof Error ? e.message : String(e)})`);
    }
    lines.push('');
  }
  const denied = Object.keys(session.cfg.policy.denyIdentifiers ?? {});
  if (denied.length > 0) {
    lines.push(`Refused wherever they are mentioned: ${denied.join(', ')}`);
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return;
  }
  if (argv.includes('--version')) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  const cfg = await loadConfig(configPath(argv));

  // Connections are opened lazily so a database that is down produces a clear
  // error on the first tool call, rather than a server that refuses to start and
  // shows up in the client as "failed to connect" with nothing to read.
  let session: ReadSession | undefined;
  const open = async (): Promise<ReadSession> => {
    session ??= await openReadSession(cfg);
    return session;
  };

  const tools: McpTools = {
    async read(sql, limit) {
      const s = await open();
      return s.engine.read(sql, limit === undefined ? {} : { limit });
    },
    async plan(sql) {
      const s = await open();
      const plan = await s.engine.plan(sql);
      return recordPlan(s.store, plan, 'assistant');
    },
    async status(id) {
      const s = await open();
      return s.store.get(id);
    },
    async describe() {
      return describe(await open());
    },
  };

  const server = new McpServer(tools, { name: 'llm-safe-sql', version: VERSION });
  serveStdio(server);

  process.stderr.write(`llm-safe-sql ${VERSION} — ${cfg.dialect}, ${cfg.policy.allow.length} table(s) allowed\n`);

  const shutdown = (): void => {
    void session?.close().finally(() => process.exit(0));
    if (session === undefined) process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
