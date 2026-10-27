import { query } from '../db/connection';

/**
 * Whether `userId` is the shared demo account (`users.is_demo`, migration 007).
 * Its login is public, so a bulk delete on it would empty the app for every
 * visitor until the hourly demo refresh restores it. The clear-all endpoints
 * ask this first and answer 403 `clear_demo`.
 */
async function isDemoAccount(userId: number): Promise<boolean> {
  const result = await query<{ is_demo: boolean }>('SELECT is_demo FROM users WHERE id = $1', [userId]);
  return result.rows[0]?.is_demo === true;
}

/** The 403 body both clear-all endpoints send for the demo account. */
const CLEAR_DEMO_REFUSAL = {
  error: 'The demo account is shared and cannot be cleared',
  code: 'clear_demo',
} as const;

export { isDemoAccount, CLEAR_DEMO_REFUSAL };
