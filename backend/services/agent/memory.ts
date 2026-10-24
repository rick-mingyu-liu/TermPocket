/// <reference lib="es2024.string" />
import { query } from '../../db/connection';
import { AgentError, type MemoryFact, type MemoryFields, type MemoryKind, type MemoryCadence, type MemoryProposalDraft } from './types';
import { currencies, validateUuid } from './validation';
import { GOAL_VERSION_SQL } from './planning';

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

/** Keep untrusted user text as data, with no invisible direction controls or malformed UTF-16. */
export function cleanMemoryText(text: string): string {
  // These are deliberately matched so untrusted text cannot hide instructions.
  // eslint-disable-next-line no-control-regex
  return text.toWellFormed().replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ');
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

/** Only complete validated snapshots can enter storage, independently of the future model tool. */
export function validateMemoryDraft(value: unknown): MemoryProposalDraft {
  const input = object(value, ['action', 'kind', 'memory_id', 'expected_updated_at', 'before', 'after']);
  if (input.action === 'remember') {
    const after = validateMemoryFields(input.after);
    if (input.memory_id !== null || input.expected_updated_at !== null || input.before !== null || input.kind !== after.kind) invalid();
    return { action: 'remember', kind: after.kind, memory_id: null, expected_updated_at: null, before: null, after };
  }
  if (input.action !== 'update' && input.action !== 'forget') invalid();
  const memoryId = validateUuid(input.memory_id);
  if (typeof input.expected_updated_at !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/.test(input.expected_updated_at)) invalid();
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

/** Named columns only; stable ordering and local calendar dates, never the server's local date. */
export async function listMemories(userId: number, timezone = 'UTC', client: MemoryClient = { query }): Promise<MemoryFact[]> {
  if (typeof timezone !== 'string' || timezone.length > 100) invalid();
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { invalid(); }
  if (!(await memoriesAvailable(sql => client.query(sql))) || await isDemoUser(client, userId)) return [];
  const result = await client.query<MemoryFact>(
    `SELECT id,kind,text,amount,currency,cadence,source_conversation_id,created_at,updated_at,
      ${GOAL_VERSION_SQL} AS version,to_char(updated_at AT TIME ZONE $2,'YYYY-MM-DD') AS saved_on
      FROM agent_memories WHERE user_id=$1 ORDER BY created_at,id`, [userId, timezone]);
  return result.rows.map(row => ({ ...row, text: cleanMemoryText(row.text) }));
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
