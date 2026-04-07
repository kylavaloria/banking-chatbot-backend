export interface TicketView {
  ticket_id:          string;
  issue_type:         string;
  ticket_priority:    'P1' | 'P2' | 'P3';
  ticket_mode:        'live_escalation' | 'urgent_ticket' | 'standard_ticket';
  status:             'open' | 'in_progress' | 'resolved' | 'closed';
  created_at:         string;
  case_id:            string;
  case_summary:       string;
  card_block_status:  'not_applicable' | 'offered' | 'confirmed' | 'completed';
  customer_full_name: string | null;
  customer_email:     string;
  customer_mobile:    string | null;
  customer_segment:   string | null;
}
