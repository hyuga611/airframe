/**
 * What narai is not allowed to keep.
 *
 * This is the whole of that policy, in one file, on purpose. Everything else here decides
 * *when* to record something; this decides *whether* it may be written down at all, and a
 * reader auditing the tool should be able to answer "what does it store about me?" without
 * reading the hook logic around it. It depends on nothing inside narai, so it can also be
 * read, tested and argued with on its own.
 *
 * Every rule below fails toward keeping less: when a check is uncertain, the contents are
 * dropped and only the hash survives. Detecting *that* a file changed never needs the text.
 */
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';

// Paths whose contents are never stored. It costs the diff, which is a far better trade
// than accumulating secrets on disk — detecting *that* something changed only needs the hash.
export const NEVER_STORE = [
  /(^|[/\\])\.env(\.|$)/i,
  /(^|[/\\])\.npmrc$/i,
  /(^|[/\\])\.netrc$/i,
  /(^|[/\\])id_(rsa|dsa|ecdsa|ed25519)/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
];

/**
 * A path segment that *is* named for a credential, rather than merely containing the letters.
 *
 * This used to be a bare substring test over the whole path, which excluded far more than it
 * meant to: `tokenlint/`, `tokenizer.js`, `TokenList.tsx`, `secretary/`. A directory caught by
 * it took everything underneath with it, so narai went silent across a whole repository and
 * said nothing about why — the failure looks exactly like the tool working and finding nothing.
 *
 * Testing each segment with a boundary keeps `secrets.yml`, `API_KEY.txt` and `config/secrets/`
 * while letting a word that merely starts the same through. The trade is real and deliberate:
 * a file called `mytokenstore.json` is now stored where it was not before. A name that is the
 * word is a signal; a name that contains the letters is a coincidence.
 */
export const CREDENTIAL_NAME =
  /(^|[^a-z0-9])(secrets?|credentials?|passwords?|passphrases?|tokens?|apikey|api[_-]?key|auth[_-]?token|private[_-]?key)([^a-z0-9]|$)/i;

/** Is any segment of this path named for a credential? */
export function namedForCredential(file) {
  return String(file).split(/[/\\]+/).some((seg) => seg && CREDENTIAL_NAME.test(seg));
}

/**
 * Text that must not reach the disk, wherever it came from.
 *
 * `NEVER_STORE` judges a path, which covers a file named for a credential and nothing else.
 * Two things narai keeps are not files: the sentence you typed (`askedFor`, taken from the
 * transcript) and the text of a failed call. Paste a key into the chat and the path rules
 * never see it. These patterns match the *shape* of a credential in free text, so they apply
 * to both.
 *
 * Matching the shape means false positives — a sentence that merely discusses a password can
 * be dropped. That is the right way to be wrong: the diff survives either way, and the worst
 * case is one weaker piece of evidence rather than a live secret sitting in a JSON file.
 */
export const SECRET_TEXT = [
  /\b(sk|sk-ant|sk-proj)-[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/,
  /\bAKIA[0-9A-Z]{12,}/,
  /\bBearer\s+[A-Za-z0-9._-]{12,}/i,
  /\b(password|passwd|pwd)\s*[:=]\s*\S{4,}/i,
  /(パスワード|合言葉)\s*[:=は＝]\s*\S{4,}/,
  /\b(api[_-]?key|apikey|access[_-]?token|auth[_-]?token|secret[_-]?key|client[_-]?secret)\s*[:=]\s*\S{8,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /https?:\/\/[^/\s:]+:[^@\s]+@/,
];

/** Does this free text look like it carries a credential? When in doubt, yes. */
export function looksSecret(text) {
  if (typeof text !== 'string' || !text) return false;
  return SECRET_TEXT.some((re) => re.test(text));
}

/** May this file's contents be kept? When in doubt, no. */
export function mayStoreBody(file) {
  if (process.env.NARAI_HASH_ONLY === '1') return false;
  const p = resolve(file);
  if (NEVER_STORE.some((re) => re.test(p))) return false;
  if (namedForCredential(p)) return false;
  return !isGitIgnored(p);
}

/**
 * A git-ignored file is usually machine-local config or build output, so its contents
 * are not kept (the hash still is). False when git is absent or this is not a repository.
 */
export function isGitIgnored(file) {
  try {
    execFileSync('git', ['check-ignore', '-q', '--', file], {
      cwd: dirname(resolve(file)),
      stdio: 'ignore',
      timeout: 3000,
    });
    return true; // exit 0 = ignored
  } catch {
    return false; // exit 1 = not ignored, or no git at all
  }
}
