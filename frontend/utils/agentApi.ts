import { api } from '@/utils/api'

export type ReplyLanguage = 'auto' | 'en' | 'zh'
export interface AgentContext { currency: string; timezone: string; language: ReplyLanguage }
export interface Conversation extends AgentContext { id: string; title: string; created_at: string; updated_at: string }
export interface DraftRow {
  id: string; amount: string; description: string; category: string
  type: 'income' | 'expense'; date: string; currency: string
}
export interface Draft {
  id: string; version: number; status: 'pending' | 'confirmed' | 'cancelled' | 'expired'
  rows: DraftRow[]; expires_at: string
}
export interface Receipt {
  id: string; transaction_ids: number[]; undo_until: string; undone_at: string | null; created_at: string
  // Older servers omit it; recovery then relies on the draft version alone.
  request_id?: string
}
export interface GoalFields {
  name: string; target_amount: string; current_amount: string; currency: string
  target_date: string | null; description: string | null
}
export interface GoalProposal {
  id: string; action: 'create' | 'update'; goal_id: number | null
  before: GoalFields | null; after: GoalFields
  status: 'pending' | 'confirmed' | 'cancelled' | 'expired' | 'conflict'
  expires_at: string; result_goal_id: number | null
}
export interface ConversationState {
  conversation: Conversation
  messages: { id: string; role: 'user' | 'assistant'; content: string; status: 'complete' | 'failed' | 'cancelled'; created_at: string }[]
  draft: Draft | null
  receipts: Receipt[]
  run: { id: string; status: 'running' | 'complete' | 'failed' | 'cancelled'; error_code: string | null } | null
  goalProposal: GoalProposal | null
}
// input: 'voice' when the text came from dictation (edited or not), so Pocky
// asks about amounts speech-to-text may have run together. Omitted when typed,
// which servers predating the field also accept.
export interface MessageRequest extends AgentContext { requestId: string; content: string; input?: 'typed' | 'voice' }
export interface ConfirmRequest { version: number; rowIds: string[]; requestId: string }
export interface GoalConfirmRequest { proposalId: string; requestId: string }
// storage: history, drafts, confirmation, undo and deletion work.
// available: storage plus a configured provider, so new messages work too.
export interface AgentStatus { available: boolean; storage: boolean }
const path = (id: string) => `/agent/conversations/${encodeURIComponent(id)}`
// Servers predating goal proposals omit the field; treat that as none.
const state = (data: ConversationState): ConversationState => ({ ...data, goalProposal: data.goalProposal ?? null })

export const agentAPI = {
  // Servers predating the storage flag report only availability.
  status: () => api.get<{ available: boolean; storage?: boolean }>('/agent/status')
    .then((r): AgentStatus => ({ available: r.data.available, storage: r.data.storage ?? r.data.available })),
  list: () => api.get<{ conversations: Conversation[] }>('/agent/conversations').then(r => r.data.conversations),
  create: (context: AgentContext, signal?: AbortSignal) => api.post<{ conversation: Conversation }>('/agent/conversations', context, { signal }).then(r => r.data.conversation),
  get: (id: string) => api.get<ConversationState>(path(id)).then(r => state(r.data)),
  remove: (id: string) => api.delete(path(id)),
  clear: () => api.delete('/agent/conversations'),
  send: (id: string, body: MessageRequest, signal: AbortSignal) => api.post<ConversationState>(`${path(id)}/messages`, body, { signal }).then(r => state(r.data)),
  cancel: (id: string, requestId: string) => api.post(`${path(id)}/runs/${encodeURIComponent(requestId)}/cancel`),
  edit: (id: string, version: number, rows: DraftRow[]) => api.patch<ConversationState>(`${path(id)}/draft`, { version, rows }).then(r => state(r.data)),
  discard: (id: string, version: number) => api.delete<ConversationState>(`${path(id)}/draft`, { data: { version } }).then(r => state(r.data)),
  confirm: (id: string, body: ConfirmRequest) => api.post<ConversationState>(`${path(id)}/confirm`, body).then(r => state(r.data)),
  confirmGoal: (id: string, body: GoalConfirmRequest) => api.post<ConversationState>(`${path(id)}/goal-proposal/confirm`, body).then(r => state(r.data)),
  discardGoal: (id: string, proposalId: string) => api.delete<ConversationState>(`${path(id)}/goal-proposal`, { data: { proposalId } }).then(r => state(r.data)),
  undo: (id: string) => api.post(`/agent/receipts/${encodeURIComponent(id)}/undo`),
}

export function agentErrorCode(error: unknown): string {
  const candidate = error as { response?: { status?: number; data?: { code?: string } } }
  if (candidate?.response?.data?.code) return candidate.response.data.code
  if (!candidate?.response) return 'agent_network_error'
  return candidate.response.status === 429 ? 'agent_rate_limited' : 'agent_request_failed'
}

// No response, or a server failure without an application code (a proxy or
// gateway error), may have completed: keep the exact request for replay.
export function agentOutcomeUnknown(error: unknown): boolean {
  const candidate = error as { response?: { status?: number; data?: { code?: string } } }
  return !candidate?.response || ((candidate.response.status || 0) >= 500 && !candidate.response.data?.code)
}

export function agentUnavailable(error: unknown): boolean {
  const candidate = error as { response?: { status?: number } }
  return candidate?.response?.status === 503 && agentErrorCode(error) === 'agent_unavailable'
}
