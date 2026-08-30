#!/usr/bin/env node
/**
 * carbon — 控え ("the copy you keep, in case")
 *
 * The part that flies in cruise.
 *
 * Diverging is the half of the work with no safety net. A draft gets rewritten and the version
 * that was there is gone — not in git, because drafts are rarely committed, and not in the
 * agent's memory, because it wrote over its own output. The paragraph you liked went with it.
 *
 * carbon keeps the superseded copy. Only in cruise, only for files git does not already have,
 * and only when something is about to overwrite one.
 *
 * It never speaks. Interrupting a draft is the exact failure the cruise form exists to prevent,
 * so this writes to disk and says nothing.
 */
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, lstatSync,
} from 'node:fs';
import { join, basename, extname, resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { home, sortie, finding, report } from '@hyuga/spar';
import { runDirectly, readStdin } from '@hyuga/spar/cli';

/** Above this, keep the fact and not the body. A draft is prose; something huge is not. */
export const MAX_BYTES = 512 * 1024;

/**
 * Paths that are never copied, whatever mode the machine is in.
 *
 * The list is matched against names, which is a weaker thing than reading the file and deciding
 * — and it is deliberately the weaker thing, because a draft is prose and prose about a
 * password is not a password. What that costs is everything whose name nobody thought of, so
 * the list is written to over-refuse: a whole directory (`.ssh/`, `.aws/`, `.gnupg/`) rather
 * than the files known to sit in it, and the extensions of key material rather than the names
 * particular tools give them.
 */
export const NEVER = [
  /(^|[\\/])\.env(\.|$)/i,
  /(^|[\\/])\.envrc$/i,
  /(^|[\\/])\.?(npmrc|netrc|pgpass|pypirc|htpasswd)$/i,
  /(^|[\\/])\.git-credentials$/i,
  /\.(pem|key|p12|pfx|jks|keystore|ppk|asc|gpg)$/i,
  /(^|[\\/])(secrets?|credentials?|passwords?)([\\/]|[._-]|$)/i,
  /(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)/i,
  /(^|[\\/])\.(ssh|aws|gnupg|kube|docker|azure|config\/gcloud)([\\/]|$)/i,
  /(^|[\\/])(hosts\.yml|auth\.json|wp-config\.php|application_default_credentials\.json)$/i,
  /\.tfstate(\.|$)/i,
  /(^|[\\/])(service[_-]?account|serviceaccount)[^\\/]*\.json$/i,
];

export const store = (cwd = process.cwd()) => join(home(cwd), 'carbon');

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

export function isSensitive(path) {
  return NEVER.some((re) => re.test(String(path)));
}

/**
 * Is this file inside the repository we are flying over?
 *
 * The path arrives in a hook payload, which is to say the agent chose it, and nothing in the
 * hook contract keeps it under the working directory. Without this, an absolute path anywhere
 * on the machine gets copied into `.spar/carbon/` — the exact opposite of a part whose whole
 * job is to not keep what it must not keep. Resolution goes through realpath first, so a link
 * that merely sits inside cannot point out.
 */
export function within(path, cwd = process.cwd()) {
  try {
    const root = realpathSync(resolve(cwd));
    const rel = relative(root, realpathSync(path));
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  } catch {
    return false; // cannot resolve it: then we cannot say it is ours, so we do not keep it
  }
}

/**
 * Does git already have this?
 *
 * The point is to keep what nothing else keeps. A tracked file's previous content is a `git
 * show` away, so copying it would be noise — and the files that actually get lost are the
 * untracked drafts sitting next to the tracked work.
 */
export function tracked(path, cwd = process.cwd()) {
  try {
    const r = spawnSync('git', ['ls-files', '--error-unmatch', '--', path], {
      cwd, stdio: 'ignore', windowsHide: true,
    });
    return r.status === 0;
  } catch {
    return false; // no git here: then nothing else is keeping it either
  }
}

/** The path a hook is about to write to, whatever it called the field. */
export function target(payload) {
  const input = payload?.tool_input || payload?.toolInput || {};
  return input.file_path || input.path || input.notebook_path || '';
}

/**
 * Keep the copy, if this is a moment where something would otherwise be lost.
 *
 * Every condition here is a reason *not* to copy, and each is a different kind of not-lost:
 * strike has git and review behind it, a file that does not exist yet is not being overwritten,
 * a tracked file is already kept, and a secret must never be kept at all.
 */
export function keep(payload, cwd = process.cwd()) {
  const s = sortie(cwd);
  if (s.mode !== 'cruise') return null;

  const path = target(payload);
  if (!path || !existsSync(path)) return null;
  if (isSensitive(path)) return null;
  if (!within(path, cwd)) return null;
  if (isSensitive(realpathSync(path))) return null;
  if (lstatSync(path).isSymbolicLink()) return null;
  if (!statSync(path).isFile()) return null;
  if (tracked(path, cwd)) return null;

  const size = statSync(path).size;
  const dir = store(cwd);
  mkdirSync(dir, { recursive: true });

  const name = basename(path);
  const id = `${stamp()}-${createHash('sha256').update(resolve(path)).digest('hex').slice(0, 8)}`;
  const kept = join(dir, `${id}${extname(name) || '.txt'}`);

  // Bytes, not text. Decoding as UTF-8 and writing the result back is lossless only for files
  // that were UTF-8 to begin with: a png, a pdf or a sqlite file dragged into the store came
  // back out with every invalid byte replaced by U+FFFD. That is the worst thing a part like
  // this can do — the copy is there, `carbon list` shows it, and it does not restore.
  const body = size <= MAX_BYTES ? readFileSync(path) : null;
  if (body === null) {
    writeFileSync(kept, `carbon: ${name} was ${size} bytes, too large to keep. Only this note is.\n`);
  } else {
    writeFileSync(kept, body);
  }

  report(finding({
    phase: 'post',
    source: 'carbon',
    subject: path,
    observed: 'superseded',
    mode: 'cruise',
    actor: 'human',
    note: `kept as ${basename(kept)}${body === null ? ' (note only)' : ''}`,
  }), cwd);

  return kept;
}

export function list(cwd = process.cwd()) {
  const dir = store(cwd);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().map((f) => ({ id: f, path: join(dir, f), size: statSync(join(dir, f)).size }));
}

// ---------------- CLI ----------------

export function main(argv) {
  const [cmd, sub] = argv;

  if (cmd === 'hook' && sub === 'pre') {
    const raw = readStdin();
    if (!raw.trim()) return 0;
    try { keep(JSON.parse(raw)); } catch { /* a draft must never be lost to a hook that threw */ }
    return 0; // silent by design: nothing interrupts a cruise
  }

  if (cmd === 'list') {
    const all = list();
    if (!all.length) {
      console.log('carbon: nothing kept yet.');
      console.log('It keeps a copy when something overwrites an untracked file in cruise.');
      return 0;
    }
    for (const k of all) console.log(`${k.id}  ${String(k.size).padStart(7)} bytes`);
    return 0;
  }

  if (cmd === 'show') {
    const hit = list().find((k) => k.id.startsWith(sub || ''));
    if (!hit) { console.error('carbon: no such copy'); return 1; }
    process.stdout.write(readFileSync(hit.path)); // bytes, so `carbon show x > x.png` restores
    return 0;
  }

  console.log(`carbon — 控え. Keeps the draft that was about to be written over.

  carbon list         what has been kept this repository
  carbon show <id>    print one of them

  Install as a hook, in settings.json:

    "PreToolUse": [{ "matcher": "Write|Edit", "hooks": [
      { "type": "command", "command": "npx @hyuga/carbon hook pre", "timeout": 10 }]}]

  It only acts in cruise ("airframe mode cruise"), only on files git does not already have, and
  never on anything that looks like a credential. It prints nothing, ever — interrupting a
  draft is the failure the cruise form exists to prevent.

  Copies live beside the ledger, in .spar/carbon/.
`);
  return 0;
}

if (runDirectly(import.meta.url)) process.exit(main(process.argv.slice(2)));
