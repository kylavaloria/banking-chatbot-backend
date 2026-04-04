import { v4 as uuidv4 } from 'uuid';
import { serviceClient } from '../config/supabase';

export type SenderType = 'user' | 'assistant' | 'system';

export type ResponseMode =
  | 'informational'
  | 'clarification'
  | 'ticket_confirmation'
  | 'critical_action_confirmation'
  | 'multi_issue_confirmation'
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

export async function storeMessage(
  params: StoreMessageParams
): Promise<MessageRecord> {
  const newMessage = {
    message_id: uuidv4(),
    session_id: params.sessionId,
    case_id: params.caseId ?? null,
    ticket_id: params.ticketId ?? null,
    sender_type: params.senderType,
    message_text: params.messageText,
    response_mode: params.responseMode ?? null,
    created_at: new Date().toISOString(),
  };

  const { data, error } = await serviceClient
    .from('messages')
    .insert(newMessage)
    .select()
    .single();

  if (error || !data) {
    throw { status: 500, message: 'Failed to store message.' };
  }

  return data as MessageRecord;
}