import { query } from '../db/connection';
import config = require('../config');

/**
 * Acceptance of the Terms of Service and Privacy Policy.
 *
 * `users.terms_version` (migration 017) is the version a user accepted, and
 * `config.legal.termsVersion` the current one. Registration stores it when the
 * box is ticked; anyone else — every account created before this existed, and
 * everyone after the version changes — is `required` until they accept, which
 * the frontend asks once after sign-in. So nobody is asked at every login:
 * only when their stored version differs from the current one.
 *
 * **The demo account is never asked.** It is shared by every visitor, so one
 * visitor's acceptance cannot stand for the next one's.
 *
 * Without migration 017 nobody is asked and nothing is stored.
 */

const COLUMN_PROBE =
  "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() " +
  "AND table_name = 'users' AND column_name = 'terms_version') AS present";

// Migration 017 may land after this code. Only a positive answer is cached, so
// applying it later needs no restart.
let columnSeen = false;

/** Whether migration 017 has been applied. */
async function termsAvailable(): Promise<boolean> {
  if (columnSeen) return true;
  const result = await query<{ present: boolean }>(COLUMN_PROBE);
  columnSeen = result.rows[0]?.present === true;
  return columnSeen;
}

/** Test hook: forget a cached positive probe. */
function resetTermsProbe(): void {
  columnSeen = false;
}

const currentVersion = (): string => config.legal.termsVersion;

interface TermsStatus {
  currentVersion: string;
  acceptedVersion: string | null;
  /** Whether the app must ask before going on. */
  required: boolean;
}

class TermsVersionError extends Error {
  code = 'terms_version_mismatch';
  constructor() {
    super('These are not the current terms');
    this.name = 'TermsVersionError';
  }
}

class TermsUserNotFoundError extends Error {
  code = 'terms_user_not_found';
  constructor() {
    super('User not found');
    this.name = 'TermsUserNotFoundError';
  }
}

/** The user's acceptance state. */
async function termsStatus(userId: number): Promise<TermsStatus> {
  const current = currentVersion();
  if (!(await termsAvailable())) return { currentVersion: current, acceptedVersion: null, required: false };
  const result = await query<{ terms_version: string | null; is_demo: boolean }>(
    'SELECT terms_version, is_demo FROM users WHERE id = $1',
    [userId]
  );
  const row = result.rows[0];
  if (!row) throw new TermsUserNotFoundError();
  return {
    currentVersion: current,
    acceptedVersion: row.terms_version,
    required: !row.is_demo && row.terms_version !== current,
  };
}

/**
 * Records that the user accepted `version`, which must be the current one: a
 * card left open across a deploy that changed the terms must not record the
 * new version for text the user never saw. The demo account stores nothing.
 */
async function acceptTerms(userId: number, version: string): Promise<TermsStatus> {
  if (version !== currentVersion()) throw new TermsVersionError();
  if (!(await termsAvailable())) return { currentVersion: version, acceptedVersion: null, required: false };
  const result = await query<{ terms_version: string | null }>(
    'UPDATE users SET terms_version = $1, terms_accepted_at = NOW() WHERE id = $2 AND NOT is_demo RETURNING terms_version',
    [version, userId]
  );
  if (result.rows.length === 0) return termsStatus(userId);
  return { currentVersion: version, acceptedVersion: version, required: false };
}

export {
  termsAvailable,
  resetTermsProbe,
  currentVersion,
  termsStatus,
  acceptTerms,
  TermsVersionError,
  TermsUserNotFoundError,
};
export type { TermsStatus };
