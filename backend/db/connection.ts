import pg, { Pool, types, type QueryResult, type QueryResultRow, type PoolConfig } from 'pg';
import config = require('../config');

// A DATE column is a calendar day: no time, no zone. node-pg turns it into a
// JS Date at local midnight, and res.json() then serialises that through
// toISOString(), so one stored day leaves the server as a different string
// depending on where the server runs:
//
//   stored 2026-08-28  ->  UTC (Render)     '2026-08-28T00:00:00.000Z'
//                      ->  Toronto (laptop) '2026-08-28T04:00:00.000Z'
//                      ->  Shanghai         '2026-08-27T16:00:00.000Z'
//
// Both halves of that are bugs. A client rendering it with `new Date(...)`
// shows the previous day for every viewer west of the server — which is why
// the transactions list read a day early against Render and looked fine in
// local dev. And the edit form, which takes the day part of the string, reads
// the wrong day outright on any server east of UTC, then writes it back on
// save; that one moves the row, not just its label.
//
// Handing back the raw 'YYYY-MM-DD' makes the wire format identical on every
// host, and leaves the value the only thing it ever was: a day.
types.setTypeParser(types.builtins.DATE, (value: string) => value);

// A TIMESTAMP column (no zone) holds a UTC wall-clock time, because every
// session runs in UTC (see createPool). Since migration 020 no table has one
// (users, transactions, goals, import batches and tokens became TIMESTAMPTZ),
// but a database before 020 still does, so this stays.
// node-pg reads such a value as the *process's* local time and writes a Date
// parameter in local time with an offset that PostgreSQL then drops, so both
// directions were right only while the server process also ran in UTC. Under
// Toronto time an email verification link expired four hours late. Read and
// write it as UTC, so the host's timezone never enters. TIMESTAMPTZ already
// carries its offset and is unaffected.
const TIMESTAMP_TEXT = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/;
types.setTypeParser(types.builtins.TIMESTAMP, (value: string) => {
  const match = TIMESTAMP_TEXT.exec(value);
  // 'infinity', BC years and the like: hand back the text rather than a wrong instant.
  return match ? new Date(`${match[1]}T${match[2]}Z`) : value;
});
pg.defaults.parseInputDatesAsUTC = true;

const INACTIVITY_LIMIT = 5 * 60 * 1000; // 5 minutes
let pool: Pool | null = null;
let inactivityTimer: NodeJS.Timeout | null = null;

// Pin the schema explicitly. Every query in this codebase names tables
// unqualified, which only resolves if search_path includes public. Neon's
// *Azure* pooler handed out sessions with an EMPTY search_path, where those
// queries all failed with 'relation "transactions" does not exist'; the AWS
// pooler this project now runs on hands out a normal "$user", public. So this
// is defensive rather than load-bearing today — it costs one statement per
// connection and makes the app behave identically on any endpoint.
const SEARCH_PATH = config.database.schema;

const baseOptions = {
  ssl: config.nodeEnv === 'production' ? { rejectUnauthorized: false } : false,
  idleTimeoutMillis: 30000, // 30 seconds
};

const connectionOptions: PoolConfig = config.database.url
  ? {
      ...baseOptions,
      connectionString: config.database.url,
    }
  : {
      ...baseOptions,
      user: config.database.user,
      password: config.database.password,
      host: config.database.host,
      // config.database.port is the raw DB_PORT string (or undefined).
      // PoolConfig types port as a number, but pg re-parses it itself with
      // parseInt(val('port', config), 10), so the string is handed over
      // exactly as before rather than pre-converted: Number() would turn a
      // malformed DB_PORT (falsy as NaN) into a silent fallback to the
      // default port instead of the loud connection failure a bad port
      // produces today.
      port: config.database.port as unknown as number,
      database: config.database.database,
    };

function createPool(): Pool {
  const newPool = new Pool(connectionOptions);
  newPool.on('connect', (client) => {
    // Queued before the client is handed out, so it runs ahead of any real
    // query on this connection. It cannot go in the pool's `options` instead:
    // Neon's pooler rejects search_path as a startup parameter.
    // UTC session: now() and CURRENT_TIMESTAMP write UTC into TIMESTAMP
    // columns, matching the parser above. Render and Neon default to UTC
    // already; a developer machine or another host may not.
    client.query(`SET search_path TO ${SEARCH_PATH}; SET TIME ZONE 'UTC'`).catch((err) => {
      console.error('❌ Failed to set search_path or time zone', err);
    });
    console.log('✅ Connected to PostgreSQL database');
  });
  newPool.on('error', (err) => {
    console.error('❌ Unexpected error on idle client', err);
    process.exit(-1);
  });
  return newPool;
}

function getPool(): Pool {
  if (!pool) {
    pool = createPool();
  }
  const activePool: Pool = pool;
  // Reset inactivity timer
  if (inactivityTimer) clearTimeout(inactivityTimer);
  inactivityTimer = setTimeout(() => {
    if (pool) {
      console.log('⌛ No DB activity for 5 minutes. Closing pool and disconnecting from database.');
      pool.end();
      pool = null;
      console.log('🛑 DB pool closed due to inactivity');
    }
  }, INACTIVITY_LIMIT);
  // Housekeeping only: it must not be the reason the process stays alive. A
  // script or test that finishes its queries should exit immediately, not hang
  // for the remaining five minutes.
  inactivityTimer.unref();
  return activePool;
}

async function query<R extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<R>> {
  const activePool = getPool();
  return activePool.query<R>(text, params);
}

export { query, getPool };
