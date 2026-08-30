#!/usr/bin/env node
/**
 * Pack a package, install it the way somebody else would, and use it.
 *
 * Every other check in the release runs against the working tree, where npm workspaces has
 * linked every part to every other and node resolves anything. That is not the machine the
 * package lands on. What a consumer gets is one tarball plus whatever npm resolves from the
 * registry for its declared dependencies, and the gap between those two is invisible from
 * inside this repository.
 *
 * It is not hypothetical. redline, carbon and airframe were one command away from being
 * published importing `@hyuga/spar/cli` while declaring `@hyuga/spar: ^0.1.0` — a version whose
 * exports are `{ ".": "./src/spar.mjs" }` and nothing else. Tests passed, typecheck passed, the
 * tarball contents passed. On anybody else's machine all three would have thrown
 * ERR_PACKAGE_PATH_NOT_EXPORTED, inside a hook, where nothing reports an error: a limiter that
 * had stopped counting and a carbon that had stopped keeping drafts.
 *
 * So this resolves dependencies from the registry rather than from the workspace. When
 * redline 0.2.0 is checked, spar 0.2.0 has to already be published — which is exactly the
 * question, and exactly why RELEASING.md gives a publish order.
 *
 *   node scripts/smoke-install.mjs <package>     one package
 *   node scripts/smoke-install.mjs --all         every package, in dependency order
 *
 * Exits non-zero on the first failure, and says which check failed.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Dependency order. A part cannot be checked before what it imports is on the registry. */
const ORDER = ['spar', 'redline', 'carbon', 'airframe', 'groundtruth', 'habit', 'llm-safe-sql'];

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, {
  encoding: 'utf8', shell: false, windowsHide: true, ...opts,
});

/**
 * npm is a .cmd on Windows, and since Node 20 spawning one without a shell fails with EINVAL
 * rather than running it. So Windows gets a shell and nothing else does.
 *
 * The quoting belongs here rather than in the caller, and that is not a style preference: an
 * argument written already-quoted works under a shell and arrives with literal `"` characters
 * without one. That is exactly how this check failed its own first CI run — quoted so the
 * Windows shell would take a path, then handed to `npm pack` on Linux as a destination whose
 * name contained quote marks.
 *
 * Every argument comes from ORDER or from a filename npm itself printed, so nothing
 * user-supplied goes through a shell either way.
 */
const WINDOWS = process.platform === 'win32';
const npm = WINDOWS ? 'npm.cmd' : 'npm';
const quote = (a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
const runNpm = (args, opts = {}) => (WINDOWS
  ? run(npm, args.map(quote), { shell: true, ...opts })
  : run(npm, args, { shell: false, ...opts }));

function fail(what, detail) {
  // Spelled out because this printed `undefined` on its own first CI run, which is the least
  // useful thing a failing check can do: it stopped a release and explained nothing.
  const text = String(detail ?? '').trim() || '(the command produced no output)';
  process.stderr.write(`\n  ✗ ${what}\n${text.split('\n').map((l) => `      ${l}`).join('\n')}\n`);
  process.exitCode = 1;
  return false;
}

function check(pkg) {
  const dir = join(ROOT, 'packages', pkg);
  if (!existsSync(join(dir, 'package.json'))) return fail(pkg, 'no such package');
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  process.stdout.write(`${manifest.name}@${manifest.version}\n`);

  const sandbox = mkdtempSync(join(tmpdir(), 'smoke-'));
  try {
    // Packed from the working tree, so what is installed is this commit rather than whatever
    // the registry already has under this version.
    const packed = runNpm(['pack', `--workspace=packages/${pkg}`, `--pack-destination=${sandbox}`, '--silent'], { cwd: ROOT });
    if (packed.status !== 0) {
      return fail('npm pack', packed.stderr || packed.stdout || packed.error?.message
        || `exit ${packed.status}, signal ${packed.signal}`);
    }
    const tarball = (packed.stdout ?? '').trim().split('\n').filter(Boolean).pop();
    if (!tarball) return fail('npm pack', 'exited 0 but printed no tarball name');
    if (!existsSync(join(sandbox, tarball))) {
      return fail('npm pack', `said it wrote ${tarball}, and it is not in ${sandbox}`);
    }

    writeFileSync(join(sandbox, 'package.json'),
      JSON.stringify({ name: 'smoke', private: true, version: '1.0.0', type: 'module' }, null, 2));

    // No --workspaces, no link: dependencies come from the registry, which is the point.
    const install = runNpm(['i', `./${tarball}`, '--no-audit', '--no-fund'], { cwd: sandbox });
    if (install.status !== 0) return fail('npm install from the tarball', install.stderr || install.stdout || install.error?.message);

    // Every subpath the package says it exports has to import. A subpath that resolves in the
    // workspace and not from a registry install is the exact failure this exists for.
    const subpaths = Object.keys(manifest.exports ?? { '.': true })
      .filter((k) => k !== './package.json')
      .map((k) => (k === '.' ? manifest.name : `${manifest.name}/${k.replace(/^\.\//, '')}`));
    for (const spec of subpaths) {
      const r = run(process.execPath, ['-e', `import(${JSON.stringify(spec)}).then(m=>{if(!Object.keys(m).length)throw new Error('imported, but exports nothing')})`], { cwd: sandbox });
      if (r.status !== 0) return fail(`import '${spec}'`, r.stderr.trim());
      process.stdout.write(`  ✓ import ${spec}\n`);
    }

    // Every bin has to start. `--help` rather than no arguments: some of these read stdin when
    // given none, and a check that hangs is worse than one that fails.
    for (const [name, rel] of Object.entries(manifest.bin ?? {})) {
      const entry = join(sandbox, 'node_modules', manifest.name, rel);
      const r = run(process.execPath, [entry, '--help'], { cwd: sandbox, input: '', timeout: 30_000 });
      if (r.status !== 0) return fail(`${name} --help`, `exit ${r.status}\n${r.stderr.trim() || r.stdout.trim()}`);
      if (!`${r.stdout}${r.stderr}`.trim()) return fail(`${name} --help`, 'exited 0 and printed nothing — an inert bin looks exactly like this');
      process.stdout.write(`  ✓ ${name} --help\n`);
    }
    return true;
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
const targets = args.includes('--all') || args.length === 0 ? ORDER : args;
for (const pkg of targets) {
  if (!check(pkg)) break;
}
if (process.exitCode) process.stderr.write('\nsmoke-install: failed.\n');
else process.stdout.write('\nsmoke-install: every subpath imports and every bin starts, from a registry install.\n');
