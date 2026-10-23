import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { packageRoot } from '../utils/packageRoot';

const root = packageRoot(__dirname);
const migrationPath = path.join(root, 'db/migrations/022_agent_memories.sql');
const MARKER = '-- Approved durable facts and their button-confirmed proposals (migration 022).';
const TABLES = ['agent_memories', 'agent_memory_proposals'];

test('migration 022 is recorded alongside its fresh-install schema', () => {
  assert.ok(existsSync(migrationPath), 'the repeatable memory migration is missing');
  assert.ok(readFileSync(path.join(root, 'db/schema.sql'), 'utf8').includes(MARKER));
});

test('migration 022: fresh and upgrade are repeatable, preserve rows and enforce ownership and redaction', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const client = await pool.connect();
  const schema = `memories_${randomUUID().replaceAll('-', '')}`;
  const desired = readFileSync(path.join(root, 'db/schema.sql'), 'utf8');
  const migration = readFileSync(migrationPath, 'utf8');
  const reset = async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
  };
  const shape = async () => (await client.query(`SELECT table_name,column_name,data_type,is_nullable,column_default
    FROM information_schema.columns WHERE table_schema=$1 AND table_name=ANY($2::text[]) ORDER BY table_name,ordinal_position`, [schema, TABLES])).rows;
  const constraints = async () => (await client.query(`SELECT t.relname,pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname=$1 AND t.relname=ANY($2::text[]) ORDER BY 1,2`, [schema, TABLES])).rows;
  const indexes = async () => (await client.query(`SELECT tablename,indexname,indexdef FROM pg_indexes
    WHERE schemaname=$1 AND tablename=ANY($2::text[]) ORDER BY 1,2`, [schema, TABLES])).rows;
  try {
    await reset();
    await client.query(desired);
    const expected = { shape: await shape(), constraints: await constraints(), indexes: await indexes() };
    assert.ok(expected.shape.length > 0);
    await client.query(migration);
    await client.query(migration);
    assert.deepEqual({ shape: await shape(), constraints: await constraints(), indexes: await indexes() }, expected);

    await reset();
    // Remove only the newly added memory section: every pre-022 table remains.
    const memoryStart = desired.indexOf(MARKER);
    const ledgerStart = desired.indexOf('-- Which files in db/migrations/');
    assert.ok(memoryStart >= 0 && ledgerStart > memoryStart);
    await client.query(desired.slice(0, memoryStart) + desired.slice(ledgerStart));
    assert.deepEqual(await shape(), []);
    const user = async (name: string) => (await client.query<{ id: number }>("INSERT INTO users(email,password_hash,first_name,last_name) VALUES($1,'x',$2,'Memory') RETURNING id", [`${name}@example.invalid`, name])).rows[0]!.id;
    const alice = await user('alice'); const bob = await user('bob');
    const conversation = randomUUID(); const foreignConversation = randomUUID(); const run = randomUUID();
    await client.query("INSERT INTO agent_conversations(id,user_id,currency,timezone,language) VALUES($1,$2,'CAD','UTC','auto'),($3,$4,'CAD','UTC','auto')", [conversation, alice, foreignConversation, bob]);
    await client.query("INSERT INTO agent_runs(id,conversation_id,user_id,request_hash,status) VALUES($1,$2,$3,$4,'complete')", [run, conversation, alice, 'a'.repeat(64)]);
    await client.query("INSERT INTO transactions(user_id,amount,description,category,type,date,currency) VALUES($1,12.50,'Fictional lunch','Dining Out','expense','2026-10-23','CAD')", [alice]);
    const before = (await client.query('SELECT * FROM transactions')).rows;
    await client.query(migration);
    await client.query(migration);
    assert.deepEqual({ shape: await shape(), constraints: await constraints(), indexes: await indexes() }, expected);
    assert.deepEqual((await client.query('SELECT * FROM transactions')).rows, before);

    const memory = randomUUID();
    await client.query("INSERT INTO agent_memories(id,user_id,kind,text,amount,currency,cadence,source_conversation_id) VALUES($1,$2,'expense','Fictional rent',950.00,'CAD','month',$3)", [memory, alice, conversation]);
    const wrongOwner = () => client.query("INSERT INTO agent_memories(id,user_id,kind,text,source_conversation_id) VALUES($1,$2,'other','x',$3)", [randomUUID(), bob, conversation]);
    await assert.rejects(wrongOwner(), { code: '23503' });
    for (const [field, value] of [['kind', 'invalid'], ['text', ''], ['text', 'x'.repeat(121)], ['text', 'bidi\u202e'], ['text', 'control\n'], ['amount', 0], ['amount', -1], ['amount', 'NaN'], ['currency', 'JPY'], ['cadence', 'year']] as const) {
      await assert.rejects(client.query(`UPDATE agent_memories SET ${field}=$1 WHERE id=$2`, [value, memory]), { code: '23514' });
    }
    await assert.rejects(client.query('UPDATE agent_memories SET currency=NULL WHERE id=$1', [memory]), { code: '23514' });
    await assert.rejects(client.query('UPDATE agent_memories SET amount=NULL WHERE id=$1', [memory]), { code: '23514' });
    await assert.rejects(client.query('UPDATE agent_memories SET amount=100000000 WHERE id=$1', [memory]), { code: '22003' });
    const version = (await client.query<{ version: string }>("SELECT to_char(updated_at,'YYYY-MM-DD HH24:MI:SS.US') AS version FROM agent_memories WHERE id=$1", [memory])).rows[0]!.version;
    await client.query("UPDATE agent_memories SET text='Changed fictional rent' WHERE id=$1", [memory]);
    assert.notEqual((await client.query<{ version: string }>("SELECT to_char(updated_at,'YYYY-MM-DD HH24:MI:SS.US') AS version FROM agent_memories WHERE id=$1", [memory])).rows[0]!.version, version);

    const proposal = randomUUID();
    const after = { kind: 'expense', text: 'Fictional rent', amount: '950.00', currency: 'CAD', cadence: 'month' };
    await client.query("INSERT INTO agent_memory_proposals(id,conversation_id,user_id,run_id,action,kind,after) VALUES($1,$2,$3,$4,'remember','expense',$5)", [proposal, conversation, alice, run, after]);
    await assert.rejects(client.query("INSERT INTO agent_memory_proposals(id,conversation_id,user_id,action,kind,after) VALUES($1,$2,$3,'remember','expense',$4)", [randomUUID(), foreignConversation, alice, after]), { code: '23503' });
    await assert.rejects(client.query("INSERT INTO agent_memory_proposals(id,conversation_id,user_id,run_id,action,kind,after) VALUES($1,$2,$3,$4,'remember','expense',$5)", [randomUUID(), foreignConversation, bob, run, after]), { code: '23503' });
    await assert.rejects(client.query("UPDATE agent_memory_proposals SET action='update' WHERE id=$1", [proposal]), { code: '23514' });
    await assert.rejects(client.query('UPDATE agent_memory_proposals SET redacted_at=now() WHERE id=$1', [proposal]), { code: '23514' });
    await assert.rejects(client.query("UPDATE agent_memory_proposals SET status='cancelled' WHERE id=$1", [proposal]), { code: '23514' });
    await assert.rejects(client.query("UPDATE agent_memory_proposals SET after='[]' WHERE id=$1", [proposal]), { code: '23514' });
    await assert.rejects(client.query('UPDATE agent_memory_proposals SET after=$1 WHERE id=$2', [{ text: 'x'.repeat(4096) }, proposal]), { code: '23514' });
    await assert.rejects(client.query('UPDATE agent_memory_proposals SET request_id=$1 WHERE id=$2', [randomUUID(), proposal]), { code: '23514' });
    await client.query("UPDATE agent_memory_proposals SET status='cancelled',before=NULL,after=NULL,redacted_at=now(),decided_at=now() WHERE id=$1", [proposal]);
    await client.query('DELETE FROM agent_runs WHERE id=$1', [run]);
    assert.equal((await client.query('SELECT run_id FROM agent_memory_proposals WHERE id=$1', [proposal])).rows[0].run_id, null);
    await client.query('DELETE FROM agent_conversations WHERE id=$1', [conversation]);
    assert.equal((await client.query('SELECT source_conversation_id FROM agent_memories WHERE id=$1', [memory])).rows[0].source_conversation_id, null);
    assert.equal((await client.query('SELECT 1 FROM agent_memory_proposals WHERE id=$1', [proposal])).rowCount, 0);
    await client.query('DELETE FROM users WHERE id=$1', [alice]);
    assert.equal((await client.query('SELECT 1 FROM agent_memories WHERE id=$1', [memory])).rowCount, 0);

    await reset();
    await client.query(desired.split('-- Conversation records never own saved transactions:')[0]!);
    await assert.rejects(client.query(migration), /Apply migration 013/);
    await client.query('ROLLBACK');
    assert.deepEqual(await shape(), []);
  } finally {
    await client.query('ROLLBACK');
    await client.query('SET search_path TO public');
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    client.release();
    await pool.end();
  }
});
