import { v4 as uuidv4 } from 'uuid';
import { serviceClient } from '../config/supabase';

export interface SessionRecord {
  session_id: string;
  customer_id: string;
  channel: string;
  session_status: 'active' | 'closed';
  current_case_id: string | null;
  started_at: string;
  ended_at: string | null;
}

/**
 * Returns the most recent active session for this customer,
 * or creates a new one if none exists.
 */
export async function getOrCreateActiveSession(
  customerId: string
): Promise<SessionRecord> {
  const { data: existing, error: fetchError } = await serviceClient
    .from('chat_sessions')
    .select('*')
    .eq('customer_id', customerId)
    .eq('session_status', 'active')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (fetchError) {
    throw { status: 500, message: 'Failed to query chat sessions.' };
  }

  if (existing) {
    return existing as SessionRecord;
  }

  const now = new Date().toISOString();

  const newSession = {
    session_id: uuidv4(),
    customer_id: customerId,
    channel: 'web',
    session_status: 'active' as const,
    current_case_id: null,
    started_at: now,
    ended_at: null,
  };

  const { data, error: insertError } = await serviceClient
    .from('chat_sessions')
    .insert(newSession)
    .select()
    .single();

  if (insertError || !data) {
    throw { status: 500, message: 'Failed to create chat session.' };
  }

  return data as SessionRecord;
}

/**
 * Sets current_case_id on the session after a case is created.
 */
export async function linkCaseToSession(
  sessionId: string,
  caseId: string
): Promise<void> {
  const { error } = await serviceClient
    .from('chat_sessions')
    .update({ current_case_id: caseId })
    .eq('session_id', sessionId);

  if (error) {
    throw { status: 500, message: 'Failed to link case to session.' };
  }
}