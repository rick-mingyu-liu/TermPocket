import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { PoolClient } from 'pg';
import { query, getPool } from '../db/connection';
import config = require('../config');
import logger = require('../utils/logger');
import type { AccessTokenRow } from '../types/db';
import { errorSummary } from '../utils/errorSummary';

/**
 * Personal access tokens: how another app reads your numbers without your
 * password or your login JWT. A token only ever reaches POST /mcp, whose tools
 * read and never write — the login JWT, by contrast, can delete every
 * transaction you have. Only the SHA-256 of a token is stored; the token
 * itself is shown once, when it is created. Migration 012 has the table.
 *
 * Tokens expire config.accessTokens.ttlDays after creation (migration 023,
 * `expires_at`, compared with the database's now()). The code runs before 023
 * too: it probes for the column, caching only a positive answer, and without
 * it tokens never expire, exactly as before.
 */

/** Every token starts with this, so one pasted somewhere it shouldn't be is recognisable. */
const PREFIX = 'mgo_';
const TOKEN = /^mgo_[A-Za-z0-9_-]{43}$/;
export const MAX_TOKENS_PER_USER = 5;

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export const looksLikeToken = (value: unknown): value is string => typeof value === 'string' && TOKEN.test(value);

/**
 * A token as its owner may see it: everything but the hash and the user id,
 * plus whether it has expired by the database's clock. Before migration 023
 * `expires_at` is null and `expired` false.
 */
export type TokenSummary = Omit<AccessTokenRow, 'token_hash' | 'user_id'> & { expired: boolean };

/** The shared demo account cannot create access tokens. */
export class DemoTokenError extends Error {}

/** The password given to create a token does not match the account's. */
export class TokenPasswordError extends Error {}

/**
 * Who vouches for a new token. The web path proves the account's password;
 * the CLI (`npm run access-token`) is an operator tool, run by whoever already
 * holds the database credentials, and says so explicitly. A required argument
 * rather than an optional password, so forgetting it is a type error and not a
 * silently skipped check.
 */
export type CreateAuthorization = { password: string } | { operator: true };

const EXPIRY_PROBE =
  "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() " +
  "AND table_name = 'access_tokens' AND column_name = 'expires_at') AS present";

// Migration 023 may land after this code. Only a positive answer is cached, so
// applying it later needs no restart.
let expirySeen = false;

/** Whether migration 023 has been applied. `run` lets a transaction ask on its own connection. */
async function expiryAvailable(run: (text: string) => Promise<{ rows: Array<{ present: boolean }> }> = (text) => query<{ present: boolean }>(text)): Promise<boolean> {
  if (expirySeen) return true;
  const result = await run(EXPIRY_PROBE);
  expirySeen = result.rows[0]?.present === true;
  return expirySeen;
}

/** Test hook: forget a cached positive probe. */
export function resetExpiryProbe(): void {
  expirySeen = false;
}

/** The SQL that yields `expires_at` and `expired` for a summary, with and without 023. */
const summaryColumns = (withExpiry: boolean): string => withExpiry
  ? 'id, name, created_at, last_used_at, revoked_at, expires_at, (expires_at IS NOT NULL AND expires_at <= now()) AS expired'
  : 'id, name, created_at, last_used_at, revoked_at, NULL::timestamptz AS expires_at, FALSE AS expired';

/** Not revoked and, after 023, not expired: what opens /mcp and counts toward the limit. */
const usable = (withExpiry: boolean): string => withExpiry
  ? 'revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())'
  : 'revoked_at IS NULL';

/**
 * Hashes of tokens that authenticated in the last five minutes, so /mcp's
 * per-IP failure budget throttles only unknown tokens: a valid client behind
 * a shared address is not locked out by someone else's stale one. It decides
 * nothing about access — every request is still looked up.
 */
const recentlyValid = new Map<string, number>();
const RECENT_MS = 5 * 60 * 1000;
const RECENT_MAX = 1000;
export function authenticatedRecently(token: string): boolean {
  if (!looksLikeToken(token)) return false;
  const at = recentlyValid.get(hashToken(token));
  return at !== undefined && Date.now() - at < RECENT_MS;
}
function rememberValid(hash: string): void {
  recentlyValid.delete(hash);
  const oldest = recentlyValid.keys().next();
  if (recentlyValid.size >= RECENT_MAX && !oldest.done) recentlyValid.delete(oldest.value);
  recentlyValid.set(hash, Date.now());
}

/**
 * Creates a token for a user. Returns the token itself, which is never stored
 * and cannot be shown again, and the row as listTokens would show it.
 *
 * Throws DemoTokenError for the demo account (checked first, whatever the
 * password), TokenPasswordError when `authorization` carries a password that
 * does not match, and RangeError at the active-token limit; nothing is
 * inserted in those cases.
 */
export async function createToken(userId: number, name: string, authorization: CreateAuthorization): Promise<{ id: number; token: string; summary: TokenSummary }> {
  const token = PREFIX + randomBytes(32).toString('base64url');
  // The limit must hold when two requests create at once, which the web UI
  // makes possible. A count inside the INSERT does not: at READ COMMITTED both
  // statements can see four active tokens and both insert. So the user's row is
  // locked first and the count runs in a later statement, whose snapshot is
  // taken after the lock is granted and therefore sees the other's insert.
  // NO KEY UPDATE rather than UPDATE, so the lock does not block the KEY SHARE
  // locks that every foreign-key insert for this user (a transaction, a goal)
  // takes on the same row.
  //
  // A dedicated client, because BEGIN and COMMIT through db.query could land
  // on different pooled connections.
  const client: PoolClient = await getPool().connect();
  try {
    await client.query('BEGIN');
    const user = await client.query<{ is_demo: boolean; password_hash: string }>(
      'SELECT is_demo, password_hash FROM users WHERE id = $1 FOR NO KEY UPDATE',
      [userId]
    );
    const found = user.rows[0];
    // The demo login is public: its tokens would be anyone's to use and revoke.
    if (found?.is_demo === true) throw new DemoTokenError();
    // Only an explicit operator authorization skips the password; anything
    // else must carry a string that matches. A login JWT alone is not enough
    // to mint a credential that outlives it.
    if (!('operator' in authorization && authorization.operator === true)) {
      const password = 'password' in authorization ? authorization.password : undefined;
      if (found === undefined || typeof password !== 'string' || !(await bcrypt.compare(password, found.password_hash))) {
        throw new TokenPasswordError();
      }
    }
    const withExpiry = await expiryAvailable((text) => client.query<{ present: boolean }>(text));
    const active = await client.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM access_tokens WHERE user_id = $1 AND ${usable(withExpiry)}`,
      [userId]
    );
    if ((active.rows[0]?.n ?? 0) >= MAX_TOKENS_PER_USER) {
      throw new RangeError(`at most ${MAX_TOKENS_PER_USER} active tokens; revoke one first`);
    }
    const created = withExpiry
      ? await client.query<TokenSummary>(
        `INSERT INTO access_tokens (user_id, name, token_hash, expires_at) VALUES ($1, $2, $3, now() + make_interval(days => $4))
         RETURNING ${summaryColumns(true)}`,
        [userId, name.slice(0, 60), hashToken(token), config.accessTokens.ttlDays]
      )
      : await client.query<TokenSummary>(
        `INSERT INTO access_tokens (user_id, name, token_hash) VALUES ($1, $2, $3)
         RETURNING ${summaryColumns(false)}`,
        [userId, name.slice(0, 60), hashToken(token)]
      );
    await client.query('COMMIT');
    const summary = created.rows[0];
    if (summary === undefined) throw new Error('INSERT returned no row');
    // Ids only: never the name, the token or its hash.
    logger.audit('Access token created', { userId, tokenId: summary.id });
    return { id: summary.id, token, summary };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** The user a token belongs to, or null when it is unknown, revoked or expired. Marks it used. */
export async function userForToken(token: string): Promise<number | null> {
  if (!looksLikeToken(token)) return null;
  // A read, and a write of last_used_at at most every five minutes per token,
  // so a busy client does not turn every request into a row update.
  const hash = hashToken(token);
  const withExpiry = await expiryAvailable();
  const found = await query<Pick<AccessTokenRow, 'id' | 'user_id'> & { stale: boolean }>(
    `SELECT id, user_id, (last_used_at IS NULL OR last_used_at < now() - interval '5 minutes') AS stale
     FROM access_tokens WHERE token_hash = $1 AND ${usable(withExpiry)}`,
    [hash]
  );
  const row = found.rows[0];
  // A revoked or expired token is throttled again from its first refusal.
  if (row === undefined) { recentlyValid.delete(hash); return null; }
  rememberValid(hash);
  // Bookkeeping: a failed write must not refuse a request the token allows.
  if (row.stale) {
    await query('UPDATE access_tokens SET last_used_at = now() WHERE id = $1', [row.id])
      .catch((error: unknown) => console.error('Access token last_used_at write failed:', { tokenId: row.id, ...errorSummary(error) }));
  }
  return row.user_id;
}

/** A user's tokens, newest first, without their hashes. */
export async function listTokens(userId: number): Promise<TokenSummary[]> {
  const withExpiry = await expiryAvailable();
  const rows = await query<TokenSummary>(
    `SELECT ${summaryColumns(withExpiry)} FROM access_tokens
     WHERE user_id = $1 ORDER BY created_at DESC, id DESC`,
    [userId]
  );
  return rows.rows;
}

/**
 * Revokes one of a user's tokens. Resolves to whether it was not yet revoked.
 * An expired token can still be revoked, which moves it out of the list of
 * connections the owner has to think about.
 */
export async function revokeToken(userId: number, id: number): Promise<boolean> {
  const result = await query(
    'UPDATE access_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL',
    [id, userId]
  );
  const revoked = (result.rowCount ?? 0) > 0;
  if (revoked) logger.audit('Access token revoked', { userId, tokenId: id });
  return revoked;
}
