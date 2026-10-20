-- Record which version of the Terms of Service and Privacy Policy each user
-- accepted, and when.
--
-- users.terms_version holds the accepted version (config.legal.termsVersion at
-- the time, a date such as '2026-10-19'); users.terms_accepted_at the UTC
-- timestamp. Both are NULL for every existing row: those users never accepted
-- anything, so the app shows them the accept card once after they sign in.
-- New registrations that tick the box store the current version.
--
-- Additive only: no existing row is read or rewritten.
--
-- The code tolerates its absence: until it is applied, nobody is asked and
-- nothing is stored. It is noticed without a restart.
--
-- Idempotent: safe to re-run.
--
-- Deploy the code first, then apply this with the direct endpoint (no -pooler):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/017_terms_acceptance.sql

BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_version VARCHAR(32);
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMP;
COMMIT;
