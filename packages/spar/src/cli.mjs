/**
 * The three things every part's command-line edge does, in one place.
 *
 * These are not policy and they are not the frame. They are the boilerplate that
 * sits between a hook and the part it calls — reading the payload, writing the
 * reply in the shape Claude Code expects, and deciding whether this process was
 * started as a command or merely imported.
 *
 * They lived as private copies in five files. Identical copies of the same
 * decision drift: a fix to one is a fix to one, and the four that did not get it
 * fail in the way the fix was written to prevent — silently, in a hook, where
 * nothing is watching. `runDirectly` in particular is the line that decides
 * whether `main()` runs at all, so a copy that is subtly wrong makes a part look
 * installed and do nothing.
 *
 * This is the frame's, rather than a shared utility package of its own, because
 * the parts that need it already depend on the frame and a fourth package to hold
 * three functions is a worse trade than the duplication was.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Was this file started as a command, rather than imported?
 *
 * `import.meta.url` cannot be read from here — it would name this file, not the
 * caller's — so the caller passes its own. The realpath second pass is what makes
 * this work through a symlink: `npm link` and a global install both put a link on
 * PATH, and comparing the link's path to the file's own URL says "imported" for
 * something that was plainly typed at a prompt.
 */
export function runDirectly(metaUrl) {
  const arg = process.argv[1];
  if (!arg) return false;
  if (metaUrl === pathToFileURL(arg).href) return true;
  try { return metaUrl === pathToFileURL(realpathSync(arg)).href; } catch { return false; }
}

/**
 * The hook payload, as text.
 *
 * File descriptor 0 rather than a stream, because a hook is a short-lived process
 * whose entire input is already there: reading it synchronously means `main` can
 * stay synchronous. Nothing on stdin is not an error — a part invoked as a plain
 * command has none — so this returns empty rather than throwing.
 */
export function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

/**
 * Say something back to the session.
 *
 * `additionalContext` is text the model reads and can talk itself out of, which is
 * the right shape for advice to a pilot who is flying. Nothing to say is the
 * normal case and prints nothing at all: an empty JSON envelope is still parsed,
 * still logged, and reads like a part that had an opinion.
 *
 * A refusal is a different envelope (`permissionDecision`) and deliberately not
 * here — a part that wants to deny a call should have to write that out.
 */
export function emit(eventName, context) {
  if (!context) return;
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext: context } }),
  );
}
