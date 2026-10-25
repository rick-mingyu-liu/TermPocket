import 'dotenv/config';
import { query, getPool } from './connection';
import { createToken, listTokens, revokeToken } from '../services/accessTokens';
import { formatDay } from '../utils/dates';

/**
 * Personal access tokens for POST /mcp, from the command line, against the
 * database in DATABASE_URL:
 *
 *   npm run access-token -- create you@example.com "DearByte"
 *   npm run access-token -- list you@example.com
 *   npm run access-token -- revoke you@example.com 3
 *
 * `create` prints the token once; only its hash is stored.
 */

const usage = 'usage: npm run access-token -- create <email> [name] | list <email> | revoke <email> <id>';

async function main(): Promise<void> {
  const [command, email, extra] = process.argv.slice(2);
  if (!command || !email) throw new Error(usage);
  const user = await query<{ id: number }>('SELECT id FROM users WHERE email = $1', [email]);
  const userId = user.rows[0]?.id;
  if (userId === undefined) throw new Error('no account with that email');

  if (command === 'create') {
    // An operator tool: whoever runs it already holds the database
    // credentials, so it does not ask for the account's password.
    const { id, token } = await createToken(userId, extra?.trim() || 'personal agent', { operator: true });
    console.log(`Created token ${id}. Copy it now; it is not shown again:\n\n  ${token}\n`);
    console.log('It can only read term totals, the monthly baseline and goals through POST /mcp.');
  } else if (command === 'list') {
    const tokens = await listTokens(userId);
    if (tokens.length === 0) console.log('No tokens.');
    for (const t of tokens) {
      const state = t.revoked_at
        ? `revoked ${formatDay(t.revoked_at)}`
        : t.expired ? `expired ${formatDay(t.expires_at)}` : `last used ${formatDay(t.last_used_at, 'never')}`;
      const expiry = t.revoked_at || t.expired ? '' : `  expires ${formatDay(t.expires_at, 'never')}`;
      console.log(`${t.id}  ${t.name}  created ${formatDay(t.created_at)}  ${state}${expiry}`);
    }
  } else if (command === 'revoke') {
    const id = Number(extra);
    if (!Number.isInteger(id)) throw new Error(usage);
    console.log((await revokeToken(userId, id)) ? `Revoked token ${id}.` : `No active token ${id} on that account.`);
  } else {
    throw new Error(usage);
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => getPool().end());
