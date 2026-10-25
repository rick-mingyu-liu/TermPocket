import express, { Request, Response, NextFunction } from 'express';
import { userForToken } from '../services/accessTokens';
import { termSummary, monthlyBaseline, goalProgress } from '../services/moneyFacts';
import { errorSummary } from '../utils/errorSummary';
import { mcpLimiter } from '../middleware/rateLimiter';

/**
 * POST /mcp — TermPocket as an MCP server, so a personal agent can read your
 * numbers. MCP over HTTP is JSON-RPC 2.0 in POST requests; this answers with
 * plain JSON, never an event stream, which the spec allows.
 *
 * **Read-only by construction.** It authenticates with a personal access token
 * (services/accessTokens.ts), not the login JWT, and every tool below is a
 * SELECT. A token can therefore never delete or change anything, and revoking
 * it cuts the agent off without touching your password. The tools return
 * totals, category names and goals — never individual transactions.
 */

// Only a version without JSON-RPC batching (2025-03-26 allowed batches, which this refuses).
const PROTOCOL_VERSION = '2025-06-18';

interface RpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

const TOOLS = [
  {
    name: 'money_term_summary',
    description:
      'Income, spending, savings rate and top spending categories (CAD) for a Waterloo term: Winter Jan–Apr, Spring May–Aug, Fall Sep–Dec. ' +
      'For the current term it also says how many days in it is and compares spending so far (pace.current_window, counting today) with what the previous term (pace.compared_with) had actually spent in its own first as many days (pace.comparison_window; the whole previous term when it was shorter, flagged clamped). Windows are [start, end_exclusive). pace.current_spending and pace.last_term_same_point are the spending inside each window; pace.ratio is their quotient, above 1 meaning more recorded spending than at that point last term, and null, with pace.note, when last term recorded none. pace.caveat and currency_note restate the limits below. ' +
      'Adjacent terms often differ in circumstances — a study term against a co-op work term, or tuition paid in one and not the other — so the ratio compares recorded spending and is not a judgement. ' +
      'Non-CAD amounts are converted at current exchange rates, not historical ones.',
    inputSchema: {
      type: 'object',
      properties: { term: { type: 'string', enum: ['current', 'previous'], description: 'Which term; default current' } },
      additionalProperties: false,
    },
  },
  {
    name: 'money_baseline',
    description: 'Average monthly income, spending and saving (CAD) over the last 12 whole months, counting only months with any records.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'money_goals',
    description: 'Each savings goal: target, amount saved, percent, target date, status, and what it needs per month to be reached on time.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

const router = express.Router();

/** Only a personal access token opens /mcp. A login JWT is refused: it can do far more than read. */
async function tokenAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.header('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  try {
    const userId = token ? await userForToken(token) : null;
    if (userId === null) {
      res.set('WWW-Authenticate', 'Bearer');
      return res.status(401).json({ error: 'A TermPocket access token is required.' });
    }
    req.user = { userId, email: '' };
    // Money totals: no proxy or browser may keep a copy.
    res.set('Cache-Control', 'no-store');
    next();
  } catch (error) {
    console.error('MCP auth error:', errorSummary(error));
    res.status(500).json({ error: 'Server error' });
  }
}

router.use(tokenAuth, mcpLimiter);

const reply = (id: unknown, result: unknown) => ({ jsonrpc: '2.0', id, result });
const failure = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

async function callTool(userId: number, name: unknown, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'money_term_summary': {
      const term = args.term ?? 'current';
      if (term !== 'current' && term !== 'previous') throw new RangeError('term must be current or previous');
      return termSummary(userId, term);
    }
    case 'money_baseline':
      return monthlyBaseline(userId);
    case 'money_goals':
      return { goals: await goalProgress(userId) };
    default:
      throw new RangeError(`unknown tool: ${String(name).slice(0, 60)}`);
  }
}

router.post('/', async (req: Request, res: Response) => {
  const body = req.body as RpcRequest | unknown[] | undefined;
  // A response or notification a client posts back needs no answer.
  if (typeof body === 'object' && body !== null && !Array.isArray(body) && body.method === undefined && ('result' in body || 'error' in body)) {
    return res.status(202).end();
  }
  if (Array.isArray(body) || typeof body !== 'object' || body === null || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    return res.json(failure(null, -32600, 'Invalid request'));
  }
  const { id, method } = body;
  const params = (typeof body.params === 'object' && body.params !== null ? body.params : {}) as Record<string, unknown>;

  // A notification (no id) gets no body.
  if (id === undefined) return res.status(202).end();

  switch (method) {
    case 'initialize':
      // `name` is the identifier clients key on and stays 'mindgo'; `title` is
      // the display name (added in 2025-06-18).
      return res.json(reply(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'mindgo', title: 'TermPocket', version: '1.0.0' } }));
    case 'ping':
      return res.json(reply(id, {}));
    case 'tools/list':
      return res.json(reply(id, { tools: TOOLS }));
    case 'tools/call': {
      // An unknown tool is a protocol error (-32602), as the MCP spec has it;
      // a known tool with bad arguments answers as a tool error below.
      if (typeof params.name !== 'string' || !TOOLS.some((t) => t.name === params.name)) {
        return res.json(failure(id, -32602, `Unknown tool: ${String(params.name).slice(0, 60)}`));
      }
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      try {
        const result = await callTool(req.user.userId, params.name, args);
        return res.json(reply(id, { content: [{ type: 'text', text: JSON.stringify(result) }] }));
      } catch (error) {
        // A bad argument is the caller's to fix and safe to repeat; anything
        // else is logged by name only and answered generically.
        const message = error instanceof RangeError ? error.message : 'TermPocket could not read that right now.';
        if (!(error instanceof RangeError)) console.error('MCP tool error:', { userId: req.user.userId, tool: String(params.name), ...errorSummary(error) });
        return res.json(reply(id, { content: [{ type: 'text', text: message }], isError: true }));
      }
    }
    default:
      return res.json(failure(id, -32601, 'Method not found'));
  }
});

// Streamable HTTP lets a server refuse the GET event stream; this one has nothing to push.
router.get('/', (_req: Request, res: Response) => res.status(405).set('Allow', 'POST').end());

export = router;
