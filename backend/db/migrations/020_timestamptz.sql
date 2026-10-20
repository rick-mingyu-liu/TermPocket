-- The original tables' timestamps carry their zone, like the agent tables'.
--
-- users, transactions, savings_goals, import_batches and access_tokens used
-- TIMESTAMP (no zone) holding UTC wall-clock time, which was right only
-- because db/connection.ts runs every session in UTC and parses TIMESTAMP as
-- UTC: a psql session, a pg_dump or a tool in another zone read them as local
-- time. TIMESTAMPTZ stores the instant.
--
-- SET LOCAL TIME ZONE 'UTC' makes the conversion read every stored value as
-- UTC, which is what it always meant; and with the session in UTC, PostgreSQL
-- 12+ converts timestamp to timestamptz without rewriting the table, so no
-- instant moves. One visible change: updated_at::text gains "+00". Agent undo
-- compares that text (and xmin) with what it saved at confirmation, so undoing
-- an entry confirmed in the ten minutes before this migration answers
-- agent_undo_conflict; the entries stay and can be deleted by hand.
--
-- Idempotent: altering a column to the type it already has changes nothing.
--
-- Apply with `npm run db:migrate` (direct endpoint, no -pooler).

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL TIME ZONE 'UTC';
ALTER TABLE users
    ALTER COLUMN email_verification_expires TYPE TIMESTAMPTZ,
    ALTER COLUMN created_at TYPE TIMESTAMPTZ,
    ALTER COLUMN updated_at TYPE TIMESTAMPTZ,
    ALTER COLUMN terms_accepted_at TYPE TIMESTAMPTZ;
ALTER TABLE transactions
    ALTER COLUMN created_at TYPE TIMESTAMPTZ,
    ALTER COLUMN updated_at TYPE TIMESTAMPTZ;
ALTER TABLE savings_goals
    ALTER COLUMN created_at TYPE TIMESTAMPTZ,
    ALTER COLUMN updated_at TYPE TIMESTAMPTZ;
ALTER TABLE import_batches
    ALTER COLUMN created_at TYPE TIMESTAMPTZ;
ALTER TABLE access_tokens
    ALTER COLUMN created_at TYPE TIMESTAMPTZ,
    ALTER COLUMN last_used_at TYPE TIMESTAMPTZ,
    ALTER COLUMN revoked_at TYPE TIMESTAMPTZ;
COMMIT;
