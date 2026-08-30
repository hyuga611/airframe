-- Four PostgreSQL roles for one llm-safe-sql deployment.
--
-- The library's central claim is that the credential the model can reach is not
-- the credential that commits. That claim is only true if you make it true here.
-- With one shared role the separation rests entirely on this library having no
-- bugs, and `llm-safe-sql check` says so in as many words.
--
-- Replace `shop` with your database, `orders` with your tables, and set real
-- passwords. Run it once as a superuser, connected to the database itself:
--
--   psql -U postgres -d shop -f roles.sql
--
-- The plan and audit tables must exist first, because the grants below name
-- them. As a superuser, before this file:
--
--   npx llm-safe-sql migrate
--
-- `migrate` needs CREATE on the schema, which is why it stays a superuser's job
-- and none of the four roles below is given it.

-- ---------------------------------------------------------------------------
-- Two PostgreSQL defaults that will surprise you
--
-- 1. `search_path` defaults to `"$user", public`, which resolves *per role*. With
--    the plan and apply on different roles -- which is the whole point -- the
--    same unqualified table name can measure one table and write another. Pin it
--    with `"schema"` in the config, and `check` asserts what the server actually
--    resolved rather than trusting the setting.
--
-- 2. Every role inherits privileges granted to PUBLIC, including TEMPORARY on
--    the database. That is convenient for three of these roles and wrong for the
--    read one: a role that can create a temporary table is not a role the server
--    refuses writes from. The REVOKE below takes it back from PUBLIC and hands
--    it individually to the three that need it.
-- ---------------------------------------------------------------------------

REVOKE TEMPORARY ON DATABASE shop FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 1. read -- the role the model's SELECTs go through.
--
-- No write privilege of any kind, and no TEMPORARY. The allowlist and the
-- secret-column check run inside this process holding a credential that can
-- write, so they are guards a bug can get past; this one is enforced by
-- PostgreSQL, below us. Its self-check stops before the write probe, by design,
-- so it does not need to create anything.
-- ---------------------------------------------------------------------------
CREATE ROLE llm_read LOGIN PASSWORD 'change-me-read';
GRANT CONNECT ON DATABASE shop TO llm_read;
GRANT USAGE ON SCHEMA public TO llm_read;
GRANT SELECT ON orders TO llm_read;
-- one line per table in your allowlist

-- ---------------------------------------------------------------------------
-- 2. plan -- the dry run. Really executes the statement, always rolls back.
--
-- Full DML on the business tables, because it genuinely performs the write
-- before undoing it: that is the only way to find out what triggers fire and
-- what defaults apply. It never commits, and it holds nothing on the plan or
-- audit tables -- a dry run must not be able to forge its own approval record.
--
-- TEMPORARY is for `check`, which proves a rollback really undoes a write on a
-- temporary table of its own rather than on your data.
-- ---------------------------------------------------------------------------
CREATE ROLE llm_plan LOGIN PASSWORD 'change-me-plan';
GRANT CONNECT, TEMPORARY ON DATABASE shop TO llm_plan;
GRANT USAGE ON SCHEMA public TO llm_plan;
GRANT SELECT, INSERT, UPDATE, DELETE ON orders TO llm_plan;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO llm_plan;

-- ---------------------------------------------------------------------------
-- 3. apply -- the only role in this list that commits anything.
--
-- It lives in a different process from the model's tools. Nothing the model can
-- say reaches it; a plan id and a human's approval do.
-- ---------------------------------------------------------------------------
CREATE ROLE llm_apply LOGIN PASSWORD 'change-me-apply';
GRANT CONNECT, TEMPORARY ON DATABASE shop TO llm_apply;
GRANT USAGE ON SCHEMA public TO llm_apply;
GRANT SELECT, INSERT, UPDATE, DELETE ON orders TO llm_apply;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO llm_apply;

-- ---------------------------------------------------------------------------
-- 4. store -- plans and audit records, and nothing else.
--
-- These privileges are what the code actually issues, not what seems reasonable:
-- the plan table gets INSERT, SELECT and UPDATE, the audit table gets INSERT
-- alone. There is no DELETE anywhere in the store, so this role cannot erase an
-- approval it wrote -- and it holds nothing at all on your business tables, so a
-- bug on this path cannot reach your data.
-- ---------------------------------------------------------------------------
CREATE ROLE llm_store LOGIN PASSWORD 'change-me-store';
GRANT CONNECT, TEMPORARY ON DATABASE shop TO llm_store;
GRANT USAGE ON SCHEMA public TO llm_store;
GRANT SELECT, INSERT, UPDATE ON llm_safe_sql_plans TO llm_store;
GRANT INSERT               ON llm_safe_sql_audit  TO llm_store;
GRANT USAGE, SELECT ON SEQUENCE llm_safe_sql_audit_id_seq TO llm_store;

-- ---------------------------------------------------------------------------
-- What you should see afterwards
--
--   \dp orders                      -- llm_read has r, the others arwd
--   \du llm_read                    -- no attributes, no superuser
--
-- and then, from the deployment:
--
--   npx llm-safe-sql check
--
-- which prints a "proved" line for each separation it could establish by asking
-- the server, and a warning for each one it could not.
-- ---------------------------------------------------------------------------
