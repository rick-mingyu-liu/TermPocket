import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt, { SignOptions } from 'jsonwebtoken';
import { validationResult } from 'express-validator';
import { query } from '../db/connection';
import config = require('../config');
import { maskEmail } from '../utils/privacy';
import { sendWeeklyReport, generateWeeklyReport, sendEmailVerification } from '../services/emailService';
import { validateEmail } from '../services/emailValidationService';
import { reclaimStaleUnverifiedAccount } from '../services/cleanupService';
import * as accountService from '../services/accountService';
import * as termsService from '../services/termsService';
import logger = require('../utils/logger');
import { errorSummary } from '../utils/errorSummary';
import { newVerificationToken, hashVerificationToken } from '../utils/verificationToken';

// The columns the SELECT below names — narrower than the full UserRow.
interface ExistingUserRow {
  id: number;
  email: string;
  email_verified: boolean | null;
}

// The columns the INSERT ... RETURNING below names.
interface NewUserRow {
  id: number;
  email: string;
  first_name: string;
  last_name: string;
  created_at: Date | null;
  email_verification_expires: Date | null;
}

// The columns the SELECT below names, for checking a login attempt.
interface LoginUserRow {
  id: number;
  email: string;
  password_hash: string;
  first_name: string;
  last_name: string;
  email_verified: boolean | null;
}

// The columns the SELECT below names, for consuming a verification token.
interface VerifyEmailUserRow {
  id: number;
  email: string;
  first_name: string;
  email_verification_expires: Date | null;
  created_at: Date | null;
}

// The columns the SELECT below names, for resending a verification email.
interface ResendVerificationUserRow {
  id: number;
  email: string;
  first_name: string;
  email_verified: boolean | null;
  email_verification_expires: Date | null;
}

// The columns the SELECT below names, for a profile response.
interface ProfileRow {
  id: number;
  email: string;
  first_name: string;
  last_name: string;
  created_at: Date | null;
  weekly_reports_enabled: boolean;
  email_notifications_enabled: boolean;
}

// The columns both UPDATE ... RETURNING variants below name.
interface UpdatedProfileRow {
  id: number;
  email: string;
  first_name: string;
  last_name: string;
  language: string;
  updated_at: Date | null;
}

/**
 * The address forms to look a user up by: the normalized one routes/auth.ts
 * produced, and the address as typed (for the few accounts stored before
 * registration normalized addresses). Lookups prefer the normalized match.
 */
const lookupEmails = (req: Request, res: Response): [string, string] => {
  const normalized = String(req.body.email);
  const typed: unknown = res.locals.typedEmail;
  return [normalized, typeof typed === 'string' && typed ? typed : normalized];
};

const authController = {
  // Register new user
  async register(req: Request, res: Response) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { email, password, first_name, last_name, accept_terms } = req.body;

      // MailboxLayer where a key is configured, the disposable-domain list
      // where it is not. Never throws, so it cannot short-circuit the rest of
      // this handler the way it used to.
      const emailValidation = await validateEmail(email);
      if (!emailValidation.valid) {
        console.log(`[Register] Rejected ${maskEmail(email)}: ${emailValidation.reason} (${emailValidation.source})`);
        return res.status(400).json({ error: emailValidation.reason });
      }

      // Check if user already exists, in any case: a row from before
      // registration lowercased addresses can hold "Jane@Example.com", and
      // users.email is unique on lower(email) (migration 021). A verified
      // match comes first, so it is the one that refuses.
      const existingUser = await query<ExistingUserRow>(
        'SELECT id, email, email_verified FROM users WHERE lower(email) = lower($1) ORDER BY email_verified DESC NULLS LAST LIMIT 1',
        [email]
      );

      if (existingUser.rows.length > 0) {
        const existingId = existingUser.rows[0]!.id;
        if (existingUser.rows[0]!.email_verified) {
          console.log(`[Register] Attempt to register an already verified address: user ${existingId}`);
          return res.status(400).json({ error: 'User already exists' });
        }
        // An unverified registration whose link has lapsed (or that has hit
        // the hard cap) is due for deletion anyway; the hourly sweep may just
        // not have reached it. Replace it now, so whether the address can be
        // registered again never depends on when the sweep last ran. One still
        // inside its window is left alone: its owner may be about to verify.
        if (!(await reclaimStaleUnverifiedAccount(email))) {
          console.log(`[Register] Attempt to re-register an unverified address: user ${existingId}`);
          return res.status(400).json({ error: 'User already exists' });
        }
        console.log(`[Register] Replaced stale unverified registration: user ${existingId}`);
      }

      // Hash password
      const saltRounds = 10;
      const passwordHash = await bcrypt.hash(password, saltRounds);

      // Generate email verification token: the token goes in the email, only
      // its hash is stored.
      const { token: verificationToken, hash: verificationHash } = newVerificationToken();
      const verificationExpires = new Date(Date.now() + config.emailVerification.tokenExpiry);

      // The sign-up form's tick box. Without it (an old client), or before
      // migration 017, nothing is stored and the user is asked once after
      // signing in instead (services/termsService.ts).
      const recordTerms = accept_terms === true && await termsService.termsAvailable();

      // Create user with email verification fields
      const newUser = recordTerms
        ? await query<NewUserRow>(
          'INSERT INTO users (email, password_hash, first_name, last_name, email_verification_token, email_verification_expires, terms_version, terms_accepted_at) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW()) RETURNING id, email, first_name, last_name, created_at, email_verification_expires',
          [email, passwordHash, first_name, last_name, verificationHash, verificationExpires, termsService.currentVersion()]
        )
        : await query<NewUserRow>(
          'INSERT INTO users (email, password_hash, first_name, last_name, email_verification_token, email_verification_expires) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, email, first_name, last_name, created_at, email_verification_expires',
          [email, passwordHash, first_name, last_name, verificationHash, verificationExpires]
        );
      // RETURNING always answers with the row just inserted, so rows[0] is
      // never undefined here; the assertions below rely on the same fact.
      const userId = newUser.rows[0]!.id;
      console.log(`[Register] User created:`, {
        id: userId,
        email: maskEmail(email),
        created_at: newUser.rows[0]!.created_at,
        verification_expires: newUser.rows[0]!.email_verification_expires
      });

      // Send verification email
      try {
        // The token is a credential: it verifies the account on its own.
        console.log(`[Register] Sending verification email to user ${userId}`);
        await sendEmailVerification(email, first_name, verificationToken);
      } catch (emailError) {
        // Message and code rather than the whole error. A connection failure
        // carries no address (checked), but nodemailer attaches `envelope` and
        // `rejected` when the SMTP server rejects a recipient, and those hold
        // the address. Precautionary — that path is not reproducible without a
        // real SMTP server — and it reads better in a log either way.
        const code = emailError instanceof Error ? (emailError as Error & { code?: unknown }).code : undefined;
        console.error(`Failed to send verification email for user ${userId}:`, code || (emailError instanceof Error ? emailError.message : undefined));
        // Don't fail registration if email fails, but log it
      }

      res.status(201).json({
        message: 'Registration successful! Please check your email to verify your account.',
        user: newUser.rows[0],
        requiresVerification: true
      });

    } catch (error) {
      // A concurrent registration of the same address won the INSERT: the
      // unique index answers what the lookup above would have.
      if ((error as { code?: unknown }).code === '23505') {
        console.log('[Register] Lost a race for an address another registration just took');
        return res.status(400).json({ error: 'User already exists' });
      }
      console.error('Registration error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  },

  // Login user
  async login(req: Request, res: Response) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { password } = req.body;
      const [email, typed] = lookupEmails(req, res);

      // Find the account: the normalized address and, for an account stored
      // before normalization existed, the address as typed, each in any case
      // ("Jane@Example.com" stored, "jane@example.com" typed). Since migration
      // 021 lower(email) is unique, so that is at most two rows, which differ
      // only in Gmail dots or a +tag. The password decides between them,
      // normalized first, so the owner of either row can sign in.
      const candidates = await query<LoginUserRow>(
        'SELECT id, email, password_hash, first_name, last_name, email_verified FROM users WHERE lower(email) IN (lower($1), lower($2)) ORDER BY email = $1 DESC, email = $2 DESC, id',
        [email, typed]
      );

      let account: LoginUserRow | undefined;
      for (const row of candidates.rows) {
        if (await bcrypt.compare(password, row.password_hash)) {
          account = row;
          break;
        }
      }
      if (!account) {
        return res.status(400).json({ error: 'Invalid credentials' });
      }

      // Check if email is verified
      if (!account.email_verified) {
        return res.status(400).json({
          error: 'Please verify your email address before logging in. Check your inbox for a verification link.',
          requiresVerification: true
        });
      }

      // Generate JWT token
      // config.jwt.secret is typed string | undefined because it is read from
      // the environment, but config/validate.ts exits the process at boot when
      // it is unset, so every request that reaches this handler has one.
      const token = jwt.sign(
        // The stored address, which an as-typed match may spell differently.
        { userId: account.id, email: account.email },
        config.jwt.secret as string,
        // config.jwt.expiresIn is the literal '7d' at its declaration in
        // config/index.ts, which is a valid jsonwebtoken duration string; the
        // cast is only needed because config/index.ts doesn't declare it
        // `as const`, so TypeScript widens the field to plain string.
        { expiresIn: config.jwt.expiresIn as SignOptions['expiresIn'] }
      );

      const { password_hash, email_verified, ...userWithoutPassword } = account;

      res.json({
        message: 'Login successful',
        user: userWithoutPassword,
        token
      });

    } catch (error) {
      console.error('Login error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  },

  // Verify email
  async verifyEmail(req: Request, res: Response) {
    try {
      const { token } = req.params;
      console.log('[VerifyEmail] Received verification request'); // token is a credential — not logged
      // Find user with this verification token
      const user = await query<VerifyEmailUserRow>(
        'SELECT id, email, first_name, email_verification_expires, created_at FROM users WHERE email_verification_token = $1',
        [hashVerificationToken(String(token))]
      );
      if (user.rows.length === 0) {
        console.log('[VerifyEmail] No user found for the supplied token');
        // There used to be a fallback here that answered "already verified" by
        // looking up whichever account had verified most recently. Verification
        // clears the token, so a second click on a real link is indistinguishable
        // from a forged one — and that query guessed. On an unauthenticated
        // route it returned a stranger's id, email and first name, which the
        // frontend then displayed. Telling the two apart requires knowing which
        // token was consumed; until the schema records that, this is a 400.
        return res.status(400).json({ error: 'Invalid verification token' });
      }
      // rows.length === 0 already returned above, so rows[0] exists for the
      // rest of this handler.
      const now = new Date();
      // email_verification_expires and created_at can be null; new Date(null)
      // already coerces to the epoch (Number(null) is 0), so ?? 0 reproduces
      // that instead of silently changing what an absent value renders as.
      const expires = new Date(user.rows[0]!.email_verification_expires ?? 0);
      const created = new Date(user.rows[0]!.created_at ?? 0);
      console.log(`[VerifyEmail] User found:`, {
        id: user.rows[0]!.id,
        created_at: created,
        verification_expires: expires,
        now: now
      });
      // Check if token has expired
      if (now > expires) {
        console.log(`[VerifyEmail] Token expired for user ${user.rows[0]!.id}`);
        return res.status(400).json({ error: 'Verification token has expired' });
      }
      // Mark email as verified and clear token
      await query(
        'UPDATE users SET email_verified = TRUE, email_verification_token = NULL, email_verification_expires = NULL WHERE id = $1',
        [user.rows[0]!.id]
      );
      console.log(`[VerifyEmail] Email verified for user ${user.rows[0]!.id}`);
      res.json({
        message: 'Email verified successfully! You can now log in to your account.',
        user: {
          id: user.rows[0]!.id,
          email: user.rows[0]!.email,
          first_name: user.rows[0]!.first_name
        }
      });
    } catch (error) {
      console.error('Email verification error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  },

  // Resend verification email
  async resendVerification(req: Request, res: Response) {
    try {
      const [email, typed] = lookupEmails(req, res);

      // Find user
      const user = await query<ResendVerificationUserRow>(
        'SELECT id, email, first_name, email_verified, email_verification_expires FROM users WHERE lower(email) IN (lower($1), lower($2)) ORDER BY email = $1 DESC, email = $2 DESC, id LIMIT 1',
        [email, typed]
      );

      if (user.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      // rows.length === 0 already returned above, so rows[0] exists for the
      // rest of this handler.
      if (user.rows[0]!.email_verified) {
        return res.status(400).json({ error: 'Email is already verified' });
      }

      // Check if previous token is still valid (within the resend cooldown)
      if (user.rows[0]!.email_verification_expires &&
          new Date() < new Date(user.rows[0]!.email_verification_expires) &&
          new Date(user.rows[0]!.email_verification_expires) > new Date(Date.now() - config.emailVerification.resendCooldown)) {
        return res.status(400).json({ error: 'Please wait before requesting another verification email' });
      }

      // Generate new verification token (stored as its hash)
      const { token: verificationToken, hash: verificationHash } = newVerificationToken();
      const verificationExpires = new Date(Date.now() + config.emailVerification.tokenExpiry);

      // Update user with new token
      await query(
        'UPDATE users SET email_verification_token = $1, email_verification_expires = $2 WHERE id = $3',
        [verificationHash, verificationExpires, user.rows[0]!.id]
      );

      // Send verification email
      try {
        await sendEmailVerification(user.rows[0]!.email, user.rows[0]!.first_name, verificationToken);
        res.json({ message: 'Verification email sent successfully' });
      } catch (emailError) {
        const code = emailError instanceof Error ? (emailError as Error & { code?: unknown }).code : undefined;
        console.error(`Failed to send verification email for user ${user.rows[0]!.id}:`, code || (emailError instanceof Error ? emailError.message : undefined));
        res.status(500).json({ error: 'Failed to send verification email' });
      }

    } catch (error) {
      console.error('Resend verification error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  },

  // Get user profile
  async getProfile(req: Request, res: Response) {
    try {
      const user = await query<ProfileRow>(
        'SELECT id, email, first_name, last_name, created_at, weekly_reports_enabled, email_notifications_enabled FROM users WHERE id = $1',
        [req.user.userId]
      );

      if (user.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      res.json({ user: user.rows[0] });

    } catch (error) {
      console.error('Get profile error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  },

  // Update user profile
  async updateProfile(req: Request, res: Response) {
    try {
      const { first_name, last_name, language } = req.body;
      let sql = 'UPDATE users SET first_name = $1, last_name = $2';
      let params = [first_name, last_name, req.user.userId];
      if (language) {
        sql = 'UPDATE users SET first_name = $1, last_name = $2, language = $3 WHERE id = $4 RETURNING id, email, first_name, last_name, language, updated_at';
        params = [first_name, last_name, language, req.user.userId];
      } else {
        sql = 'UPDATE users SET first_name = $1, last_name = $2 WHERE id = $3 RETURNING id, email, first_name, last_name, language, updated_at';
        params = [first_name, last_name, req.user.userId];
      }
      const updatedUser = await query<UpdatedProfileRow>(sql, params);
      res.json({
        message: 'Profile updated successfully',
        user: updatedUser.rows[0]
      });
    } catch (error) {
      console.error('Update profile error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  },

  // Send test email
  async sendTestEmail(req: Request, res: Response) {
    try {
      const userEmail = req.user.email;
      const report = await generateWeeklyReport(req.user.userId);
      await sendWeeklyReport(userEmail, report.text, report.html);
      res.json({ message: 'Weekly report test email sent successfully' });
    } catch (error) {
      console.error('Test email error:', error);
      res.status(500).json({ error: 'Failed to send test email' });
    }
  },

  // Update notification settings
  async updateNotificationSettings(req: Request, res: Response) {
    try {
      const { weekly_reports_enabled, email_notifications_enabled } = req.body;
      await query(
        'UPDATE users SET weekly_reports_enabled = $1, email_notifications_enabled = $2 WHERE id = $3',
        [weekly_reports_enabled, email_notifications_enabled, req.user.userId]
      );
      res.json({ message: 'Notification settings updated' });
    } catch (error) {
      console.error('Update notification settings error:', error);
      res.status(500).json({ error: 'Failed to update notification settings' });
    }
  },

  /**
   * GET /auth/terms: whether this user must accept the current Terms of
   * Service and Privacy Policy before going on. True only when the version
   * they accepted is not the current one, so it is asked once per version.
   */
  async getTermsStatus(req: Request, res: Response) {
    res.set('Cache-Control', 'no-store');
    const userId = req.user.userId;
    try {
      res.json(await termsService.termsStatus(userId));
    } catch (error) {
      if (error instanceof termsService.TermsUserNotFoundError) {
        return res.status(404).json({ error: error.message, code: error.code });
      }
      console.error('Get terms status error:', { userId, ...errorSummary(error) });
      res.status(500).json({ error: 'Server error' });
    }
  },

  /** POST /auth/terms { version }: records acceptance of the current version. */
  async acceptTerms(req: Request, res: Response) {
    res.set('Cache-Control', 'no-store');
    const userId = req.user.userId;
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'A terms version is required', code: 'terms_invalid' });
    }
    try {
      const status = await termsService.acceptTerms(userId, req.body.version as string);
      console.log(`[Terms] User ${userId} accepted version ${status.acceptedVersion ?? 'none stored'}`);
      res.json(status);
    } catch (error) {
      if (error instanceof termsService.TermsVersionError) {
        return res.status(409).json({ error: error.message, code: error.code, currentVersion: termsService.currentVersion() });
      }
      if (error instanceof termsService.TermsUserNotFoundError) {
        return res.status(404).json({ error: error.message, code: error.code });
      }
      console.error('Accept terms error:', { userId, ...errorSummary(error) });
      res.status(500).json({ error: 'Server error' });
    }
  },

  /**
   * Settings -> Delete account: re-checks the password, then deletes the user
   * and everything that belongs to them (services/accountService.ts). Logs the
   * user id and row counts only — never the password, the address or a body.
   * A wrong password is 403, not 401: the login token is still valid, and the
   * client logs out on any 401.
   */
  async deleteAccount(req: Request, res: Response) {
    res.set('Cache-Control', 'no-store');
    const userId = req.user.userId;
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      // errors.array() would echo the submitted value, which is the password.
      return res.status(400).json({ errors: errors.array().map((e) => ({ msg: e.msg, path: 'path' in e ? e.path : undefined })) });
    }
    try {
      const deleted = await accountService.deleteAccount(userId, req.body.password as string);
      logger.audit('Account deleted', { userId, deleted });
      accountService.accountDeleted(userId);
      res.json({ deleted: true });
    } catch (error) {
      if (error instanceof accountService.AccountPasswordError) {
        console.log(`[DeleteAccount] Refused, wrong password: user ${userId}`);
        return res.status(403).json({ error: error.message, code: error.code });
      }
      if (error instanceof accountService.AccountDemoError) {
        console.log(`[DeleteAccount] Refused, demo account: user ${userId}`);
        return res.status(403).json({ error: error.message, code: error.code });
      }
      if (error instanceof accountService.AccountNotFoundError) {
        return res.status(404).json({ error: error.message, code: error.code });
      }
      console.error('Delete account error:', { userId, ...errorSummary(error) });
      res.status(500).json({ error: 'Server error' });
    }
  }
};

export = authController;
