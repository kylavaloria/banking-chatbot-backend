// ─────────────────────────────────────────────────────────────────────────────
// Policy Agent — Slice 1 + Slice 2 + Slice 3
// Slice 3 additions: multi_issue branch, hybrid branch, topic_switch note
// ─────────────────────────────────────────────────────────────────────────────

import type { IntentResult }  from '../contracts/intent.contract';
import type { TriageResult }  from '../contracts/triage.contract';
import type {
  PolicyDecision, AllowedAction, NextPolicyStep, RefusalReason,
} from '../contracts/policy.contract';
import type { ActionPlan, ResponseMode } from '../contracts/action.contract';
import { CARD_BLOCK_ELIGIBLE_INTENTS }   from '../contracts/intent.contract';

type ToneProfile = 'neutral' | 'helpful' | 'reassuring' | 'urgent_but_calm' | 'structured_reassuring';

function resolveTone(responseMode: ResponseMode): ToneProfile {
  switch (responseMode) {
    case 'informational':               return 'neutral';
    case 'clarification':               return 'helpful';
    case 'ticket_confirmation':         return 'reassuring';
    case 'critical_action_confirmation':return 'urgent_but_calm';
    case 'multi_issue_confirmation':    return 'structured_reassuring';
    case 'refusal':                     return 'neutral';
  }
}

export interface PolicyOutput {
  decision: PolicyDecision;
  plan:     ActionPlan;
  tone:     ToneProfile;
  evidence: string[];
}

const SPECIAL_INTENT_TYPES = new Set<string>([
  'unclear_issue', 'general_complaint', 'multi_issue_case',
]);

// ---------------------------------------------------------------------------
// Branch predicates
// ---------------------------------------------------------------------------

function isMaliciousOrOutOfScope(ir: IntentResult): boolean {
  return ir.flags.malicious_input ||
    ir.intent_type === 'unsupported_request' ||
    ir.intent_group === 'out_of_scope';
}

function isAmbiguous(ir: IntentResult): boolean {
  return (ir.flags.ambiguous || ir.intent_type === 'unclear_issue') &&
    !ir.flags.multi_issue && !ir.flags.hybrid;
}

function isInformational(ir: IntentResult): boolean {
  return ir.intent_group === 'informational' && !ir.flags.hybrid && !ir.flags.multi_issue;
}

function isMultiIssue(ir: IntentResult): boolean {
  return ir.flags.multi_issue;
}

function isHybrid(ir: IntentResult): boolean {
  return ir.flags.hybrid && !ir.flags.multi_issue;
}

function isOperational(ir: IntentResult): boolean {
  return ir.intent_group === 'operational' &&
    !ir.flags.multi_issue && !ir.flags.hybrid &&
    !SPECIAL_INTENT_TYPES.has(ir.intent_type);
}

// ---------------------------------------------------------------------------
// Branch builders
// ---------------------------------------------------------------------------

function buildRefusalDecision(reason: RefusalReason): { decision: PolicyDecision; plan: ActionPlan } {
  return {
    decision: { allowed_actions: [], next_policy_step: 'refusal', requires_human_support: false,
                requires_live_escalation: false, refusal_reason: reason,
                card_block_eligible: false, split_required: false },
    plan: { case_required: false, ticket_required: false, live_escalation_required: false,
            offer_card_block: false, split_required: false, informational_only: false,
            clarification_only: false, refusal_only: true, response_mode: 'refusal' },
  };
}

function buildClarificationDecision(): { decision: PolicyDecision; plan: ActionPlan } {
  return {
    decision: { allowed_actions: [], next_policy_step: 'clarification_loop',
                requires_human_support: false, requires_live_escalation: false,
                refusal_reason: 'none', card_block_eligible: false, split_required: false },
    plan: { case_required: false, ticket_required: false, live_escalation_required: false,
            offer_card_block: false, split_required: false, informational_only: false,
            clarification_only: true, refusal_only: false, response_mode: 'clarification' },
  };
}

function buildInformationalDecision(): { decision: PolicyDecision; plan: ActionPlan } {
  return {
    decision: { allowed_actions: ['provide_information'], next_policy_step: 'provide_information',
                requires_human_support: false, requires_live_escalation: false,
                refusal_reason: 'none', card_block_eligible: false, split_required: false },
    plan: { case_required: false, ticket_required: false, live_escalation_required: false,
            offer_card_block: false, split_required: false, informational_only: true,
            clarification_only: false, refusal_only: false, response_mode: 'informational' },
  };
}

function buildMultiIssueDecision(): { decision: PolicyDecision; plan: ActionPlan } {
  return {
    decision: {
      allowed_actions: ['create_case', 'create_ticket'],
      next_policy_step: 'split_into_multiple_tickets',
      requires_human_support: true, requires_live_escalation: false,
      refusal_reason: 'none', card_block_eligible: false, split_required: true,
    },
    plan: {
      case_required: true, ticket_required: true, live_escalation_required: false,
      offer_card_block: false, split_required: true, informational_only: false,
      clarification_only: false, refusal_only: false, response_mode: 'multi_issue_confirmation',
    },
  };
}

function buildHybridDecision(
  intentResult: IntentResult,
  triageResult: TriageResult
): { decision: PolicyDecision; plan: ActionPlan } {
  // Hybrid operational component follows same logic as standard operational
  const { priority } = triageResult;
  const cardBlockEligible = CARD_BLOCK_ELIGIBLE_INTENTS.has(intentResult.intent_type);
  const requiresLiveEscalation = priority === 'P1';

  const allowedActions: AllowedAction[] = ['provide_information', 'create_case', 'create_ticket'];
  if (cardBlockEligible)        allowedActions.push('offer_temporary_card_block');
  if (requiresLiveEscalation)   allowedActions.push('live_escalation');

  const responseMode: ResponseMode = requiresLiveEscalation
    ? 'critical_action_confirmation' : 'ticket_confirmation';

  return {
    decision: {
      allowed_actions: allowedActions,
      next_policy_step: requiresLiveEscalation ? 'live_escalation_flow' : 'standard_operational_flow',
      requires_human_support: true, requires_live_escalation: requiresLiveEscalation,
      refusal_reason: 'none', card_block_eligible: cardBlockEligible, split_required: false,
    },
    plan: {
      case_required: true, ticket_required: true,
      live_escalation_required: requiresLiveEscalation,
      offer_card_block: cardBlockEligible, split_required: false,
      informational_only: false, clarification_only: false, refusal_only: false,
      response_mode: responseMode,
    },
  };
}

function buildOperationalDecision(
  intentResult: IntentResult,
  triageResult: TriageResult
): { decision: PolicyDecision; plan: ActionPlan } {
  const { priority } = triageResult;
  const cardBlockEligible = CARD_BLOCK_ELIGIBLE_INTENTS.has(intentResult.intent_type);
  const requiresLiveEscalation = priority === 'P1';

  const allowedActions: AllowedAction[] = ['create_case', 'create_ticket'];
  if (cardBlockEligible)      allowedActions.push('offer_temporary_card_block');
  if (requiresLiveEscalation) allowedActions.push('live_escalation');

  const nextPolicyStep: NextPolicyStep = priority === 'P1'
    ? 'live_escalation_flow' : 'standard_operational_flow';
  const responseMode: ResponseMode = priority === 'P1'
    ? 'critical_action_confirmation' : 'ticket_confirmation';

  return {
    decision: {
      allowed_actions: allowedActions, next_policy_step: nextPolicyStep,
      requires_human_support: true, requires_live_escalation: requiresLiveEscalation,
      refusal_reason: 'none', card_block_eligible: cardBlockEligible, split_required: false,
    },
    plan: {
      case_required: true, ticket_required: true,
      live_escalation_required: requiresLiveEscalation,
      offer_card_block: cardBlockEligible, split_required: false,
      informational_only: false, clarification_only: false, refusal_only: false,
      response_mode: responseMode,
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function decide(
  intentResult: IntentResult,
  triageResult?: TriageResult
): PolicyOutput {
  const evidence: string[] = [];

  // Branch 1: Malicious / out-of-scope
  if (isMaliciousOrOutOfScope(intentResult)) {
    const reason: RefusalReason = intentResult.flags.malicious_input ? 'malicious_input' : 'unsupported_request';
    evidence.push(`Branch: refusal (${reason})`);
    const { decision, plan } = buildRefusalDecision(reason);
    return { decision, plan, tone: resolveTone(plan.response_mode), evidence };
  }

  // Branch 2: Ambiguous
  if (isAmbiguous(intentResult)) {
    evidence.push(`Branch: clarification_loop (confidence=${intentResult.confidence.toFixed(2)})`);
    const { decision, plan } = buildClarificationDecision();
    return { decision, plan, tone: resolveTone(plan.response_mode), evidence };
  }

  // Branch 3: Informational only
  if (isInformational(intentResult)) {
    evidence.push(`Branch: provide_information (${intentResult.intent_type})`);
    const { decision, plan } = buildInformationalDecision();
    return { decision, plan, tone: resolveTone(plan.response_mode), evidence };
  }

  // Branch 4: Multi-issue (Slice 3)
  if (isMultiIssue(intentResult)) {
    evidence.push(`Branch: split_into_multiple_tickets (${intentResult.issue_components.length} components)`);
    const { decision, plan } = buildMultiIssueDecision();
    return { decision, plan, tone: resolveTone(plan.response_mode), evidence };
  }

  // Branch 5: Hybrid (Slice 3)
  if (isHybrid(intentResult)) {
    if (!triageResult) {
      evidence.push('Branch: clarification_loop (safety — triage missing for hybrid)');
      const { decision, plan } = buildClarificationDecision();
      return { decision, plan, tone: resolveTone(plan.response_mode), evidence };
    }
    evidence.push(`Branch: hybrid (informational + operational/${triageResult.priority})`);
    const { decision, plan } = buildHybridDecision(intentResult, triageResult);
    return { decision, plan, tone: resolveTone(plan.response_mode), evidence };
  }

  // Branch 6: Standard operational
  if (isOperational(intentResult)) {
    if (!triageResult) {
      evidence.push('Branch: clarification_loop (safety — triage missing for operational)');
      const { decision, plan } = buildClarificationDecision();
      return { decision, plan, tone: resolveTone(plan.response_mode), evidence };
    }
    const cardBlockEligible = CARD_BLOCK_ELIGIBLE_INTENTS.has(intentResult.intent_type);
    evidence.push(`Branch: operational (${triageResult.priority}) cardBlock=${cardBlockEligible} topicSwitch=${intentResult.flags.topic_switch}`);
    const { decision, plan } = buildOperationalDecision(intentResult, triageResult);
    return { decision, plan, tone: resolveTone(plan.response_mode), evidence };
  }

  // Safety-net fallback
  evidence.push(`Safety-net fallback: ${intentResult.intent_type} → clarification`);
  const { decision, plan } = buildClarificationDecision();
  return { decision, plan, tone: resolveTone(plan.response_mode), evidence };
}