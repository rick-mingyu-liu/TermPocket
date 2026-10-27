import { query } from '../../db/connection';
import config = require('../../config');
import { AgentError, type MemoryFact, type MemoryFields, type MemoryKind, type MemoryCadence, type MemoryProposalDraft } from './types';
import { cleanMemoryText, currencies, decimalCents, formatCents, validateUuid } from './validation';
import { GOAL_VERSION_SQL } from './planning';

export { cleanMemoryText };

const kinds: MemoryKind[] = ['income', 'expense', 'reserve', 'preference', 'other'];
const cadences: MemoryCadence[] = ['week', 'two_weeks', 'month', 'once'];
const fields = ['kind', 'text', 'amount', 'currency', 'cadence'];
type MemoryClient = { query: typeof query };
const invalid = (): never => { throw new AgentError('agent_invalid_input'); };
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !keys.includes(key))) invalid();
  return result;
}

/** A partial update keeps omitted fields; explicitly clearing amount clears its currency and cadence. */
export function validateMemoryFields(value: unknown, previous?: MemoryFields): MemoryFields {
  const input = object(value, fields);
  const merged = { ...previous, ...input };
  if (typeof merged.kind !== 'string' || !kinds.includes(merged.kind as MemoryKind)) invalid();
  if (typeof merged.text !== 'string') invalid();
  const text = cleanMemoryText(merged.text as string);
  if (!text.trim() || Array.from(text).length > 120) invalid();
  let amount = merged.amount ?? null;
  let currency = merged.currency ?? null;
  let cadence = merged.cadence ?? null;
  if (previous && input.amount === null) { amount = null; currency = null; cadence = null; }
  if (amount !== null) {
    if (typeof amount !== 'string' || !/^(0|[1-9]\d{0,7})\.\d{2}$/.test(amount) || amount === '0.00') invalid();
    if (typeof currency !== 'string' || !currencies.includes(currency)) invalid();
    if (cadence !== null && (typeof cadence !== 'string' || !cadences.includes(cadence as MemoryCadence))) invalid();
  } else if (currency !== null || cadence !== null) invalid();
  return { kind: merged.kind as MemoryKind, text, amount: amount as string | null, currency: currency as string | null, cadence: cadence as MemoryCadence | null };
}

/** Only complete validated snapshots can enter storage, independently of the model tool. */
export function validateMemoryDraft(value: unknown): MemoryProposalDraft {
  const input = object(value, ['action', 'kind', 'memory_id', 'expected_updated_at', 'before', 'after']);
  if (input.action === 'remember') {
    const after = validateMemoryFields(input.after);
    if (input.memory_id !== null || input.expected_updated_at !== null || input.before !== null || input.kind !== after.kind) invalid();
    return { action: 'remember', kind: after.kind, memory_id: null, expected_updated_at: null, before: null, after };
  }
  if (input.action !== 'update' && input.action !== 'forget') invalid();
  const memoryId = validateUuid(input.memory_id);
  if (typeof input.expected_updated_at !== 'string' || !versionPattern.test(input.expected_updated_at)) invalid();
  const before = validateMemoryFields(input.before);
  const after = input.action === 'forget' ? null : validateMemoryFields(input.after);
  if (input.action === 'forget' && input.after !== null) invalid();
  const kind = after?.kind ?? before.kind;
  if (input.kind !== kind) invalid();
  return { action: input.action as 'update' | 'forget', kind, memory_id: memoryId, expected_updated_at: input.expected_updated_at as string, before, after };
}

let memoriesTableSeen = false;
/** Cache only presence, so applying migration 022 is noticed without a process restart. */
export async function memoriesAvailable(run: (sql: string) => Promise<{ rows: Array<{ present?: boolean }> }> = sql => query<{ present: boolean }>(sql)): Promise<boolean> {
  if (memoriesTableSeen) return true;
  memoriesTableSeen = (await run("SELECT to_regclass('agent_memories') IS NOT NULL AS present")).rows[0]?.present === true;
  return memoriesTableSeen;
}

/** `client` is the caller's dedicated transaction connection when an owner lock is required. */
export async function isDemoUser(client: MemoryClient, userId: number): Promise<boolean> {
  const result = await client.query<{ is_demo: boolean }>('SELECT is_demo FROM users WHERE id=$1', [userId]);
  return result.rows[0]?.is_demo === true;
}

function timezoneOf(timezone: unknown): string {
  if (typeof timezone !== 'string' || timezone.length > 100) invalid();
  try { new Intl.DateTimeFormat('en', { timeZone: timezone as string }); } catch { invalid(); }
  return timezone as string;
}

/** The facts themselves; the caller has already checked availability and the demo account. */
async function readMemories(client: MemoryClient, userId: number, timezone: string): Promise<MemoryFact[]> {
  let result: { rows: MemoryFact[] };
  try {
    result = await client.query<MemoryFact>(
      `SELECT id,kind,text,amount,currency,cadence,source_conversation_id,created_at,updated_at,
        ${GOAL_VERSION_SQL} AS version,to_char(updated_at AT TIME ZONE $2,'YYYY-MM-DD') AS saved_on
        FROM agent_memories WHERE user_id=$1 ORDER BY created_at,id`, [userId, timezone]);
  } catch (error) {
    // A zone Intl accepts but PostgreSQL does not is the caller's bad input, not a server failure.
    if ((error as { code?: unknown } | null)?.code === '22023') invalid();
    throw error;
  }
  return result.rows.map(row => ({ ...row, text: cleanMemoryText(row.text) }));
}

/** Named columns only; stable ordering and local calendar dates, never the server's local date. */
export async function listMemories(userId: number, timezone: unknown = 'UTC', client: MemoryClient = { query }): Promise<MemoryFact[]> {
  const zone = timezoneOf(timezone);
  if (!(await memoriesAvailable(sql => client.query(sql))) || await isDemoUser(client, userId)) return [];
  return readMemories(client, userId, zone);
}

/**
 * What a turn's prompt carries: undefined before migration 022 and for the
 * demo account, so context.memory is omitted rather than shown as empty.
 * `client` must be inside a transaction (beginTurn's). A conversation zone
 * that Intl accepts but PostgreSQL does not (22023) must not fail every turn,
 * so saved_on falls back to UTC behind a savepoint; only GET /agent/memories
 * answers such a zone with a 400.
 */
export async function memoriesForTurn(userId: number, timezone: unknown, client: MemoryClient): Promise<MemoryFact[] | undefined> {
  const zone = timezoneOf(timezone);
  if (!(await memoriesAvailable(sql => client.query(sql))) || await isDemoUser(client, userId)) return undefined;
  await client.query('SAVEPOINT memory_zone');
  try {
    const facts = await readMemories(client, userId, zone);
    await client.query('RELEASE SAVEPOINT memory_zone');
    return facts;
  } catch (error) {
    if (!(error instanceof AgentError && error.code === 'agent_invalid_input')) throw error;
    await client.query('ROLLBACK TO SAVEPOINT memory_zone');
    return readMemories(client, userId, 'UTC');
  }
}

const toolKeys = ['action', 'memory_id', 'expected_updated_at', ...fields];
const versionPattern = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/;

/**
 * propose_memory's server side. The runtime has already turned the model's
 * ref into memory_id and expected_updated_at, so no id the model typed reaches
 * this function. Remember checks the cap (only remember counts toward it);
 * update and forget read the owned fact for `before` and compare its version.
 * An update keeps the fields it omits. Nothing here writes.
 */
export async function prepareMemoryProposal(userId: number, raw: unknown, client: MemoryClient = { query }): Promise<MemoryProposalDraft> {
  const input = object(raw, toolKeys);
  const given: Record<string, unknown> = Object.fromEntries(fields.filter(key => input[key] !== undefined).map(key => [key, input[key]]));
  // '950' and '950.5' are amounts too; stored as two-decimal strings.
  if (typeof given.amount === 'string') given.amount = formatCents(decimalCents(given.amount, { min: 1 }));
  const ready = async () => {
    if (!(await memoriesAvailable(sql => client.query(sql)))) throw new AgentError('agent_unavailable', 503);
    if (await isDemoUser(client, userId)) throw new AgentError('agent_memory_demo', 403);
  };
  if (input.action === 'remember') {
    if (input.memory_id !== undefined || input.expected_updated_at !== undefined) invalid();
    const after = validateMemoryFields(given);
    await ready();
    const count = await client.query<{ count: string }>('SELECT count(*) AS count FROM agent_memories WHERE user_id=$1', [userId]);
    if (Number(count.rows[0]?.count ?? 0) >= config.agent.maxMemories) throw new AgentError('agent_memory_full', 409);
    return { action: 'remember', kind: after.kind, memory_id: null, expected_updated_at: null, before: null, after };
  }
  if (input.action !== 'update' && input.action !== 'forget') invalid();
  const memoryId = validateUuid(input.memory_id);
  if (typeof input.expected_updated_at !== 'string' || !versionPattern.test(input.expected_updated_at)) invalid();
  if (input.action === 'forget' && Object.keys(given).length) invalid();
  await ready();
  const found = await client.query<MemoryFields & { version: string }>(
    `SELECT kind,text,amount,currency,cadence,${GOAL_VERSION_SQL} AS version FROM agent_memories WHERE id=$1 AND user_id=$2`, [memoryId, userId]);
  const row = found.rows[0];
  // Another user's fact reads exactly like one that does not exist.
  if (!row) throw new AgentError('agent_memory_not_found', 404);
  if (row.version !== input.expected_updated_at) throw new AgentError('agent_memory_conflict', 409);
  const before = validateMemoryFields({ kind: row.kind, text: row.text, amount: row.amount, currency: row.currency, cadence: row.cadence });
  if (input.action === 'forget') return { action: 'forget', kind: before.kind, memory_id: memoryId, expected_updated_at: row.version, before, after: null };
  const after = validateMemoryFields(given, before);
  if (fields.every(key => after[key as keyof MemoryFields] === before[key as keyof MemoryFields])) invalid();
  return { action: 'update', kind: after.kind, memory_id: memoryId, expected_updated_at: row.version, before, after };
}

/**
 * The single deletion path for Settings and confirmed forget. The caller owns
 * a transaction and user lock. Keep no proposal snapshot that could restore
 * a forgotten value; conversation messages deliberately remain separate.
 */
export async function deleteMemories(client: MemoryClient, userId: number, ids: string[] | 'all'): Promise<number> {
  if (ids === 'all') {
    await client.query('DELETE FROM agent_memory_proposals WHERE user_id=$1', [userId]);
    return (await client.query('DELETE FROM agent_memories WHERE user_id=$1', [userId])).rowCount ?? 0;
  }
  const uniqueIds = [...new Set(ids.map(validateUuid))];
  if (!uniqueIds.length) return 0;
  const found = await client.query<{ id: string }>('SELECT id FROM agent_memories WHERE user_id=$1 AND id=ANY($2::uuid[]) FOR UPDATE', [userId, uniqueIds]);
  if (found.rows.length !== uniqueIds.length) throw new AgentError('agent_memory_not_found', 404);
  await client.query(`UPDATE agent_memory_proposals SET before=NULL,after=NULL,redacted_at=COALESCE(redacted_at,now()),
    decided_at=CASE WHEN status='pending' THEN now() ELSE decided_at END,
    status=CASE WHEN status='pending' THEN 'superseded' ELSE status END
    WHERE user_id=$1 AND (memory_id=ANY($2::uuid[]) OR result_memory_id=ANY($2::uuid[]))`, [userId, uniqueIds]);
  return (await client.query('DELETE FROM agent_memories WHERE user_id=$1 AND id=ANY($2::uuid[])', [userId, uniqueIds])).rowCount ?? 0;
}
