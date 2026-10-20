/**
 * One interface per table in db/schema.sql, written by hand. Update this file
 * in the same commit as any schema.sql edit or migration.
 *
 * How node-pg hands columns back here:
 * - DATE is the plain string '2026-08-28' (the type parser in db/connection);
 * - DECIMAL is a string ('12.50'), because pg does not parse it;
 * - TIMESTAMP is a Date;
 * - a column without NOT NULL can be null.
 */

export interface UserRow {
  id: number;
  email: string;
  password_hash: string;
  first_name: string;
  last_name: string;
  email_verified: boolean | null;
  email_verification_token: string | null;
  email_verification_expires: Date | null;
  created_at: Date | null;
  updated_at: Date | null;
  language: string;
  email_notifications_enabled: boolean;
  weekly_reports_enabled: boolean;
  is_demo: boolean;
  /** Terms of transactions kept (migration 016); null is off. */
  transaction_retention_terms: number | null;
  /** Version of the terms and privacy policy accepted (migration 017); null is never. */
  terms_version: string | null;
  terms_accepted_at: Date | null;
}

export type TransactionType = 'income' | 'expense';
export type TransactionSource = 'manual' | 'ocr' | 'ocr_llm' | 'agent';

export interface TransactionRow {
  id: number;
  user_id: number;
  amount: string;
  description: string;
  category: string;
  type: TransactionType;
  date: string;
  currency: string;
  source: TransactionSource;
  created_at: Date | null;
  updated_at: Date | null;
}

export interface ImportBatchRow {
  id: number;
  user_id: number;
  row_count: number;
  edited_count: number;
  llm_count: number;
  created_at: Date | null;
}

export interface AccessTokenRow {
  id: number;
  user_id: number;
  name: string;
  token_hash: string;
  created_at: Date | null;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

export interface SavingsGoalRow {
  id: number;
  user_id: number;
  name: string;
  target_amount: string;
  current_amount: string | null;
  target_date: string | null;
  description: string | null;
  currency: string;
  created_at: Date | null;
  updated_at: Date | null;
}

// Conversational transaction storage (migration 013).
import type { Conversation, Message, Draft, Receipt, Run, GoalFields } from '../services/agent/types';
export interface AgentConversationRow extends Conversation { user_id: number; draft_version: number }
export interface AgentRunRow extends Run {
  conversation_id: string; user_id: number; request_hash: string;
  created_at: Date; lease_until: Date; finished_at: Date | null;
  input_tokens: number | null; output_tokens: number | null; tool_calls: number | null;
}
export interface AgentMessageRow extends Message { conversation_id: string; user_id: number; run_id: string | null }
export interface AgentDraftRow extends Draft { conversation_id: string; user_id: number; created_at: Date }
export interface AgentTransactionVersion { id: number; updated_at: string; xmin: string }
export interface AgentReceiptRow extends Receipt {
  conversation_id: string | null; user_id: number; request_hash: string;
  transaction_versions: AgentTransactionVersion[];
}

export interface AgentAdmissionRow { id: string; user_id: number; created_at: Date }

// Goal changes Pocky proposes for button confirmation (migration 015).
export interface AgentGoalProposalRow {
  id: string; conversation_id: string; user_id: number; run_id: string | null;
  action: 'create' | 'update'; goal_id: number | null;
  /** savings_goals.updated_at as PostgreSQL text when proposed; compared as text at confirmation. */
  expected_updated_at: string | null;
  before: GoalFields | null; after: GoalFields;
  status: 'pending' | 'confirmed' | 'cancelled' | 'superseded' | 'conflict' | 'expired';
  request_id: string | null; request_hash: string | null; result_goal_id: number | null;
  created_at: Date; expires_at: Date; decided_at: Date | null;
}

/** db/migrations/ files applied to this database (db/migrate.ts). */
export interface SchemaMigrationRow {
  name: string;
  checksum: string;
  applied_at: Date;
}
