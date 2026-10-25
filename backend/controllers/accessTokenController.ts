import { Request, Response } from 'express';
import { validationResult } from 'express-validator';
import { createToken, listTokens, revokeToken, MAX_TOKENS_PER_USER, DemoTokenError, TokenPasswordError } from '../services/accessTokens';
import { errorSummary } from '../utils/errorSummary';

/**
 * A signed-in user's MCP access tokens. The owner is always req.user.userId,
 * never anything in the request. The token itself appears in one response
 * only, the 201 that creates it, and never in a log: errors are logged as
 * errorSummary, because a pg error's message can quote the row (and its hash)
 * that failed.
 */
const accessTokenController = {
  async list(req: Request, res: Response) {
    try {
      const tokens = await listTokens(req.user.userId);
      res.json({ tokens, limit: MAX_TOKENS_PER_USER });
    } catch (error) {
      console.error('List access tokens error:', { userId: req.user.userId, ...errorSummary(error) });
      res.status(500).json({ error: 'Server error' });
    }
  },

  async create(req: Request, res: Response) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      // errors.array() would echo the submitted values, the password among them.
      return res.status(400).json({ errors: errors.array().map((e) => ({ msg: e.msg, path: 'path' in e ? e.path : undefined })) });
    }
    try {
      const { token, summary } = await createToken(req.user.userId, req.body.name, { password: req.body.password as string });
      res.status(201).json({ token: summary, secret: token });
    } catch (error) {
      if (error instanceof DemoTokenError) {
        return res.status(403).json({ error: 'The demo account cannot create access tokens.', code: 'access_token_demo' });
      }
      // 403, not 401: the client treats a 401 as a lapsed login and signs out.
      if (error instanceof TokenPasswordError) {
        return res.status(403).json({ error: 'The password is incorrect.', code: 'access_token_password_incorrect' });
      }
      if (error instanceof RangeError) {
        return res.status(409).json({ error: `You can have at most ${MAX_TOKENS_PER_USER} active tokens. Revoke one first.`, code: 'token_limit' });
      }
      console.error('Create access token error:', { userId: req.user.userId, ...errorSummary(error) });
      res.status(500).json({ error: 'Server error' });
    }
  },

  async revoke(req: Request, res: Response) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    try {
      // Unknown, already revoked and someone else's all answer 404 alike, so
      // the endpoint cannot be used to learn which ids exist.
      const revoked = await revokeToken(req.user.userId, Number(req.params.id));
      if (!revoked) return res.status(404).json({ error: 'Token not found' });
      res.json({ revoked: true });
    } catch (error) {
      console.error('Revoke access token error:', { userId: req.user.userId, ...errorSummary(error) });
      res.status(500).json({ error: 'Server error' });
    }
  },
};

export = accessTokenController;
