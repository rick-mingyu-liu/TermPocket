/** What a run used before it ended: counts only, attached to a runtime failure so the run row can record them. */
export interface RunUsage { inputTokens: number; outputTokens: number; toolCalls: number }
export class AgentError extends Error {
  constructor(public readonly code: string, public readonly status = 400, public readonly usage?: RunUsage) { super(code); this.name = 'AgentError'; }
}
export interface ConversationSettings { currency: string; timezone: string; language: 'auto' | 'en' | 'zh' }
export interface Conversation extends ConversationSettings { id: string; title: string; created_at: Date; updated_at: Date }
export interface Message { id: string; role: 'user' | 'assistant'; content: string; status: 'complete' | 'failed' | 'cancelled'; created_at: Date }
export interface DraftRow { id: string; amount: string; description: string; category: string; type: 'expense' | 'income'; date: string; currency: string }
export interface Draft { id: string; version: number; status: 'pending' | 'confirmed' | 'cancelled' | 'expired'; rows: DraftRow[]; expires_at: Date }
export interface Receipt { id: string; request_id: string; transaction_ids: number[]; undo_until: Date; undone_at: Date | null; created_at: Date }
export interface Run { id: string; status: 'running' | 'complete' | 'failed' | 'cancelled'; error_code: string | null }
/** A savings goal's editable fields as a proposal shows them: amounts are two-decimal strings, dates 'YYYY-MM-DD'. */
export interface GoalFields { name: string; target_amount: string; current_amount: string; currency: string; target_date: string | null; description: string | null }
/** One goal change Pocky drafted, decided only by the user's Confirm button. `expired` is computed at read time. */
export interface GoalProposal {
  id: string; action: 'create' | 'update'; goal_id: number | null; before: GoalFields | null; after: GoalFields;
  status: 'pending' | 'confirmed' | 'cancelled' | 'expired' | 'conflict'; expires_at: Date; result_goal_id: number | null;
}
/** What propose_goal hands finishTurn: for an update, the goal's state and version when it was read. */
export interface GoalProposalDraft { action: 'create' | 'update'; goal_id: number | null; expected_updated_at: string | null; before: GoalFields | null; after: GoalFields }
/** A durable statement, saved only by a confirmation button. Monetary values are exact decimal strings. */
export type MemoryKind = 'income' | 'expense' | 'reserve' | 'preference' | 'other';
export type MemoryCadence = 'week' | 'two_weeks' | 'month' | 'once';
export interface MemoryFields { kind: MemoryKind; text: string; amount: string | null; currency: string | null; cadence: MemoryCadence | null }
export interface MemoryFact extends MemoryFields {
  id: string; version: string; source_conversation_id: string | null; created_at: Date; updated_at: Date; saved_on: string;
}
export interface MemoryProposalDraft {
  action: 'remember' | 'update' | 'forget'; kind: MemoryKind; memory_id: string | null; expected_updated_at: string | null;
  before: MemoryFields | null; after: MemoryFields | null;
}
/** Ended and forgotten proposals retain metadata only; their before/after snapshots are null. */
export interface MemoryProposal {
  id: string; action: MemoryProposalDraft['action']; kind: MemoryKind; memory_id: string | null;
  before: MemoryFields | null; after: MemoryFields | null;
  status: 'pending' | 'confirmed' | 'cancelled' | 'expired' | 'conflict'; expires_at: Date;
  result_memory_id: string | null; redacted_at: Date | null;
  error_code: 'agent_memory_full' | 'agent_memory_conflict' | null;
}
export interface ConversationState { conversation: Conversation; messages: Message[]; draft: Draft | null; receipts: Receipt[]; run: Run | null; goalProposal: GoalProposal | null; memoryProposal: MemoryProposal | null }
export interface TurnInput extends ConversationSettings { requestId: string; content: string }
export interface TurnResult { text: string; proposedRows?: unknown[]; goalProposal?: unknown; memoryProposal?: unknown; usage?: { inputTokens: number; outputTokens: number }; toolCalls?: number }
export interface BeginTurnResult { started: boolean; state: ConversationState; history: Message[]; pendingRows: DraftRow[]; /** The user's facts for the prompt; absent before migration 022, for the demo account and on a replay. */ memories?: MemoryFact[] }
export interface RecordWindow { start: string; end_exclusive: string }
export interface SummaryInput extends RecordWindow { currency: string }
export interface CompareInput { a: RecordWindow; b: RecordWindow; currency: string }
export interface DetailsInput extends RecordWindow { category?: string; type?: string; cursor?: string; limit?: number }
export interface BaselineInput { months?: number; currency: string; today: string }
/** Read-only views of one user's records, bound to that user by the route; the model never supplies a user id. */
export interface AgentRecords {
  spendingSummary(input: SummaryInput): Promise<unknown>;
  compareSpending(input: CompareInput): Promise<unknown>;
  transactionDetails(input: DetailsInput): Promise<unknown>;
  spendingBaseline(input: BaselineInput): Promise<unknown>;
  listGoals(): Promise<unknown>;
  /** Pure projection from the model's stated inputs; reads no records, only exchange rates. */
  calculateScenario(input: unknown, today: string): Promise<unknown>;
  /** Validates one goal change and, for an update, reads the owned goal it would change. Writes nothing. */
  prepareGoalProposal(input: unknown, today: string): Promise<GoalProposalDraft>;
  /**
   * Validates one memory change and, for update or forget, reads the owned fact
   * it names (by the id and version the runtime resolved from a ref). Writes nothing.
   */
  prepareMemoryProposal(input: unknown): Promise<MemoryProposalDraft>;
}
