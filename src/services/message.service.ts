import { v4 as uuidv4 } from 'uuid';
import { serviceClient } from '../config/supabase';

export type SenderType = 'user' | 'assistant' | 'system';

export type ResponseMode =
  | 'informational'
  | 'clarification'
  | 'ticket_confirmation'
  | 'critical_action_confirmation'
  | 'multi_issue_confirmation'
  | 'follow_up_update'
  | 'refusal';

export interface StoreMessageParams {
  sessionId: string;
  caseId?: string | null;
  ticketId?: string | null;
  senderType: SenderType;
  messageText: string;
  responseMode?: ResponseMode | null;
}

export interface MessageRecord {
  message_id: string;
  session_id: string;
  case_id: string | null;
  ticket_id: string | null;
  sender_type: SenderType;
  message_text: string;
  response_mode: ResponseMode | null;
  created_at: string;
}

function isLikelyResponseModeRejectedByDb(error: { message?: string; code?: string } | null): boolean {
  if (!error) return false;
  const m = (error.message ?? '').toLowerCase();
  return (
    error.code === '22P02' ||
    m.includes('invalid input value for enum') ||
    m.includes('violates check constraint') ||
    m.includes('check constraint')
  );
}

export async function storeMessage(
  params: StoreMessageParams
): Promise<MessageRecord> {
  const message_id = uuidv4();
  const row = {
    message_id,
    session_id: params.sessionId,
    case_id: params.caseId ?? null,
    ticket_id: params.ticketId ?? null,
    sender_type: params.senderType,
    message_text: params.messageText,
    response_mode: params.responseMode ?? null,
    created_at: new Date().toISOString(),
  };

  let { data, error } = await serviceClient
    .from('messages')
    .insert(row)
    .select()
    .single();

  if (
    error &&
    params.responseMode === 'follow_up_update' &&
    isLikelyResponseModeRejectedByDb(error)
  ) {
    console.warn(
      '[storeMessage] DB rejected response_mode=follow_up_update (extend enum: scripts/migrations/2026-04-28-add-follow-up-response-mode.sql). Retrying with null. Supabase:',
      error.message
    );
    ({ data, error } = await serviceClient
      .from('messages')
      .insert({ ...row, response_mode: null })
      .select()
      .single());
  }

  if (error || !data) {
    console.warn(
      '[storeMessage] Supabase insert failed:',
      error?.message,
      error?.details,
      error?.code
    );
    throw { status: 500, message: 'Failed to store message.' };
  }

  return data as MessageRecord;
}