import { v4 as uuidv4 } from 'uuid';
import { serviceClient } from '../config/supabase';

export type ActionType =
  | 'create_case'
  | 'create_ticket'
  | 'offer_temporary_card_block'
  | 'confirm_temporary_card_block'
  | 'live_escalation'
  | 'clarification_requested'
  | 'split_into_multiple_tickets'
  | 'information_provided'
  | 'priority_escalated'
  | 'sla_breach_detected'
  | 'ticket_reprioritized'
  | 'unsafe_request_logged';

export type ActionStatus = 'pending' | 'completed' | 'failed';
export type ActorType = 'system' | 'user';

export interface LogActionParams {
  caseId: string;
  ticketId?: string | null;
  actionType: ActionType;
  actionStatus: ActionStatus;
  actorType: ActorType;
  actorName?: string | null;
  notes?: string | null;
  metadataJson?: Record<string, unknown> | null;
}

export async function logAction(params: LogActionParams): Promise<void> {
  const newAction = {
    action_id: uuidv4(),
    case_id: params.caseId,
    ticket_id: params.ticketId ?? null,
    action_type: params.actionType,
    action_status: params.actionStatus,
    actor_type: params.actorType,
    actor_name: params.actorName ?? null,
    notes: params.notes ?? null,
    metadata_json: params.metadataJson ?? null,
    created_at: new Date().toISOString(),
  };

  const { error } = await serviceClient
    .from('case_actions')
    .insert(newAction);

  if (error) {
    throw { status: 500, message: 'Failed to log case action.' };
  }
}