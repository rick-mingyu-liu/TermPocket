import config = require('./index');

/**
 * Startup configuration check.
 *
 * Without JWT_SECRET the server boots happily, then every login throws and every
 * authenticated request 401s — a failure you can only diagnose from symptoms,
 * after a user hits it. Without database credentials nothing that touches a
 * table responds. Both are worth a loud exit at boot instead.
 *
 * Kept out of config/index.ts and called explicitly from app.ts so that scripts
 * importing `config` for a single value (docs generation, migrations) are not
 * killed by an unrelated missing key.
 */

/** Optional variables, and what stops working without each. */
const OPTIONAL: [string, string][] = [
  ['EMAIL_USER', 'no verification or weekly-report email can be sent'],
  ['EMAIL_PASS', 'no verification or weekly-report email can be sent'],
  ['MAILBOXLAYER_API_KEY', 'registration accepts any address that is not on the 30-domain disposable list'],
];

const MIN_SECRET_LENGTH = 32;

function validateConfig(): void {
  const errors: string[] = [];
  // Captured once so the check below can be narrowed to `string`: TypeScript
  // cannot tell, from `errors.length === 0`, that this specific push above
  // never ran — the loud exit just after does.
  const jwtSecret = config.jwt.secret;

  if (!jwtSecret) {
    errors.push('JWT_SECRET is not set — every login and authenticated request would fail.');
  }

  // Either the connection string, or a complete set of discrete parts.
  if (!config.database.url) {
    const missing = ['DB_USER', 'DB_HOST', 'DB_DATABASE'].filter((key) => !process.env[key]);
    if (missing.length > 0) {
      errors.push(
        'No database configuration — set DATABASE_URL, or all of DB_USER, DB_HOST and ' +
          `DB_DATABASE (missing: ${missing.join(', ')}).`
      );
    }
  }

  // The AI client sets every option it takes explicitly, but the SDK always adds
  // this variable's headers to each request: whatever credential it holds for
  // some other service would go to the AI provider.
  if (process.env.ANTHROPIC_CUSTOM_HEADERS) {
    errors.push('ANTHROPIC_CUSTOM_HEADERS is set — the AI client would send those headers to the AI provider. Remove it.');
  }

  if (errors.length > 0) {
    console.error('\n❌ Cannot start: the configuration has a problem.\n');
    for (const error of errors) console.error(`   • ${error}`);
    console.error('\n   backend/.env.example lists every variable this app reads.\n');
    process.exit(1);
  }

  // Non-fatal, but worth saying out loud. jwtSecret is defined here: an unset
  // secret already pushed an error above, and the block above would have
  // exited the process before reaching this line.
  if (jwtSecret !== undefined && jwtSecret.length < MIN_SECRET_LENGTH) {
    console.warn(
      `⚠️  JWT_SECRET is only ${jwtSecret.length} characters — ` +
        `use at least ${MIN_SECRET_LENGTH} random characters in production.`
    );
  }

  for (const [key, consequence] of OPTIONAL) {
    if (!process.env[key]) console.warn(`⚠️  ${key} is not set — ${consequence}.`);
  }

  // The Agent SDK runtime is gone; a leftover variable would suggest a choice that no longer exists.
  if (process.env.AGENT_RUNTIME) {
    console.warn('⚠️  AGENT_RUNTIME is ignored — Pocky always runs in-process. Remove the variable.');
  }
}

export = validateConfig;
