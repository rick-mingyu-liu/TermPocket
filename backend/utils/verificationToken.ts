import { createHash, randomBytes } from 'node:crypto';

/**
 * Email verification tokens. The token verifies an account on its own, so only
 * its SHA-256 is stored (users.email_verification_token), like access tokens:
 * a leaked database or backup holds nothing a link could be rebuilt from. The
 * token itself exists only in the email and in the link the user clicks.
 */

/** The stored form of a token. */
export const hashVerificationToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/** A new token for the email, and the hash to store. */
export const newVerificationToken = (): { token: string; hash: string } => {
  const token = randomBytes(32).toString('hex');
  return { token, hash: hashVerificationToken(token) };
};
