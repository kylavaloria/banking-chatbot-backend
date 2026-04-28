import type { ResponseMode } from './action.contract';

export type ToneProfile =
  | 'neutral'
  | 'helpful'
  | 'reassuring'
  | 'urgent_but_calm'
  | 'structured_reassuring';

export interface ResponseInput {
  response_mode:              ResponseMode;
  intent_summary:             string;
  actions_taken:              string[];
  next_step:                  string;
  tone_profile:               ToneProfile;
  card_block_offered?:        boolean;
  live_escalation_triggered?: boolean;
  informational_answer?:      string | null;
  clarification_question?:    string | null;
  refusal_reason?:            'unsupported_request' | 'malicious_input' | null;
  /** Set when updating an existing open case without creating a new ticket */
  is_follow_up?:              boolean;
}
