import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseConfig, ConfigError } from '../src/config.js';

/**
 * The config file, which decides which controls exist.
 *
 * Nothing downstream can tell the difference between a control that was
 * deliberately left out and one whose key was misspelled. The parser is the only
 * place that difference is visible, and it was only looking at the connection
 * objects.
 */

const base = {
  dialect: 'sqlite',
  connection: { file: './app.db' },
  policy: { allow: ['users'], impact: { users: 'Account records.' } },
};

test('a misspelled policy key is refused, and named', () => {
  // Measured on 0.4.6: `denyIdentifers` parsed, loaded and ran, and an UPDATE to
  // `password_hash` was planned and shown as an ordinary change. The denylist was
  // not there, and no line of output said so.
  const cfg = {
    ...base,
    policy: { ...base.policy, denyIdentifers: { password_hash: 'a stored credential' } },
  };
  assert.throws(
    () => parseConfig(cfg, {}),
    (e: unknown) =>
      e instanceof ConfigError &&
      /denyIdentifers/.test(e.message) &&
      /did you mean "denyIdentifiers"/.test(e.message),
  );
});

test('a misspelled top-level key is refused', () => {
  // The one that matters most here is a connection: `applyConection` falls back
  // to the planning credential, which is the separation this library is for.
  assert.throws(
    () => parseConfig({ ...base, applyConection: { file: './other.db' } }, {}),
    (e: unknown) => e instanceof ConfigError && /applyConection/.test(e.message),
  );
});

test('a misspelled or impossible limit is refused rather than cast', () => {
  assert.throws(
    () => parseConfig({ ...base, limits: { maxUpdateRow: 10 } }, {}),
    (e: unknown) => e instanceof ConfigError && /maxUpdateRow/.test(e.message),
  );
  for (const bad of ['200', 0, -1, 1.5, null]) {
    assert.throws(
      () => parseConfig({ ...base, limits: { maxUpdateRows: bad } }, {}),
      (e: unknown) => e instanceof ConfigError && /whole number/.test(e.message),
      `limits.maxUpdateRows = ${JSON.stringify(bad)} must be refused`,
    );
  }
  // And a cap that is a cap still works.
  assert.equal(parseConfig({ ...base, limits: { maxUpdateRows: 10 } }, {}).limits?.maxUpdateRows, 10);
});

test('comment keys are still comments, everywhere', () => {
  // JSON has none of its own, so the template and every worked example carry
  // their explanations as `//`-prefixed keys. Refusing unknown keys must not
  // refuse those.
  const cfg = {
    '//': 'what this file is',
    '//dialect': 'mysql | postgres | sqlite',
    ...base,
    policy: { '//allow': 'the tables this deployment may touch', ...base.policy },
    limits: { '//maxUpdateRows': 'rows one statement may change', maxUpdateRows: 5 },
  };
  assert.equal(parseConfig(cfg, {}).policy.allow[0], 'users');
});

test('the worked examples in this repository parse', () => {
  // They are the documentation people copy, and the parser just got stricter.
  const env = {
    LLM_SAFE_SQL_READ_PASSWORD: 'p',
    LLM_SAFE_SQL_PLAN_PASSWORD: 'p',
    LLM_SAFE_SQL_APPLY_PASSWORD: 'p',
    LLM_SAFE_SQL_STORE_PASSWORD: 'p',
  };
  for (const f of [
    'examples/mysql/llm-safe-sql.config.json',
    'examples/postgres/llm-safe-sql.config.json',
    'examples/sqlite/llm-safe-sql.config.json',
  ]) {
    const raw: unknown = JSON.parse(readFileSync(f, 'utf8'));
    assert.doesNotThrow(() => parseConfig(raw, env), `${f} must still parse`);
  }
});

test('an unset environment reference is refused, and says which one', () => {
  assert.throws(
    () =>
      parseConfig(
        { ...base, connection: { file: '${LLM_SAFE_SQL_DB_PATH}' } },
        {},
      ),
    (e: unknown) => e instanceof ConfigError && /LLM_SAFE_SQL_DB_PATH/.test(e.message),
  );
});
