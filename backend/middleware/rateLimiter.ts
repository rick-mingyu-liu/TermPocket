import type { Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import config = require('../config');

// General API rate limiter
const apiLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.apiMax,
  message: {
    error: 'Too many requests from this IP, please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Stricter limiter for auth endpoints
const authLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.authMax,
  message: {
    error: 'Too many authentication attempts, please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Screenshot parsing, keyed on the user rather than the IP. Mount after auth.
const importLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.importMax,
  keyGenerator: (req) => `user:${req.user.userId}`,
  message: {
    error: 'Too many screenshots in a short time, please wait a few minutes.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Creating and revoking access tokens, keyed on the user. Mount after auth.
const accessTokenLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.accessTokenMax,
  keyGenerator: (req) => `user:${req.user.userId}`,
  message: {
    error: 'Too many token changes in a short time, please wait a few minutes.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Deleting the account, keyed on the user. Mount after auth.
const accountDeleteLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.accountDeleteMax,
  keyGenerator: (req) => `user:${req.user.userId}`,
  message: {
    error: 'Too many attempts, please wait a few minutes.',
    code: 'account_rate_limited',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

/** A JSON-RPC refusal for /mcp, echoing the request's id when it is a valid one. */
function rpcTooMany(req: Request, res: Response) {
  const id = (req.body as { id?: unknown } | undefined)?.id;
  res.status(429).json({
    jsonrpc: '2.0',
    id: typeof id === 'string' || typeof id === 'number' ? id : null,
    error: { code: -32000, message: 'Too many requests, please wait a few minutes.', data: { code: 'mcp_rate_limited' } },
  });
}

// POST /mcp with a valid token, keyed on the token's owner, so a user's five
// tokens share one budget. Mount after the token check.
const mcpLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.mcpMax,
  keyGenerator: (req) => `mcp:user:${req.user.userId}`,
  handler: rpcTooMany,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
});

// POST /mcp requests refused as 401, per IP. A well-formed but unknown token
// costs a database lookup (and keeps Neon awake), so failures get a budget of
// their own, far below the general one. Mount before the token check.
const mcpAuthFailureLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.mcpAuthFailureMax,
  requestWasSuccessful: (_req, res) => res.statusCode !== 401,
  skipSuccessfulRequests: true,
  handler: rpcTooMany,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
});

export { apiLimiter, authLimiter, importLimiter, accessTokenLimiter, accountDeleteLimiter, mcpLimiter, mcpAuthFailureLimiter };
