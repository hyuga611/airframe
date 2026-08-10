-- Four MySQL accounts for one llm-safe-sql deployment.
--
-- The library's central claim is that the credential the model can reach is not
-- the credential that commits. That claim is only true if you make it true here.
-- With one shared account the separation rests entirely on this library having
-- no bugs, and `llm-safe-sql check` says so in as many words.
--
-- Replace `shop` with your database, `orders` with your tables, and set real
-- passwords. Run it once as an administrator:
--
--   mysql -u root -p < roles.sql
--
-- The plan and audit tables must exist first, because the grants below name
-- them. As an administrator, before this file:
--
--   npx llm-safe-sql migrate
--
-- `migrate` needs CREATE, which is why it stays an administrator's job and none
-- of the four accounts is given it.

-- ---------------------------------------------------------------------------
-- Why every grant here names a table instead of using `shop.*`
--
-- Because MySQL will not let you take part of it back. `GRANT ... ON shop.*`
-- followed by `REVOKE ... ON shop.llm_safe_sql_plans` fails outright:
--
--   ERROR 1147 (42000): There is no such grant defined for user 'llm_plan'
--                       on host '%' on table 'llm_safe_sql_plans'
--
-- (measured on MySQL 8.4). A database-wide grant would therefore hand the plan
-- and apply accounts write access to the plan and audit tables, with no way to
-- withdraw it -- so a dry run could forge its own approval record. Naming the
-- tables costs one line each and mirrors the `allow` list in your config, which
-- is a list you have to write anyway.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- One privilege that cannot be scoped to a table: CREATE TEMPORARY TABLES
--
-- `llm-safe-sql check` proves that a rollback on this server really undoes a
-- write before it will let you rely on one. It proves it on a TEMPORARY table of
-- its own rather than on your data, which needs this privilege -- and MySQL only
-- grants it per database, never per table.
--
-- It is a narrow privilege: temporary tables are session-local and vanish with
-- the connection. The read account below is deliberately not given it, and does
-- not need it -- its self-check stops before the write probe, which is the whole
-- point of having a role the server will not let write.
--
-- Without it you get:
--   Refused (ADAPTER_UNUSABLE): Cannot create a TEMPORARY table, so the
--   environment cannot be verified. Grant CREATE TEMPORARY TABLES to this user.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. read -- the account the model's SELECTs go through.
--
-- No write privilege of any kind. The allowlist and the secret-column check run
-- inside this process holding a credential that can write, so they are guards a
-- bug can get past; this one is enforced by MySQL, below us. If the read path is
-- ever tricked into issuing an UPDATE, the server refuses it.
-- ---------------------------------------------------------------------------
CREATE USER 'llm_read'@'%' IDENTIFIED BY 'change-me-read';
GRANT SELECT ON shop.orders TO 'llm_read'@'%';
-- one line per table in your allowlist

-- ---------------------------------------------------------------------------
-- 2. plan -- the dry run. Really executes the statement, always rolls back.
--
-- It needs full DML because it genuinely performs the write before undoing it:
-- that is the only way to find out what triggers fire and what defaults apply.
-- It never commits, it cannot reach the plan or audit tables, and it has no
-- CREATE, DROP or ALTER.
-- ---------------------------------------------------------------------------
CREATE USER 'llm_plan'@'%' IDENTIFIED BY 'change-me-plan';
GRANT SELECT, INSERT, UPDATE, DELETE ON shop.orders TO 'llm_plan'@'%';
GRANT CREATE TEMPORARY TABLES ON shop.* TO 'llm_plan'@'%';

-- ---------------------------------------------------------------------------
-- 3. apply -- the only account in this list that commits anything.
--
-- It lives in a different process from the model's tools. Nothing the model can
-- say reaches it; a plan id and a human's approval do.
-- ---------------------------------------------------------------------------
CREATE USER 'llm_apply'@'%' IDENTIFIED BY 'change-me-apply';
GRANT SELECT, INSERT, UPDATE, DELETE ON shop.orders TO 'llm_apply'@'%';
GRANT CREATE TEMPORARY TABLES ON shop.* TO 'llm_apply'@'%';

-- ---------------------------------------------------------------------------
-- 4. store -- plans and audit records, and nothing else.
--
-- These privileges are what the code actually issues, not what seems reasonable:
-- the plan table gets INSERT, SELECT and UPDATE, the audit table gets INSERT
-- alone. There is no DELETE anywhere in the store, so this account cannot erase
-- an approval it wrote -- and it holds nothing at all on your business tables,
-- so a bug on this path cannot reach your data.
-- ---------------------------------------------------------------------------
CREATE USER 'llm_store'@'%' IDENTIFIED BY 'change-me-store';
GRANT SELECT, INSERT, UPDATE ON shop.llm_safe_sql_plans TO 'llm_store'@'%';
GRANT INSERT               ON shop.llm_safe_sql_audit  TO 'llm_store'@'%';
GRANT CREATE TEMPORARY TABLES ON shop.* TO 'llm_store'@'%';

FLUSH PRIVILEGES;

-- ---------------------------------------------------------------------------
-- What you should see afterwards
--
--   SHOW GRANTS FOR 'llm_read'@'%';   -- SELECT on one table, nothing else
--   SHOW GRANTS FOR 'llm_store'@'%';  -- two table grants, no DELETE
--
-- and then, from the deployment:
--
--   npx llm-safe-sql check
--
-- which prints a "proved" line for each separation it could establish by asking
-- the server, and a warning for each one it could not.
-- ---------------------------------------------------------------------------
