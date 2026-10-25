-- Personal access tokens (POST /mcp) expire 90 days after they are created.
--
-- access_tokens.expires_at is when a token stops opening /mcp. New tokens get
-- now() plus config.accessTokens.ttlDays (90) from the application. A NULL
-- can only come from a create that checked for the column just before this
-- committed; the application treats it as created_at + ttlDays, never as
-- "never expires".
--
-- Every token still active when this runs gets now() + 90 days, so nobody's
-- connection breaks on the day it is applied. Revoked tokens stay NULL: they
-- are refused whatever their expiry.
--
-- The code tolerates its absence: until it is applied, tokens do not expire,
-- are created without the column and are listed with expires_at null. It is
-- noticed without a restart.
--
-- Idempotent: safe to re-run. A re-run gives an expiry only to an active
-- token that still has none.
--
-- Deploy the code first, then apply this with npm run db:migrate on the direct
-- endpoint (no -pooler).

-- UTC, as the application's own sessions are: interval '90 days' is counted
-- in calendar days of the session's zone, so a zone with daylight saving would
-- make it 90 days plus or minus an hour.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL TIME ZONE 'UTC';
ALTER TABLE access_tokens ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
UPDATE access_tokens SET expires_at = now() + interval '90 days'
    WHERE expires_at IS NULL AND revoked_at IS NULL;
COMMIT;
