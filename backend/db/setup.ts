import fs from 'node:fs';
import path from 'node:path';
import { query, getPool } from './connection';
import { packageRoot } from '../utils/packageRoot';
import { listMigrations, recordApplied } from './migrate';

async function setupDatabase(): Promise<void> {
  try {
    console.log('🔧 Setting up database schema...');

    // Fresh means no app tables yet. Only then does schema.sql's end state
    // stand for every migration; on an existing database the records are
    // left to `npm run db:migrate`, since schema.sql's CREATE ... IF NOT
    // EXISTS adds nothing to tables that are already there.
    const fresh = (await query<{ fresh: boolean }>("SELECT to_regclass('users') IS NULL AS fresh")).rows[0]?.fresh === true;

    // Read and execute schema
    const schemaPath = path.join(packageRoot(__dirname), 'db', 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');

    await query(schema);
    console.log('✅ Database schema created successfully');

    if (fresh) {
      const client = await getPool().connect();
      try {
        const recorded = await recordApplied(client, listMigrations());
        console.log(`✅ Recorded ${recorded} migration(s) as applied (schema.sql includes them)`);
      } finally {
        client.release();
      }
    } else {
      console.log('ℹ️  Existing database: run `npm run db:migrate -- --status` to see which migrations are recorded');
    }

  } catch (error) {
    console.error('❌ Error setting up database:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  setupDatabase();
}

export = setupDatabase;
