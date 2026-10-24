-- Add durable memories and the proposals whose buttons authorize changes.
-- Additive and repeatable. Deploy the code before applying via npm run db:migrate.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$
BEGIN
    IF current_setting('server_version_num')::int < 150000 THEN
        RAISE EXCEPTION 'Memory requires PostgreSQL 15 or later (column-specific ON DELETE SET NULL); this server is %', current_setting('server_version');
    END IF;
    IF to_regclass('agent_conversations') IS NULL OR to_regclass('agent_runs') IS NULL THEN
        RAISE EXCEPTION 'Apply migration 013_conversational_transactions.sql first';
    END IF;
END $$;
-- Approved durable facts and their button-confirmed proposals (migration 022).
-- Facts outlive their source conversation; only the source link is detached.
CREATE TABLE IF NOT EXISTS agent_memories (
    id UUID PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind VARCHAR(10) NOT NULL CHECK (kind IN ('income','expense','reserve','preference','other')),
    text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 120 AND length(btrim(text)) > 0
        AND text !~ U&'[\0001-\001f\007f\202a-\202e\2066-\2069]'),
    amount DECIMAL(10,2) CHECK (amount > 0 AND amount <> 'NaN'::numeric),
    currency VARCHAR(3) CHECK (currency IN ('CAD','USD','EUR','GBP','AUD','CNY')),
    cadence VARCHAR(9) CHECK (cadence IN ('week','two_weeks','month','once')),
    source_conversation_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((amount IS NULL AND currency IS NULL AND cadence IS NULL)
        OR (amount IS NOT NULL AND currency IS NOT NULL)),
    FOREIGN KEY(source_conversation_id,user_id) REFERENCES agent_conversations(id,user_id) ON DELETE SET NULL (source_conversation_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_memories_user ON agent_memories(user_id,created_at);
CREATE OR REPLACE TRIGGER update_agent_memories_updated_at BEFORE UPDATE ON agent_memories
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- No foreign key on memory_id/result_memory_id: forgetting redacts snapshots,
-- while retaining the ids needed for replay. Ended offers retain no fact text.
CREATE TABLE IF NOT EXISTS agent_memory_proposals (
    id UUID PRIMARY KEY,
    conversation_id UUID NOT NULL,
    user_id INTEGER NOT NULL,
    run_id UUID,
    action VARCHAR(8) NOT NULL CHECK (action IN ('remember','update','forget')),
    kind VARCHAR(10) NOT NULL CHECK (kind IN ('income','expense','reserve','preference','other')),
    memory_id UUID,
    expected_updated_at TEXT CHECK (expected_updated_at ~ '^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$'),
    before JSONB CHECK (before IS NULL OR (jsonb_typeof(before)='object' AND octet_length(before::text) <= 4096)),
    after JSONB CHECK (after IS NULL OR (jsonb_typeof(after)='object' AND octet_length(after::text) <= 4096)),
    status VARCHAR(12) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','cancelled','superseded','conflict','expired')),
    request_id UUID,
    request_hash CHAR(64),
    result_memory_id UUID,
    -- Replays preserve the exact committed conflict without retaining its payload.
    error_code VARCHAR(30) CHECK (error_code IN ('agent_memory_full','agent_memory_conflict')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (now()+interval '24 hours'),
    decided_at TIMESTAMPTZ,
    redacted_at TIMESTAMPTZ,
    CHECK ((action='remember' AND memory_id IS NULL AND expected_updated_at IS NULL)
        OR (action IN ('update','forget') AND memory_id IS NOT NULL AND expected_updated_at IS NOT NULL)),
    CHECK ((redacted_at IS NOT NULL AND before IS NULL AND after IS NULL AND status<>'pending')
        OR (redacted_at IS NULL AND status IN ('pending','confirmed') AND
            ((action='remember' AND before IS NULL AND after IS NOT NULL)
            OR (action='update' AND before IS NOT NULL AND after IS NOT NULL)
            OR (action='forget' AND before IS NOT NULL AND after IS NULL)))),
    CHECK ((request_id IS NULL) = (request_hash IS NULL)),
    CHECK (error_code IS NULL OR status='conflict'),
    UNIQUE(user_id,request_id),
    FOREIGN KEY(conversation_id,user_id) REFERENCES agent_conversations(id,user_id) ON DELETE CASCADE,
    FOREIGN KEY(run_id,conversation_id,user_id) REFERENCES agent_runs(id,conversation_id,user_id) ON DELETE SET NULL (run_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_memory_proposals_conversation ON agent_memory_proposals(user_id,conversation_id,created_at DESC);
-- Forgetting a fact redacts all snapshots, including confirmations in other chats.
CREATE INDEX IF NOT EXISTS idx_agent_memory_proposals_memory ON agent_memory_proposals(user_id,memory_id);
CREATE INDEX IF NOT EXISTS idx_agent_memory_proposals_result ON agent_memory_proposals(user_id,result_memory_id);

COMMIT;
