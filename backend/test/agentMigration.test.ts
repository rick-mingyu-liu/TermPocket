import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { packageRoot } from '../utils/packageRoot';

// All DDL is isolated in random schemas of the explicitly opted-in test DB.
test('agent migration: fresh twice, legacy upgrade twice, audit refuses incompatible data without rewrite', { skip: !process.env.TEST_DATABASE_URL },async()=>{
  const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL});const client=await pool.connect();
  const schema=`agent_migration_${randomUUID().replaceAll('-','')}`;
  const root=packageRoot(__dirname);const desired=readFileSync(path.join(root,'db/schema.sql'),'utf8');const migration=readFileSync(path.join(root,'db/migrations/013_conversational_transactions.sql'),'utf8');
  try {
    await client.query(`CREATE SCHEMA ${schema}`);await client.query(`SET search_path TO ${schema}`);
    await client.query(desired);await client.query(desired);
    assert.equal((await client.query("SELECT count(*) FROM information_schema.tables WHERE table_schema=$1 AND table_name LIKE 'agent_%'",[schema])).rows[0].count,'9');
    await client.query(`DROP SCHEMA ${schema} CASCADE`);await client.query(`CREATE SCHEMA ${schema}`);await client.query(`SET search_path TO ${schema}`);
    // Build the pre-013 state from the synchronized source: retain the seven
    // original tables and existing triggers, without conversational tables.
    const previous=desired.split('-- Conversation records never own saved transactions:')[0]!.replace("'ocr_llm', 'agent'","'ocr_llm'");
    await client.query(previous);
    const user=(await client.query("INSERT INTO users(email,password_hash,first_name,last_name) VALUES('fiction@example.invalid','x','Migration','Test') RETURNING id")).rows[0].id;
    await client.query("INSERT INTO transactions(user_id,amount,description,category,type,date,currency,source) VALUES($1,12.50,'Fictional','Dining Out','expense','2026-10-14','CAD','manual')",[user]);
    await client.query(migration);await client.query(migration);
    assert.equal((await client.query('SELECT source FROM transactions')).rows[0].source,'manual');
    await client.query('ALTER TABLE transactions DROP CONSTRAINT transactions_source_check');await client.query('ALTER TABLE transactions ALTER COLUMN source DROP NOT NULL');
    await client.query("INSERT INTO transactions(user_id,amount,description,category,type,date,currency,source) VALUES($1,1,'Fictional invalid','Dining Out','expense','2026-10-14','CAD','legacy'),($1,1,'Fictional null','Dining Out','expense','2026-10-14','CAD',NULL)",[user]);
    await assert.rejects(client.query(migration),(error:unknown)=>error instanceof Error&&error.message.includes('2 incompatible rows'));
    await client.query('ROLLBACK');
    assert.equal((await client.query("SELECT count(*) FROM transactions WHERE source='legacy' OR source IS NULL")).rows[0].count,'2');
  } finally {await client.query('ROLLBACK');await client.query('SET search_path TO public');await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);client.release();await pool.end();}
});
