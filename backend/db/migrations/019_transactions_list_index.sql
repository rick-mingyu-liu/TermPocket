-- The transaction list's index, matching its sort.
--
-- GET /transactions, the agent's transaction_details and the weekly report all
-- read one user's rows ORDER BY date DESC, id DESC (id breaks ties so keyset
-- pages are stable). Migration 006's index ends in created_at DESC instead,
-- from when the list sorted on it, so PostgreSQL sorted every page again. This
-- index serves the filter, the date range and the order; it replaces 006's,
-- which nothing sorts by any more (the leading user_id, date still serve every
-- range query that used it).
--
-- Additive then a drop; no row is read or rewritten. Plain CREATE INDEX (not
-- CONCURRENTLY, which cannot run in a transaction): it blocks writes to
-- transactions for as long as the build takes, well under a second at this size.
-- Idempotent.
--
-- Apply with `npm run db:migrate` (direct endpoint, no -pooler).

BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE INDEX IF NOT EXISTS idx_transactions_user_date_id ON transactions(user_id, date DESC, id DESC);
DROP INDEX IF EXISTS idx_transactions_user_date;
COMMIT;
