-- Personal Finance Database Schema

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    email_verified BOOLEAN DEFAULT FALSE,
    email_verification_token VARCHAR(255),
    email_verification_expires TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    language VARCHAR(10) NOT NULL DEFAULT 'en',
    email_notifications_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    weekly_reports_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    -- Marks the demo account. The scheduled refresh deletes and rewrites every
    -- row belonging to its target, so it matches on this rather than on an
    -- email address anyone could register. Only a deliberate seed sets it.
    is_demo BOOLEAN NOT NULL DEFAULT FALSE,
    -- Automatic deletion (migration 016): keep only the last N terms of
    -- transactions, the current one included. NULL is off, the default for
    -- everyone; the hourly sweep deletes nothing for a NULL row.
    transaction_retention_terms SMALLINT CHECK (transaction_retention_terms BETWEEN 3 AND 12),
    -- Which version of the Terms of Service and Privacy Policy the user
    -- accepted, and when (migration 017). NULL means never: the app asks once
    -- after sign-in. config.legal.termsVersion is the current version.
    terms_version VARCHAR(32),
    terms_accepted_at TIMESTAMPTZ
);

-- At most one demo account: the refresh resolves its target with a bare
-- `WHERE is_demo = TRUE`, and two matching rows would make which one it
-- rewrites depend on the query plan.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_single_demo ON users (is_demo) WHERE is_demo;

-- One account per address whatever its case (migration 021): rows from before
-- registration lowercased addresses can hold "Jane@Example.com".
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users (lower(email));

-- Transactions table
CREATE TABLE IF NOT EXISTS transactions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Always positive: direction lives in type (migration 018).
    amount DECIMAL(10,2) NOT NULL CHECK (amount > 0),
    description VARCHAR(255) NOT NULL,
    category VARCHAR(100) NOT NULL,
    type VARCHAR(20) NOT NULL CHECK (type IN ('income', 'expense')),
    date DATE NOT NULL,
    currency VARCHAR(10) NOT NULL DEFAULT 'CAD' CHECK (currency IN ('CAD','USD','EUR','GBP','AUD','CNY')),
    -- How the row was entered: typed in, or imported from a screenshot (and
    -- whether the parser or the LLM fallback read it). See migration 011.
    source VARCHAR(20) NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'ocr', 'ocr_llm', 'agent')),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- One row per confirmed screenshot import. Counts only; see migration 011.
CREATE TABLE IF NOT EXISTS import_batches (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    row_count INTEGER NOT NULL CHECK (row_count > 0),
    edited_count INTEGER NOT NULL CHECK (edited_count >= 0),
    llm_count INTEGER NOT NULL CHECK (llm_count >= 0),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Read-only personal access tokens for POST /mcp; see migration 012.
CREATE TABLE IF NOT EXISTS access_tokens (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(60) NOT NULL,
    token_hash CHAR(64) NOT NULL UNIQUE,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
);

-- Savings goals table
CREATE TABLE IF NOT EXISTS savings_goals (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    target_amount DECIMAL(10,2) NOT NULL CHECK (target_amount > 0),
    current_amount DECIMAL(10,2) DEFAULT 0 CHECK (current_amount >= 0),
    target_date DATE,
    description TEXT,
    currency VARCHAR(10) NOT NULL DEFAULT 'CAD' CHECK (currency IN ('CAD','USD','EUR','GBP','AUD','CNY')),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for better performance
-- Every read of transactions filters on user_id, and the listings (GET
-- /transactions, the agent's transaction_details, the weekly report) sort by
-- date DESC, id DESC, so one composite index serves filter, range and sort
-- (migration 019; it replaced 006's, which ended in created_at).
CREATE INDEX IF NOT EXISTS idx_transactions_user_date_id ON transactions(user_id, date DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_goals_user_id ON savings_goals(user_id);
CREATE INDEX IF NOT EXISTS idx_import_batches_user_id ON import_batches(user_id);
CREATE INDEX IF NOT EXISTS idx_access_tokens_user_id ON access_tokens(user_id);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers to automatically update updated_at.
-- OR REPLACE keeps this file re-runnable: plain CREATE TRIGGER has no
-- IF NOT EXISTS form, so db:setup used to fail on a second run even though
-- every other statement here is idempotent.
CREATE OR REPLACE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE OR REPLACE TRIGGER update_transactions_updated_at BEFORE UPDATE ON transactions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE OR REPLACE TRIGGER update_goals_updated_at BEFORE UPDATE ON savings_goals
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Conversation records never own saved transactions: deleting history cannot
-- cascade into the ledger. Owner is repeated in every compound relationship.
-- Column-specific ON DELETE SET NULL below needs PostgreSQL 15; fail clearly.
DO $$
BEGIN
    IF current_setting('server_version_num')::int < 150000 THEN
        RAISE EXCEPTION 'Conversation recording requires PostgreSQL 15 or later (column-specific ON DELETE SET NULL); this server is %', current_setting('server_version');
    END IF;
END $$;
CREATE TABLE IF NOT EXISTS agent_conversations (
    id UUID PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(80) NOT NULL DEFAULT 'New conversation',
    draft_version INTEGER NOT NULL DEFAULT 0 CHECK (draft_version >= 0),
    currency VARCHAR(10) NOT NULL CHECK (currency IN ('CAD','USD','EUR','GBP','AUD','CNY')),
    timezone VARCHAR(100) NOT NULL,
    language VARCHAR(10) NOT NULL CHECK (language IN ('auto','en','zh')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(id,user_id)
);
CREATE TABLE IF NOT EXISTS agent_runs (
    id UUID PRIMARY KEY,
    conversation_id UUID NOT NULL,
    user_id INTEGER NOT NULL,
    request_hash CHAR(64) NOT NULL,
    status VARCHAR(12) NOT NULL CHECK (status IN ('running','complete','failed','cancelled')),
    error_code VARCHAR(60),
    input_tokens INTEGER CHECK (input_tokens >= 0),
    output_tokens INTEGER CHECK (output_tokens >= 0),
    tool_calls INTEGER CHECK (tool_calls BETWEEN 0 AND 8),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    lease_until TIMESTAMPTZ NOT NULL DEFAULT (now()+interval '90 seconds'),
    finished_at TIMESTAMPTZ,
    UNIQUE(id,conversation_id,user_id),
    FOREIGN KEY(conversation_id,user_id) REFERENCES agent_conversations(id,user_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs_one_active ON agent_runs(user_id) WHERE status='running';
CREATE INDEX IF NOT EXISTS idx_agent_runs_admission ON agent_runs(user_id,created_at DESC);
CREATE TABLE IF NOT EXISTS agent_messages (
    id UUID PRIMARY KEY,
    conversation_id UUID NOT NULL,
    user_id INTEGER NOT NULL,
    run_id UUID,
    role VARCHAR(12) NOT NULL CHECK (role IN ('user','assistant')),
    content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 16000),
    status VARCHAR(12) NOT NULL CHECK (status IN ('complete','failed','cancelled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY(conversation_id,user_id) REFERENCES agent_conversations(id,user_id) ON DELETE CASCADE,
    FOREIGN KEY(run_id,conversation_id,user_id) REFERENCES agent_runs(id,conversation_id,user_id) ON DELETE SET NULL (run_id),
    UNIQUE(run_id,role)
);
CREATE INDEX IF NOT EXISTS idx_agent_messages_history ON agent_messages(conversation_id,created_at,id);
CREATE TABLE IF NOT EXISTS agent_drafts (
    id UUID PRIMARY KEY,
    conversation_id UUID NOT NULL,
    user_id INTEGER NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    status VARCHAR(12) NOT NULL CHECK (status IN ('pending','confirmed','cancelled','expired')),
    rows JSONB NOT NULL CHECK (jsonb_typeof(rows)='array' AND jsonb_array_length(rows) <= 12 AND octet_length(rows::text) <= 65536),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (now()+interval '24 hours'),
    UNIQUE(id,conversation_id,user_id),
    UNIQUE(conversation_id,version),
    FOREIGN KEY(conversation_id,user_id) REFERENCES agent_conversations(id,user_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS agent_receipts (
    id UUID PRIMARY KEY,
    conversation_id UUID,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    request_id UUID NOT NULL,
    request_hash CHAR(64) NOT NULL,
    transaction_ids INTEGER[] NOT NULL CHECK (cardinality(transaction_ids) BETWEEN 1 AND 12),
    -- Exact PostgreSQL timestamp text and tuple version; no financial content.
    transaction_versions JSONB NOT NULL CHECK (octet_length(transaction_versions::text) <= 16384),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    undo_until TIMESTAMPTZ NOT NULL DEFAULT (now()+interval '10 minutes'),
    undone_at TIMESTAMPTZ,
    UNIQUE(user_id,request_id),
    FOREIGN KEY(conversation_id,user_id) REFERENCES agent_conversations(id,user_id) ON DELETE SET NULL (conversation_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_receipts_user ON agent_receipts(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_conversations_user ON agent_conversations(user_id,updated_at DESC);

-- Independent of history deletion so clearing a chat cannot reset admission.
CREATE TABLE IF NOT EXISTS agent_admissions (
    id UUID PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_admissions_user ON agent_admissions(user_id,created_at DESC);

-- Planning: savings-goal changes Pocky proposes. Only the user's Confirm
-- button applies one; goal_id has no foreign key because the goal may be
-- deleted meanwhile, which confirmation reports as a conflict.
CREATE TABLE IF NOT EXISTS agent_goal_proposals (
    id UUID PRIMARY KEY,
    conversation_id UUID NOT NULL,
    user_id INTEGER NOT NULL,
    run_id UUID,
    action VARCHAR(8) NOT NULL CHECK (action IN ('create','update')),
    goal_id INTEGER,
    -- savings_goals.updated_at as PostgreSQL text when proposed, to the microsecond.
    expected_updated_at TEXT CHECK (length(expected_updated_at) <= 64),
    before JSONB CHECK (before IS NULL OR (jsonb_typeof(before)='object' AND octet_length(before::text) <= 4096)),
    after JSONB NOT NULL CHECK (jsonb_typeof(after)='object' AND octet_length(after::text) <= 4096),
    status VARCHAR(12) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','cancelled','superseded','conflict','expired')),
    request_id UUID,
    request_hash CHAR(64),
    result_goal_id INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (now()+interval '24 hours'),
    decided_at TIMESTAMPTZ,
    CHECK ((action='create' AND goal_id IS NULL AND expected_updated_at IS NULL AND before IS NULL)
        OR (action='update' AND goal_id IS NOT NULL AND expected_updated_at IS NOT NULL AND before IS NOT NULL)),
    CHECK ((request_id IS NULL) = (request_hash IS NULL)),
    UNIQUE(user_id,request_id),
    FOREIGN KEY(conversation_id,user_id) REFERENCES agent_conversations(id,user_id) ON DELETE CASCADE,
    FOREIGN KEY(run_id,conversation_id,user_id) REFERENCES agent_runs(id,conversation_id,user_id) ON DELETE SET NULL (run_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_goal_proposals_conversation ON agent_goal_proposals(user_id,conversation_id,created_at DESC);

-- Which files in db/migrations/ have been applied (db/migrate.ts, `npm run
-- db:migrate`). db:setup on a fresh database records them all, because this
-- file already contains their end state; an existing database is recorded
-- with `npm run db:migrate -- --baseline NNN`.
CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    checksum CHAR(64) NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
