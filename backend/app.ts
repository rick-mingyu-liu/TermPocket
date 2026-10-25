import express, { Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import 'dotenv/config';

// Import utilities and services
import config = require('./config');
import validateConfig = require('./config/validate');

// Before anything else is loaded: a missing JWT_SECRET or database URL makes
// every request fail later, in ways that read as bugs rather than as setup.
validateConfig();

import logger = require('./utils/logger');
import ErrorHandler = require('./utils/errorHandler');
import schedulerService = require('./services/schedulerService');
import { apiLimiter } from './middleware/rateLimiter';
import { redactUrl } from './utils/redactUrl';

// Import routes
import authRoutes = require('./routes/auth');
import transactionRoutes = require('./routes/transactions');
import summaryRoutes = require('./routes/summary');
import goalRoutes = require('./routes/goals');
import importRoutes = require('./routes/import');
import mcpRoutes = require('./routes/mcp');
import accessTokenRoutes = require('./routes/accessTokens');
import agentRoutes = require('./routes/agent');

const app = express();
const PORT = config.port;

// Render terminates TLS at a proxy, so req.ip is that proxy's address unless
// Express is told to read X-Forwarded-For. Without this the rate limiters below
// see every visitor as one client and throttle the whole user base together.
// The value is the number of trusted hops — not `true`, which would let a
// client spoof its own address via the header.
app.set('trust proxy', 1);

// Middleware
app.use(helmet());
// morgan's 'combined' format, with the URL and the Referer passed through
// redactUrl first. The stock :url and :referrer printed every email
// verification token: the request is GET /auth/verify-email/<token>, and the
// page that sends it is /verify-email?token=<token>. Every other field is
// 'combined''s own, except :remote-user, which is dropped: it prints the
// username of an `Authorization: Basic` header, and a client that sends an
// access token or a password that way would write it to the log.
morgan.token<Request, Response>('redacted-url', (req) => redactUrl(req.originalUrl || req.url));
morgan.token<Request, Response>('redacted-referrer', (req) => redactUrl(req.headers.referer || req.headers.referrer));
app.use(morgan(
  ':remote-addr - - [:date[clf]] ":method :redacted-url HTTP/:http-version" :status :res[content-length] ":redacted-referrer" ":user-agent"'
));
app.use(cors(config.cors));
// Parsed here, before the app-wide parser, because the default 100 kB limit is
// too small for one long screenshot's OCR output. The app-wide parser skips a
// body that has already been read.
app.use('/import', express.json({ limit: config.import.bodyLimit }));
// /mcp speaks JSON-RPC, so a body that isn't JSON is the client's parse error
// (-32700, 400), and any other refused body (too large, compressed, an
// unknown charset) is its own 4xx with a JSON-RPC error, not the 500 the
// global handler would make of it. No MCP request needs a compressed body or
// more than a few hundred bytes, so neither is accepted.
app.use('/mcp', express.json({ inflate: false, limit: '16kb' }), (error: unknown, _req: Request, res: Response, next: express.NextFunction) => {
  const { type, status } = (error ?? {}) as { type?: string; status?: number };
  if (type === 'entity.parse.failed') {
    return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return res.status(status).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } });
  }
  next(error);
});
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    environment: config.nodeEnv,
    version: '1.0.0'
  });
});

// General limiter, mounted after /health so platform health checks are never
// throttled. Credential endpoints add a stricter limiter of their own in
// routes/auth.ts.
app.use(apiLimiter);

// API Routes
app.use('/auth', authRoutes);
app.use('/transactions', transactionRoutes);
app.use('/summary', summaryRoutes);
app.use('/goals', goalRoutes);
app.use('/import', importRoutes);
// The signed-in user's tokens for /mcp, managed with the login JWT.
app.use('/access-tokens', accessTokenRoutes);
app.use('/agent', agentRoutes);
// Read-only, for a personal agent; opened by an access token, never the login JWT.
app.use('/mcp', mcpRoutes);

// Error handling middleware
app.use(ErrorHandler.globalErrorHandler);

// 404 handler
app.use('*', ErrorHandler.notFoundHandler);

// Start the server only when this file is the entry point. Requiring it —
// which is how the tests get at the routes — must not bind a port or start the
// scheduler's cron jobs.
if (require.main === module) {
  app.listen(PORT, () => {
    logger.info(`🚀 Server running on port ${PORT}`);
    logger.info(`🔗 Health check: http://localhost:${PORT}/health`);
    logger.info(`🌍 Environment: ${config.nodeEnv}`);

    // Initialize scheduled tasks
    schedulerService.init();
  });
}

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully...');
  schedulerService.stop();
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully...');
  schedulerService.stop();
  process.exit(0);
});

export = app;
