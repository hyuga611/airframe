import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseGrants, canSeeTriggers, canSeeWholeSchema } from '../src/adapters/mysql.js';

/**
 * Reading `SHOW GRANTS`, which is how the MySQL adapter finds out whether the
 * zeroes it just measured mean anything.
 *
 * The source is `SHOW GRANTS` and not `information_schema.SCHEMA_PRIVILEGES`
 * because of a measurement: with the TRIGGER privilege held through an active
 * role, `SHOW GRANTS` reports `GRANT SELECT, TRIGGER ON \`db\`.* TO ...` while
 * `SCHEMA_PRIVILEGES` returns no rows at all. Reading the structured view would
 * have declared a role-based deployment blind and refused every plan on it.
 *
 * Every line below is copied from a real server: MySQL 8.4.11, MySQL 5.7.44 or
 * MariaDB 11.8.8, which quote and pad these differently.
 */

describe('parseGrants', () => {
  test('the grant list this package used to recommend can see neither', () => {
    // Measured on MySQL 8.4.11 for a user created by examples/mysql/roles.sql as
    // it shipped through 0.4.10.
    const g = parseGrants([
      'GRANT USAGE ON *.* TO `llm_plan`@`%`',
      'GRANT CREATE TEMPORARY TABLES ON `shop`.* TO `llm_plan`@`%`',
      'GRANT SELECT, INSERT, UPDATE, DELETE ON `shop`.`orders` TO `llm_plan`@`%`',
    ]);
    assert.equal(canSeeTriggers(g, 'shop', 'orders'), false);
    assert.equal(
      canSeeWholeSchema(g, 'shop'),
      false,
      'CREATE TEMPORARY TABLES is a schema-scoped grant that confers no visibility of any table',
    );
  });

  test('the grant list it recommends now can see both', () => {
    const g = parseGrants([
      'GRANT USAGE ON *.* TO `llm_plan`@`%`',
      'GRANT SELECT, TRIGGER ON `shop`.* TO `llm_plan`@`%`',
      'GRANT CREATE TEMPORARY TABLES ON `shop`.* TO `llm_plan`@`%`',
      'GRANT SELECT, INSERT, UPDATE, DELETE ON `shop`.`orders` TO `llm_plan`@`%`',
    ]);
    assert.equal(canSeeTriggers(g, 'shop', 'orders'), true);
    assert.equal(canSeeWholeSchema(g, 'shop'), true);
  });

  test('a privilege held through an active role is in the list, which is why this reads SHOW GRANTS', () => {
    // Measured on MySQL 8.4.11: `GRANT SELECT, TRIGGER ON llmsafesql.* TO r_role`
    // then `GRANT r_role TO r_user`. The role line has no ON clause and is
    // skipped; the expanded line above it is the one that matters.
    const g = parseGrants([
      'GRANT USAGE ON *.* TO `r_user`@`%`',
      'GRANT SELECT, TRIGGER ON `llmsafesql`.* TO `r_user`@`%`',
      'GRANT `r_role`@`%` TO `r_user`@`%`',
    ]);
    assert.equal(canSeeTriggers(g, 'llmsafesql', 'anything'), true);
    assert.equal(canSeeWholeSchema(g, 'llmsafesql'), true);
  });

  test('TRIGGER granted on the one table is enough for that table and no other', () => {
    const g = parseGrants(['GRANT SELECT, TRIGGER ON `shop`.`orders` TO `u`@`%`']);
    assert.equal(canSeeTriggers(g, 'shop', 'orders'), true);
    assert.equal(canSeeTriggers(g, 'shop', 'invoices'), false);
    assert.equal(canSeeWholeSchema(g, 'shop'), false, 'one table is not the schema');
  });

  test('ALL PRIVILEGES counts as every privilege, at whatever scope it was granted', () => {
    assert.equal(canSeeTriggers(parseGrants(['GRANT ALL PRIVILEGES ON *.* TO `root`@`%`']), 'shop', 'orders'), true);
    assert.equal(canSeeWholeSchema(parseGrants(['GRANT ALL PRIVILEGES ON `shop`.* TO `u`@`%`']), 'shop'), true);
    assert.equal(
      canSeeWholeSchema(parseGrants(['GRANT ALL PRIVILEGES ON `other`.* TO `u`@`%`']), 'shop'),
      false,
      'and not at some other schema',
    );
  });

  test('a column-scoped privilege does not split into privileges named after columns', () => {
    // `GRANT SELECT (a, b)` — those commas are inside the parentheses, and a naive
    // split turns them into privileges called `A)` and `B)`. Harmless here, but
    // the same split is what decides whether TRIGGER is present.
    const g = parseGrants(['GRANT SELECT (id, ref), TRIGGER ON `shop`.`orders` TO `u`@`%`']);
    assert.equal(canSeeTriggers(g, 'shop', 'orders'), true);
    assert.equal(canSeeWholeSchema(g, 'shop'), false);
  });

  test("MariaDB's trailing IDENTIFIED BY clause does not change what was granted", () => {
    // Measured on MariaDB 11.8.8, which prints the password hash on the USAGE line.
    const g = parseGrants([
      "GRANT USAGE ON *.* TO `u`@`%` IDENTIFIED BY PASSWORD '*7B9EBEED26AA52ED10C0F549FA863F13C39E0209'",
      'GRANT SELECT, TRIGGER ON `llmsafesql`.* TO `u`@`%`',
    ]);
    assert.equal(canSeeTriggers(g, 'llmsafesql', 'orders'), true);
    assert.equal(canSeeWholeSchema(g, 'llmsafesql'), true);
  });

  test('WITH GRANT OPTION is not a privilege in the list', () => {
    const g = parseGrants(['GRANT SELECT ON `shop`.* TO `u`@`%` WITH GRANT OPTION']);
    assert.equal(canSeeWholeSchema(g, 'shop'), true);
    assert.equal(canSeeTriggers(g, 'shop', 'orders'), false, 'SELECT is not TRIGGER');
  });

  test('nothing parseable means nothing is visible, which is the direction that refuses', () => {
    // What a failed `SHOW GRANTS` reduces to. It must not become "you can see
    // everything" — that is the whole defect this release is about.
    const g = parseGrants(['', 'not a grant line at all', 'GRANT `r`@`%` TO `u`@`%`']);
    assert.equal(canSeeTriggers(g, 'shop', 'orders'), false);
    assert.equal(canSeeWholeSchema(g, 'shop'), false);
  });

  test('USAGE is the privilege that means none', () => {
    const g = parseGrants(['GRANT USAGE ON *.* TO `u`@`%`']);
    assert.equal(canSeeTriggers(g, 'shop', 'orders'), false);
    assert.equal(canSeeWholeSchema(g, 'shop'), false);
  });
});
