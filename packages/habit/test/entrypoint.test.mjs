import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// `npm i -g` and `npx` both reach the CLI through a symlink. argv[1] is then the link's path,
// which does not equal import.meta.url — that one is already resolved. Compared without
// resolving the link, an installed CLI did nothing and exited 0. For a linter that is the worst
// available breakage: "found no problems" and "never ran" are indistinguishable, and a CI job
// reading the exit code cannot tell them apart either. 0.9.1 shipped in that state.
//
// Every test that existed imported the functions and never ran the bin, so nothing could have
// caught it. This one reaches the entry point the way an install does. Take the realpathSync in
// src/habit.mjs back out and it fails, with no output at all.
test('the CLI runs through a symlink, the way npm i -g and npx reach it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'entrypoint-'));
  try {
    const link = join(dir, 'cli.mjs');
    try {
      symlinkSync(resolve('src/habit.mjs'), link);
    } catch {
      return; // no permission to create a symlink here (Windows without developer mode, say)
    }
    writeFileSync(join(dir, 'AGENTS.md'), '# t\n');
    writeFileSync(join(dir, 'package.json'), '{"name":"p","scripts":{}}');

    let out = '';
    try {
      out = execFileSync(process.execPath, [link, '--help'], { encoding: 'utf8' });
    } catch (e) {
      out = String(e.stdout ?? '') + String(e.stderr ?? '');
    }
    assert.notEqual(out.trim(), '', 'no output through the link means the entry-point check is broken');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
