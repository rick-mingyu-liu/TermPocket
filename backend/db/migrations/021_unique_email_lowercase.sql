-- One account per address, whatever its case.
--
-- users.email is UNIQUE as typed, and registration has lowercased addresses
-- only since express-validator's normalizeEmail() was added; an older row can
-- hold "Jane@Example.com". This index makes a second registration of the same
-- address in another case a conflict the database itself refuses (register
-- also looks addresses up by lower(email) and answers "User already exists").
--
-- A database where two addresses already differ only in case aborts before
-- anything changes, with a count only. Resolve them first (which account is
-- the owner's is a decision, not something a migration can make), then re-run.
--
-- Additive; no row is rewritten. Idempotent.
--
-- Apply with `npm run db:migrate` (direct endpoint, no -pooler).

BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$
DECLARE n BIGINT;
BEGIN
    SELECT count(*) INTO n FROM (SELECT 1 FROM users GROUP BY lower(email) HAVING count(*) > 1) d;
    IF n > 0 THEN
        RAISE EXCEPTION 'Migration 021 changed nothing: % address(es) are registered more than once in different case', n;
    END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users (lower(email));
COMMIT;
