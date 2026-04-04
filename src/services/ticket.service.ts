import { v4 as uuidv4 } from 'uuid';
import { serviceClient } from '../config/supabase';

export type TicketPriority = 'P1' | 'P2' | 'P3';
export type TicketMode = 'standard_ticket' | 'urgent_ticket' | 'live_escalation';
export type TicketStatus = 'open' | 'in_progress' | 'resolved' | 'closed';

export interface CreateTicketParams {
  caseId: string;
  issueType: string;
  ticketPriority: TicketPriority;
  ticketMode: TicketMode;
  queueName?: string | null;
}

export interface TicketRecord {
  ticket_id: string;
  case_id: string;
  issue_type: string;
  ticket_priority: TicketPriority;
  ticket_mode: TicketMode;
  queue_name: string | null;
  status: TicketStatus;
  ticket_priority_last_updated_at: string | null;
  deadline_escalation_flag: boolean;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export async function createTicket(
  params: CreateTicketParams
): Promise<TicketRecord> {
  const now = new Date().toISOString();

  const newTicket = {
    ticket_id: uuidv4(),
    case_id: params.caseId,
    issue_type: params.issueType,
    ticket_priority: params.ticketPriority,
    ticket_mode: params.ticketMode,
    queue_name: params.queueName ?? null,
    status: 'open' as const,
    ticket_priority_last_updated_at: now,
    deadline_escalation_flag: false,
    created_at: now,
    updated_at: now,
    closed_at: null,
  };

  const { data, error } = await serviceClient
    .from('tickets')
    .insert(newTicket)
    .select()
    .single();

  if (error || !data) {
    throw { status: 500, message: 'Failed to create ticket.' };
  }

  return data as TicketRecord;
}