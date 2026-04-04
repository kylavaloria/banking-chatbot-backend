import { v4 as uuidv4 } from 'uuid';
import { serviceClient } from '../config/supabase';

export type CaseStage =
  | 'initial'
  | 'clarification_loop'
  | 'case_created'
  | 'ticket_created'
  | 'awaiting_card_block_confirmation'
  | 'live_escalation_triggered'
  | 'split_ticket_created';

export type Priority = 'P1' | 'P2' | 'P3';
export type RecommendedPath = 'standard_ticket' | 'urgent_ticket' | 'live_escalation';
export type Importance = 'low' | 'medium' | 'high';
export type Urgency = 'low' | 'medium' | 'high';

export interface CreateCaseParams {
  customerId: string;
  sessionId: string;
  primaryIntentType: string;
  summary: string;
  importance: Importance;
  urgency: Urgency;
  priority: Priority;
  recommendedPath: RecommendedPath;
}

export interface CaseRecord {
  case_id: string;
  customer_id: string;
  session_id: string;
  primary_intent_type: string;
  summary: string;
  importance: Importance;
  urgency: Urgency;
  priority: Priority;
  recommended_path: RecommendedPath;
  status: 'open' | 'escalated' | 'resolved' | 'closed';
  stage: CaseStage;
  multi_issue: boolean;
  sla_start_at: string;
  priority_last_updated_at: string | null;
  priority_escalation_reason: string | null;
  card_block_status: 'not_applicable' | 'offered' | 'confirmed' | 'completed';
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export async function createCase(params: CreateCaseParams): Promise<CaseRecord> {
  const now = new Date().toISOString();

  const newCase = {
    case_id: uuidv4(),
    customer_id: params.customerId,
    session_id: params.sessionId,
    primary_intent_type: params.primaryIntentType,
    summary: params.summary,
    importance: params.importance,
    urgency: params.urgency,
    priority: params.priority,
    recommended_path: params.recommendedPath,
    status: 'open' as const,
    stage: 'case_created' as const,
    multi_issue: false,
    sla_start_at: now,
    priority_last_updated_at: now,
    priority_escalation_reason: 'initial_triage' as const,
    card_block_status: 'not_applicable' as const,
    created_at: now,
    updated_at: now,
    closed_at: null,
  };

  const { data, error } = await serviceClient
    .from('cases')
    .insert(newCase)
    .select()
    .single();

  if (error || !data) {
    throw { status: 500, message: 'Failed to create case.' };
  }

  return data as CaseRecord;
}

export async function updateCaseStage(
  caseId: string,
  stage: CaseStage
): Promise<void> {
  const { error } = await serviceClient
    .from('cases')
    .update({
      stage,
      updated_at: new Date().toISOString(),
    })
    .eq('case_id', caseId);

  if (error) {
    throw { status: 500, message: 'Failed to update case stage.' };
  }
}