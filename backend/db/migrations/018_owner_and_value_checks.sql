-- Every row has an owner, and the database refuses values the API never writes.
--
-- transactions, savings_goals and import_batches were created with a nullable
-- user_id. Nothing inserts one without an owner, but a NULL row would belong
-- to nobody: invisible in the app, and skipped by account deletion. Their
-- currency and amounts were checked only by the API's validators, so a bug or
-- a hand-written statement could store a currency the converter cannot price
-- or a negative goal. The CHECKs repeat what the validators accept:
--   transactions.amount > 0 (direction lives in type), currency one of six;
--   savings_goals.target_amount > 0, current_amount >= 0 (or NULL), same six.
--
-- A database with rows that break any of these rules aborts before anything
-- changes, with counts only, so the owner decides what those rows should be.
-- The constraint names are the ones PostgreSQL gives schema.sql's inline
-- column CHECKs, so a fresh database and a migrated one match.
--
-- No row is rewritten (SET NOT NULL and ADD CHECK only scan). Idempotent:
-- each CHECK is dropped and re-added, SET NOT NULL is a no-op when set.
--
-- Apply with `npm run db:migrate` (direct endpoint, no -pooler).

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
    currencies CONSTANT TEXT[] := ARRAY['CAD','USD','EUR','GBP','AUD','CNY'];
    problems TEXT := '';
    n BIGINT;
BEGIN
    SELECT count(*) INTO n FROM transactions WHERE user_id IS NULL;
    IF n > 0 THEN problems := problems || format(' %s transaction(s) without user_id;', n); END IF;
    SELECT count(*) INTO n FROM savings_goals WHERE user_id IS NULL;
    IF n > 0 THEN problems := problems || format(' %s goal(s) without user_id;', n); END IF;
    SELECT count(*) INTO n FROM import_batches WHERE user_id IS NULL;
    IF n > 0 THEN problems := problems || format(' %s import batch(es) without user_id;', n); END IF;
    SELECT count(*) INTO n FROM transactions WHERE amount <= 0;
    IF n > 0 THEN problems := problems || format(' %s transaction(s) with amount <= 0;', n); END IF;
    SELECT count(*) INTO n FROM transactions WHERE currency <> ALL (currencies);
    IF n > 0 THEN problems := problems || format(' %s transaction(s) with another currency;', n); END IF;
    SELECT count(*) INTO n FROM savings_goals WHERE target_amount <= 0 OR current_amount < 0;
    IF n > 0 THEN problems := problems || format(' %s goal(s) with target <= 0 or current < 0;', n); END IF;
    SELECT count(*) INTO n FROM savings_goals WHERE currency <> ALL (currencies);
    IF n > 0 THEN problems := problems || format(' %s goal(s) with another currency;', n); END IF;
    IF problems <> '' THEN
        RAISE EXCEPTION 'Migration 018 changed nothing: fix these rows first:%', problems;
    END IF;
END $$;

ALTER TABLE transactions ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE savings_goals ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE import_batches ALTER COLUMN user_id SET NOT NULL;

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_amount_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_amount_check CHECK (amount > 0);
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_currency_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_currency_check
    CHECK (currency IN ('CAD','USD','EUR','GBP','AUD','CNY'));
ALTER TABLE savings_goals DROP CONSTRAINT IF EXISTS savings_goals_target_amount_check;
ALTER TABLE savings_goals ADD CONSTRAINT savings_goals_target_amount_check CHECK (target_amount > 0);
ALTER TABLE savings_goals DROP CONSTRAINT IF EXISTS savings_goals_current_amount_check;
ALTER TABLE savings_goals ADD CONSTRAINT savings_goals_current_amount_check CHECK (current_amount >= 0);
ALTER TABLE savings_goals DROP CONSTRAINT IF EXISTS savings_goals_currency_check;
ALTER TABLE savings_goals ADD CONSTRAINT savings_goals_currency_check
    CHECK (currency IN ('CAD','USD','EUR','GBP','AUD','CNY'));
COMMIT;
