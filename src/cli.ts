#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { assertNotSelfApproval } from './apply.js';
import { planCard } from './card.js';
import { connectionIdentity, loadConfig, type Config, type ConnectionConfig } from './config.js';
import { Refusal } from './refusal.js';
import { openAdminSession, type AdminSession } from './session.js';
import { recordPlan, type PlanStatus } from './store.js';
import { displayReplacer } from './serialize.js';
import { escapeInvisibles } from './show.js';
import { VERSION } from './version.js';

/**
 * `llm-safe-sql` — the human-facing half.
 *
 * This is where approving and applying live, and it is a separate program from
 * the MCP server for a reason that is worth stating plainly: the model has no
 * path to this code. Not a guarded path — no path. The two halves can even run
 * as different operating-system users against different database accounts, and
 * then the separation survives a bug in this library, which is the only kind of
 * separation worth relying on.
 */

const USAGE = `llm-safe-sql ${VERSION} — propose database changes, approve them, apply them.

  llm-safe-sql init                       Print a starter configuration file
  llm-safe-sql check                      Verify the environment and the connections
  llm-safe-sql migrate                    Create the plan and audit tables
  llm-safe-sql read  "<SELECT ...>"       Run a bounded, allowlisted read
  llm-safe-sql plan  "<UPDATE ...>"       Measure a change and save it for approval
  llm-safe-sql list  [--status pending]   Plans waiting, or already dealt with
  llm-safe-sql show <id>                  The confirmation card for one plan
  llm-safe-sql approve <id> --as <who>    Record that a person agreed to it
  llm-safe-sql apply <id> --as <who>      Carry out an approved plan
  llm-safe-sql cancel <id> --as <who> [--reason "..."]

Options
  --config <path>   Defaults to $LLM_SAFE_SQL_CONFIG, then ./llm-safe-sql.config.json
  --as <who>        Who is acting. Defaults to $LLM_SAFE_SQL_ACTOR, then $USER
  --yes             Skip the interactive confirmation (required when not a terminal)
  --limit <n>       Row cap for 'read' and 'list'
  --allow-self-approve
                    Let 'approve' accept the actor who proposed the plan. Off by
                    default: a card read by its own author confirms nothing.

Exit codes: 0 success, 1 refused or failed, 2 wrong usage.
`;

const TEMPLATE = `{
  "//dialect": "mysql | postgres | sqlite. For sqlite, replace connection with {\\"file\\": \\"app.db\\"} — no server and no password. Node 24+.",
  "dialect": "postgres",

  "connection": {
    "host": "127.0.0.1",
    "port": 5432,
    "user": "app_readonly_planner",
    "password": "\${LLM_SAFE_SQL_PASSWORD}",
    "database": "app"
  },

  "//readConnection": "Optional, and the cheapest real win here. Point it at a role with NO write privileges. Reads then stop depending on this library being correct — the allowlist runs in this process holding a credential that can write; a role without the privilege is enforced by the database itself. The dry run cannot use it, because planning really executes the statement before rolling it back.",

  "//applyConnection": "Optional. Point this at a DIFFERENT database user, one the model's tools cannot reach. Then the separation between proposing and committing does not depend on this library being free of bugs.",

  "policy": {
    "allow": ["orders"],
    "impact": {
      "orders": "Changing an order moves money: the ship date decides which month the supplier is paid in."
    },
    "denyIdentifiers": {
      "password_hash": "a stored credential",
      "api_token": "a stored credential"
    },
    "denyWriteColumns": {
      "total_amount": "recalculated by the billing job; editing it here would be overwritten"
    }
  },

  "limits": {
    "maxUpdateRows": 200,
    "maxDeleteRows": 50,
    "maxReadRows": 200,
    "statementMs": 5000,
    "lockMs": 3000
  },

  "//autoColumns": "Columns the database maintains itself, per table. Needed on PostgreSQL where an updated_at trigger is invisible to introspection.",
  "autoColumns": {
    "orders": ["updated_at"]
  }
}
`;

interface Args {
  command: string;
  rest: string[];
  config: string;
  actor: string;
  yes: boolean;
  limit: number | undefined;
  status: PlanStatus | undefined;
  reason: string;
  allowSelfApprove: boolean;
}

function parse(argv: string[]): Args {
  const rest: string[] = [];
  let config = process.env['LLM_SAFE_SQL_CONFIG'] ?? 'llm-safe-sql.config.json';
  let actor = process.env['LLM_SAFE_SQL_ACTOR'] ?? process.env['USER'] ?? process.env['USERNAME'] ?? '';
  let yes = false;
  let limit: number | undefined;
  let status: PlanStatus | undefined;
  let reason = '';
  let allowSelfApprove = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '--config': config = next(); break;
      case '--as': actor = next(); break;
      case '--yes': case '-y': yes = true; break;
      case '--limit': limit = rowCount(next()); break;
      case '--status': status = planStatus(next()); break;
      case '--reason': reason = next(); break;
      case '--allow-self-approve': allowSelfApprove = true; break;
      default: rest.push(a);
    }
  }
  return {
    command: rest[0] ?? '',
    rest: rest.slice(1),
    config,
    actor,
    yes,
    limit,
    status,
    reason,
    allowSelfApprove,
  };
}

class UsageError extends Error {}

const STATUSES: readonly PlanStatus[] = ['pending', 'approved', 'applying', 'applied', 'failed', 'cancelled'];

/**
 * A status this store can actually hold, or a refusal to guess.
 *
 * `--status pendign` used to reach the query as written, match nothing, and
 * print "No plans." — which reads as "there is nothing waiting for you" and is
 * how an approval queue goes unread. A filter nobody can satisfy is a usage
 * error, not an empty result.
 */
function planStatus(raw: string): PlanStatus {
  const v = raw.trim().toLowerCase();
  const found = STATUSES.find((s) => s === v);
  if (found === undefined) {
    throw new UsageError(`--status takes one of: ${STATUSES.join(', ')}. Got "${raw}".`);
  }
  return found;
}

/**
 * A row cap that means something.
 *
 * `--limit abc` became NaN and travelled all the way into the SQL, where it came
 * back as `no such column: NaN` over a stack trace pointing into this library.
 * Zero and negative numbers reached the query too and returned whatever the
 * dialect makes of them.
 */
function rowCount(raw: string): number {
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new UsageError(`--limit takes a whole number of rows, 1 or more. Got "${raw}".`);
  }
  return n;
}

async function confirm(question: string, args: Args): Promise<boolean> {
  if (args.yes) return true;
  if (!process.stdin.isTTY) {
    throw new UsageError(
      'This is not a terminal, so there is nobody to ask. Pass --yes if you really mean it — and if this ' +
        'is running from a script, consider whether an approval nobody sees is an approval at all.',
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = await rl.question(`${question} [type yes to continue] `);
    return a.trim().toLowerCase() === 'yes';
  } finally {
    rl.close();
  }
}

function requireActor(args: Args): string {
  if (args.actor.trim() === '') {
    throw new UsageError('Say who is acting: --as you@example.com (or set LLM_SAFE_SQL_ACTOR).');
  }
  return args.actor;
}

function requireId(args: Args): string {
  const id = args.rest[0];
  if (id === undefined) throw new UsageError('Which plan? Pass its id.');
  return id;
}

async function withSession<T>(cfg: Config, fn: (s: AdminSession) => Promise<T>): Promise<T> {
  const session = await openAdminSession(cfg);
  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}

function out(s: string): void {
  process.stdout.write(`${s}\n`);
}

async function run(args: Args): Promise<number> {
  if (args.command === '' || args.command === 'help' || args.command === '--help') {
    out(USAGE);
    return 0;
  }
  if (args.command === 'version' || args.command === '--version') {
    out(VERSION);
    return 0;
  }
  if (args.command === 'init') {
    process.stdout.write(TEMPLATE);
    return 0;
  }

  const cfg = await loadConfig(args.config);

  switch (args.command) {
    case 'check':
      return withSession(cfg, async (s) => {
        await s.engine.adapter.selfCheck();
        await s.applier.adapter.selfCheck();
        if (s.engine.readIsSeparate) await s.engine.readAdapter.selfCheck('read');
        // The store connection too. It was the one role `check` listed and never
        // verified, while the line below says "Connections are usable" in the
        // plural — and this is the connection the record of an approval lives on,
        // so an environment that cannot keep it is the environment where the
        // audit trail quietly is not one.
        await s.store.adapter.selfCheck();

        // And does the store *exist*, not merely connect? Until 0.4.2 this
        // command verified four connections and never the two tables the whole
        // approval record lives in, so a deployment that had not run `migrate`
        // was told every table was ready and exited 0 — and found out on its
        // first plan, from the driver, after the dry run had already run. It is
        // collected rather than thrown so the operator still gets the full
        // picture below, and reported at the end, where it changes the exit code.
        let storeProblem: string | undefined;
        try {
          await s.store.selfCheck();
        } catch (e) {
          storeProblem = e instanceof Refusal ? e.message : String(e);
        }

        out(`Connections are usable (${cfg.dialect}).`);
        out('  the session is not shared with another caller');
        out('  a rollback really undoes a write');
        out('  "rows affected" means what this library assumes');
        for (const w of s.engine.adapter.limitations) out(`  NOT enforced here: ${w}`);

        // Which guards are enforced by the database, and which only by this
        // process. Everything else this command prints is about whether the
        // library works; this is about whether it matters if it doesn't.
        out('');
        out('Where the guards actually sit');
        const ask = async (a: { identity?: () => Promise<string> }): Promise<string | undefined> => {
          if (a.identity === undefined) return undefined;
          return a.identity().catch(() => undefined);
        };
        const seen = {
          plan: await ask(s.engine.adapter),
          apply: await ask(s.applier.adapter),
          store: await ask(s.store.adapter),
          read: await ask(s.engine.readAdapter),
        };
        const asked = Object.values(seen).every((v) => v !== undefined);

        // Printed as the server reports them, so that this list and the warnings
        // under it are answering the same question. Showing the config strings
        // here while comparing measured ones below would put two different-looking
        // rows above a warning that they are the same account.
        const roles: { name: string; conn: ConnectionConfig; seen: string | undefined; note: string }[] = [
          { name: 'read ', conn: cfg.readConnection ?? cfg.connection, seen: seen.read, note: 'the model reads through this' },
          { name: 'plan ', conn: cfg.connection, seen: seen.plan, note: 'writes for real, always rolls back' },
          { name: 'apply', conn: cfg.applyConnection ?? cfg.connection, seen: seen.apply, note: 'this one commits' },
          { name: 'store', conn: cfg.storeConnection ?? cfg.connection, seen: seen.store, note: 'plans and audit records' },
        ];
        for (const r of roles) out(`  ${r.name}  ${r.seen ?? connectionIdentity(r.conn)}  — ${r.note}`);

        const idOf = (c: ConnectionConfig): string => connectionIdentity(c);

        // Who each of these turned out to be, asked of the server holding the
        // connection rather than read out of the file that opened it. The two are
        // different questions and the difference was reachable: `localhost` and
        // `127.0.0.1` are two spellings of one PostgreSQL role, and this command
        // reported two spellings as two credentials — printing the separation the
        // whole library is built around as present, having measured nothing.
        // Measured on 0.4.5, with both connections answering `current_user =
        // postgres` on one server.
        const plan = seen.plan ?? idOf(cfg.connection);
        const applyId = seen.apply ?? idOf(cfg.applyConnection ?? cfg.connection);
        const storeId = seen.store ?? idOf(cfg.storeConnection ?? cfg.connection);
        const readId = seen.read ?? idOf(cfg.readConnection ?? cfg.connection);
        const warn: string[] = [];
        /** Facts established by asking the database, not by reading the config. */
        const proved: string[] = [];
        if (applyId === plan) {
          warn.push(
            'apply uses the SAME credential as plan. The separation between proposing and committing then ' +
              'rests entirely on this library being correct. Point applyConnection at a different database ' +
              'user and it survives a bug in here.',
          );
        }
        if (readId === plan) {
          warn.push(
            'read uses the SAME credential as plan, so reads run on a connection that can write. The ' +
              'allowlist is then the only thing standing between a read tool and a write — and it runs in ' +
              'this process. Point readConnection at a role with no write privileges.',
          );
        } else {
          // Configuring a different role and configuring a role that cannot
          // write are separate facts, and only the second one is a boundary.
          const ability = await s.engine.readAdapter.probeWritable(cfg.policy.allow);
          if (ability === 'writable') {
            warn.push(
              'readConnection is a different credential, but it CAN write — probed, not assumed. The ' +
                'separation is nominal: nothing below this library is stopping a read path from writing. ' +
                'Revoke INSERT/UPDATE/DELETE from that role.',
            );
          } else if (ability === 'unknown') {
            // Silence used to mean "proved read-only". It must not: the earlier
            // probe answered a different question and reported an ordinary
            // read-write account as constrained, which is this command telling
            // an operator a boundary exists when it does not.
            //
            // The second reason below arrived with 0.4.10. Naming only the first
            // would make this line the same kind of defect it is reporting: a
            // sentence that was true of the code when it was written.
            warn.push(
              'readConnection is a different credential, but whether the database will let it write could ' +
                'not be established — either none of the allowlisted tables were readable on it, or a write ' +
                'was refused for a reason that was not the privilege. Treat the separation as unproven ' +
                'until you check the grants by hand.',
            );
          } else {
            proved.push('read is a credential the database itself refuses writes from — probed on your own tables.');
          }
        }
        if (storeId === applyId) {
          warn.push(
            'store uses the same credential as apply, so whatever can commit a change can also edit the ' +
              'record of it having been approved.',
          );
        } else if (storeId === readId) {
          // Four of the six pairs were compared and two were not. This is the one
          // that matters: the credential the model reads through is also the one
          // that writes the plan and audit records, so anything that reaches the
          // read path reaches the record of what was approved.
          warn.push(
            'store uses the same credential as read, so the account the model reads through is also the one ' +
              'that writes the plan and audit records. Point storeConnection at a database user of its own.',
          );
        } else if (storeId === plan) {
          // Checked separately, because it used not to be checked at all: with
          // `storeConnection` left at the default and a distinct
          // `applyConnection`, the test above passes and this command printed
          // "every role is a distinct credential" about a configuration in which
          // two of them are the same one.
          warn.push(
            'store uses the same credential as plan, so the side that proposes a change can also edit the ' +
              'stored plan it will later be checked against.',
          );
        }
        // Can the account that writes the approval record erase it?
        //
        // The worked examples grant the store account INSERT and no DELETE, and
        // say why: it records that a human approved something and must not be
        // able to unsay it. Nothing verified that the deployment had done it —
        // the property was a sentence in the documentation, which is the same
        // shape as the identity comparison this command was doing until 0.4.6.
        // A trace is only a trace if the party it would implicate cannot edit it.
        const erasable =
          s.store.adapter.probeDeletable === undefined
            ? 'unknown'
            : await s.store.adapter.probeDeletable(s.store.auditTable).catch(() => 'unknown' as const);
        if (erasable === 'cannot-delete') {
          proved.push(
            `the audit record cannot be erased by the account that writes it — the database refused DELETE on \`${s.store.auditTable}\`.`,
          );
        } else if (erasable === 'can-delete' && cfg.dialect === 'sqlite') {
          warn.push(
            `SQLite has no accounts, so whatever writes \`${s.store.auditTable}\` can also erase it and there is no ` +
              'grant to withhold. Backups of the file are the only thing standing between the trail and an edit ' +
              'to it. On MySQL or PostgreSQL this is a revoked privilege instead.',
          );
        } else if (erasable === 'can-delete') {
          warn.push(
            `the store credential can DELETE from \`${s.store.auditTable}\` — probed, not assumed. It writes the ` +
              'record that a human approved something and can erase having written it, so the trail survives only ' +
              'as long as nobody wants it gone. Grant that account INSERT and no DELETE.',
          );
        } else {
          warn.push(
            `whether the store account can erase \`${s.store.auditTable}\` could not be established, so treat the ` +
              'audit trail as editable until you check the grants by hand.',
          );
        }

        // Whether the three comparisons above are facts about the server or facts
        // about a text file. Decided here, with the others, and printed with them:
        // written after the lists had already gone to the terminal, it said nothing
        // at all — which is its own small version of the bug it is reporting.
        if (asked && warn.length === 0) {
          proved.push('the four roles are four different accounts — each connection was asked, not inferred from the file.');
        } else if (!asked) {
          warn.push(
            'whether these are really different accounts could not be established from the server on this ' +
              'dialect, so they were compared as written in the config file. Two spellings of one host are ' +
              'two strings and one account.',
          );
        }

        // Unconditional, and pushed after the check above so that adding it does
        // not silence the "four different accounts" proof by making `warn` never
        // empty. It belongs in this list because the alternative is 0.6.0's
        // self-approval refusal reading as an authorisation boundary — which is
        // the exact failure this whole section exists to prevent, committed by
        // the release that added the guard.
        warn.push(
          '`--as` is taken at its word: nothing here authenticates anybody. So the refusal that stops a ' +
            'proposer approving their own plan catches one identity running both halves — an agent and its ' +
            'operator sharing $USER, which is what a single terminal gives you — and does not catch a person ' +
            'who types a different name. Actor separation is a record, not a boundary. The boundary is ' +
            'applyConnection: a database account the proposing side has no password for.',
        );

        // Whether writing the plan table is enough to rewrite an approved plan.
        //
        // Not answered by any of the identity comparisons above, and this is the
        // reason it is its own line: the store account is *supposed* to write
        // plans, so a deployment can separate all four roles perfectly and still
        // have this wide open. `planDigest` is an exported function over bytes
        // anybody can reconstruct, so whoever holds that credential can swap an
        // approved plan for a different one and compute the checksum to match.
        // Measured on 0.8.0 before the seal existed: the card said `qty = 11`,
        // the committed row said 9999, and every line printed in between said
        // approved. Pushed after the "four different accounts" check above, for
        // the reason the comment there gives.
        if (cfg.sealKey === undefined) {
          warn.push(
            `plans are not sealed, so anything that can write \`${s.store.planTable}\` can replace an approved ` +
              'plan with a different one, recompute its checksum, and the apply will commit what it finds — ' +
              'with the card, the audit row and the approver all still naming the plan that was replaced. It ' +
              'can also set `status` and `approved_by` by hand, so a plan nobody read is applied as an ' +
              'approved one. Set `sealKey` to the same secret on the planning and applying sides, and keep ' +
              'it out of reach of the store account.',
          );
        }

        for (const p of proved) out(`  + ${p}`);
        if (cfg.sealKey !== undefined) {
          // Configured, not probed, and said that way: this command's own rule is
          // that a fact read out of a file is a weaker thing than a fact the
          // server was asked for, and the seal is the first control here that
          // cannot be probed at all from one side.
          out(
            `  + plans and approvals are sealed (configured, not probed) — writing \`${s.store.planTable}\` is no ` +
              'longer enough to change what an approved plan says, or to record an approval that did not happen.',
          );
        }
        for (const w of warn) {
          out('');
          out(`  ! ${w}`);
        }
        out('');
        for (const table of cfg.policy.allow) {
          const shape = await s.engine.adapter.introspect(table);
          const notes: string[] = [];
          if (!shape.transactional) notes.push('NOT TRANSACTIONAL — no dry run is possible here');
          if (shape.primaryKey.length === 0) notes.push('no primary key — writes cannot be planned');
          // Three different situations that all used to print the same sentence,
          // and only one of them is fixed by declaring anything. On MySQL the
          // other two are fixed by a grant, and until 0.5.0 neither was reported
          // at all: the command an operator runs to find out what to declare told
          // them a table with a trigger and an inbound cascade was "ready".
          if (!shape.inboundCascadesKnown) {
            notes.push(
              'this credential cannot see which foreign keys point at it, so writes will be refused — ' +
                'GRANT SELECT ON <schema>.* to the planning and applying roles',
            );
          }
          if (!shape.triggersVisible) {
            notes.push(
              'this credential may not read information_schema.TRIGGERS, so whether it has any is unknown — ' +
                'GRANT TRIGGER ON <schema>.* to the planning and applying roles',
            );
          } else if (!shape.autoColumnsKnown && cfg.autoColumns?.[table] === undefined) {
            notes.push('has triggers and no autoColumns declared — writes will be refused until you declare them');
          }
          const cascades = shape.inboundCascades.filter(
            (c) => c.onDelete === 'CASCADE' || c.onUpdate === 'CASCADE',
          );
          if (cascades.length > 0) {
            notes.push(`cascades into ${cascades.map((c) => c.table).join(', ')} — writes will be refused`);
          }
          out(`  ${table}: ${notes.length === 0 ? 'ready' : notes.join('; ')}`);
        }

        if (storeProblem !== undefined) {
          out('');
          out(`  ! ${storeProblem}`);
          return 1;
        }
        return 0;
      });

    case 'migrate':
      return withSession(cfg, async (s) => {
        await s.store.migrate();
        out(`Created ${s.store.planTable} and ${s.store.auditTable} if they were missing.`);
        return 0;
      });

    case 'read': {
      const sql = args.rest.join(' ');
      if (sql.trim() === '') throw new UsageError('Nothing to read. Pass a SELECT statement.');
      return withSession(cfg, async (s) => {
        const r = await s.engine.read(sql, args.limit === undefined ? {} : { limit: args.limit });
        out(escapeInvisibles(JSON.stringify(r.rows, displayReplacer, 2)));
        out(r.truncated ? `-- TRUNCATED at ${r.rows.length} rows; there are more.` : `-- ${r.rows.length} row(s)`);
        return 0;
      });
    }

    case 'plan': {
      const sql = args.rest.join(' ');
      if (sql.trim() === '') throw new UsageError('Nothing to plan. Pass an UPDATE or DELETE statement.');
      return withSession(cfg, async (s) => {
        const plan = await s.engine.plan(sql);
        const rec = await recordPlan(s.store, plan, requireActor(args), cfg.sealKey);
        out(planCard(rec));
        return 0;
      });
    }

    case 'list':
      return withSession(cfg, async (s) => {
        const plans = await s.store.list({
          ...(args.status === undefined ? {} : { status: args.status }),
          ...(args.limit === undefined ? {} : { limit: args.limit }),
        });
        if (plans.length === 0) {
          out('No plans.');
          return 0;
        }
        for (const p of plans) {
          out(
            `${p.id}  ${p.status.padEnd(9)} ${p.plan.op} ${p.plan.table} ` +
              `(${p.plan.rows.length} row(s))  by ${p.createdBy}  ${p.createdAt}`,
          );
        }
        return 0;
      });

    case 'show':
      return withSession(cfg, async (s) => {
        const rec = await s.store.get(requireId(args));
        if (rec === undefined) {
          out('No plan with that id.');
          return 1;
        }
        out(planCard(rec));
        return 0;
      });

    case 'approve': {
      const id = requireId(args);
      const actor = requireActor(args);
      return withSession(cfg, async (s) => {
        const rec = await s.store.get(id);
        if (rec === undefined) {
          out('No plan with that id.');
          return 1;
        }
        out(planCard(rec));
        out('');
        // Before the prompt, not after it: `approve` enforces this too, but asking
        // first would offer an approval that cannot happen.
        assertNotSelfApproval(rec, actor, { allowSelfApproval: args.allowSelfApprove });
        if (!(await confirm(`Approve this as ${actor}?`, args))) {
          out('Not approved. Nothing has changed.');
          return 1;
        }
        await s.applier.approve(id, actor, { allowSelfApproval: args.allowSelfApprove });
        out(`Approved. Apply it with:  llm-safe-sql apply ${id} --as ${actor}`);
        return 0;
      });
    }

    case 'apply': {
      const id = requireId(args);
      const actor = requireActor(args);
      return withSession(cfg, async (s) => {
        const res = await s.applier.apply(id, actor);
        out(`Applied: ${res.op} on ${res.table}, ${res.rowsAffected} row(s), at ${res.appliedAt}.`);
        for (const w of res.warnings) out(`WARNING: ${w}`);
        // Zero, because the change is committed. This used to exit 1 whenever the
        // apply produced a warning, which told every script and CI step that the
        // write had failed when it had succeeded — and the obvious response to a
        // failed apply is to run it again. A warning is something to read, not a
        // different outcome; the outcome is that the database changed.
        return 0;
      });
    }

    case 'cancel': {
      const id = requireId(args);
      const actor = requireActor(args);
      return withSession(cfg, async (s) => {
        await s.applier.cancel(id, actor, args.reason === '' ? 'no reason given' : args.reason);
        out('Cancelled.');
        return 0;
      });
    }

    default:
      throw new UsageError(`Unknown command: ${args.command}`);
  }
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parse(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`);
    process.exit(2);
  }
  try {
    process.exit(await run(args));
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`${e.message}\n`);
      process.exit(2);
    }
    // A refusal is a decision, not a crash. It gets the reason and nothing else,
    // because a stack trace here would bury the sentence the operator needs.
    if (e instanceof Refusal) {
      process.stderr.write(`Refused (${e.code}): ${e.message}\n`);
      process.exit(1);
    }
    process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exit(1);
  }
}

void main();
