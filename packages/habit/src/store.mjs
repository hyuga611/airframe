/**
 * Where habit keeps what it knows, and the three-line helpers everything else needs.
 *
 * One module owns the layout of the store and the identity of a file inside it — the paths, the
 * caps, the hash a path is filed under, and the id a record gets. Those are the decisions that
 * cannot be made twice: a second opinion about how a path becomes a key is a correction filed
 * where nothing will look for it.
 *
 * STORE is read once, at load, and every other module imports this binding rather than reading
 * the environment again. That is what makes a test able to point one process at a store of its
 * own by setting HABIT_HOME before the first import.
 */
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';


export const STORE = process.env.HABIT_HOME || join(homedir(), '.claude', 'habit');
export const ARTIFACTS = () => join(STORE, 'artifacts');
export const CORRECTIONS = () => join(STORE, 'corrections');
export const SIGNALS = () => join(STORE, 'signals');
export const RULES = () => join(STORE, 'rules.json');
export const SAID = () => join(STORE, 'said.json');

export const MAX_BYTES = 512 * 1024; // above this, keep the hash but not the contents
export const MAX_LINES = 40;         // how many changed lines a correction keeps
export const MAX_LINE = 400;         // and how much of each one
export const EDIT_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit)$/;

export const sha = (s) => createHash('sha256').update(s).digest('hex');
export const keyOf = (p) => sha(resolve(p).toLowerCase()).slice(0, 32);
export const nowIso = () => new Date().toISOString();

/**
 * A filename stem that sorts by time and cannot collide.
 *
 * The timestamp is milliseconds, and two records can land inside one — an agent writing three
 * files from a single instruction, a denial and a failure arriving together, two subagents in
 * separate processes. Same name meant one silently overwrote the other, which is a lost
 * correction that nothing would ever report. Found on Linux CI, where everything is fast enough
 * to actually hit; on Windows the clock and the disk hid it.
 *
 * The random tail only breaks ties. The timestamp stays the prefix, so ordering by filename
 * still means ordering by time, and existing ids keep working — they are only ever compared
 * for equality.
 */
export const stamp = () => `${nowIso().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`;

export function ensure(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** Pull the target file path out of a hook payload. */
export function filePathOf(payload) {
  const p = payload?.tool_input?.file_path ?? payload?.tool_input?.notebook_path;
  return typeof p === 'string' && p.trim() ? p : null;
}

export function loadRecord(file) {
  const f = join(ARTIFACTS(), keyOf(file) + '.json');
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}

export function saveRecord(file, rec) {
  ensure(ARTIFACTS());
  writeFileSync(join(ARTIFACTS(), keyOf(file) + '.json'), JSON.stringify(rec), 'utf8');
}

export function readFileSafe(file) {
  try {
    const st = statSync(file);
    if (st.size > MAX_BYTES) return { tooBig: true, text: null, hash: null, size: st.size };
    const text = readFileSync(file, 'utf8');
    return { tooBig: false, text, hash: sha(text), size: st.size };
  } catch {
    return null;
  }
}
