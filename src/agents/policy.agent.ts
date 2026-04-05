// ─────────────────────────────────────────────────────────────────────────────
// Policy Agent — Rule-Based Implementation (Phase 2, Slice 1)
// Scope: single operational issue, informational, clarification, refusal.
// Multi-issue and hybrid flows are out of scope for this slice.
//
// The Policy Agent is a pure function — no DB access, no LLM, no side effects.
// It reads IntentResult + optional TriageResult and declares what is allowed.
// The Action Agent only executes what is declared here.
//
// SRS policy rules implemented:
//   FR-POL-01: ambiguous         → clarification_loop
//   FR-POL-02: multi_issue       → split (out of scope; guarded)
//   FR-POL-03: informational     → provide_information only
//   FR-POL-04: operational       → create_case + create_ticket
//   FR-POL-05: card block        → + offer_temporary_card_block
//   FR-POL-06: P1                → + live_escalation
//   FR-POL-07: unsupported action→ human support (guarded by whitelist)
//   FR-POL-08: malicious/OOS     → refusal; no case; no ticket
// ─────────────────────────────────────────────────────────────────────────────

import type { IntentResult } from '../contracts/intent.contract';
import type { TriageResult } from '../contracts/triage.contract';
import type {
  PolicyDecision,
  AllowedAction,
  NextPolicyStep,
  RefusalReason,
} from '../contracts/policy.contract';
import type { ActionPlan, ResponseMode } from '../contracts/action.contract';

import { CARD_BLOCK_ELIGIBLE_INTENTS } from '../contracts/intent.contract';

// ---------------------------------------------------------------------------
// Tone profile helper
// Kept here to centralise the mode → tone mapping that both Policy and
// Response agents need to agree on.
// ---------------------------------------------------------------------------

type ToneProfile =
  | 'neutral'
  | 'helpful'
  | 'reassuring'
  | 'urgent_but_calm'
  | 'structured_reassuring';

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

// ---------------------------------------------------------------------------
// Branch evaluators
// Each returns true when its branch applies.
// Evaluated in priority order inside decide().
// ---------------------------------------------------------------------------

function isMaliciousOrOutOfScope(intentResult: IntentResult): boolean {
  return (
    intentResult.flags.malicious_input ||
    intentResult.intent_type === 'unsupported_request' ||
    intentResult.intent_group === 'out_of_scope'
  );
}

const SPECIAL_INTENT_TYPES = new Set<string>([
  'unclear_issue',
  'general_complaint',
  'multi_issue_case',
]);

function isAmbiguous(intentResult: IntentResult): boolean {
  return (
    intentResult.flags.ambiguous ||
    SPECIAL_INTENT_TYPES.has(intentResult.intent_type)
  );
}

function isInformational(intentResult: IntentResult): boolean {
  return (
    intentResult.intent_group === 'informational' &&
    !intentResult.flags.hybrid
  );
}

function isOperational(intentResult: IntentResult): boolean {
  return (
    intentResult.intent_group === 'operational' &&
    !intentResult.flags.multi_issue &&
    !intentResult.flags.hybrid &&
    !SPECIAL_INTENT_TYPES.has(intentResult.intent_type)
  );
}

// ---------------------------------------------------------------------------
// Branch builders
// Each returns the complete PolicyDecision + ActionPlan for its branch.
// ---------------------------------------------------------------------------

function buildRefusalDecision(
  refusalReason: RefusalReason
): { decision: PolicyDecision; plan: ActionPlan } {
  const responseMode: ResponseMode = 'refusal';
  return {
    decision: {
      allowed_actions: [],
      next_policy_step: 'refusal',
      requires_human_support: false,
      requires_live_escalation: false,
      refusal_reason: refusalReason,
      card_block_eligible: false,
      split_required: false,
    },
    plan: {
      case_required: false,
      ticket_required: false,
      live_escalation_required: false,
      offer_card_block: false,
      split_required: false,
      informational_only: false,
      clarification_only: false,
      refusal_only: true,
      response_mode: responseMode,
    },
  };
}

function buildClarificationDecision(): { decision: PolicyDecision; plan: ActionPlan } {
  const responseMode: ResponseMode = 'clarification';
  return {
    decision: {
      allowed_actions: [],
      next_policy_step: 'clarification_loop',
      requires_human_support: false,
      requires_live_escalation: false,
      refusal_reason: 'none',
      card_block_eligible: false,
      split_required: false,
    },
    plan: {
      case_required: false,
      ticket_required: false,
      live_escalation_required: false,
      offer_card_block: false,
      split_required: false,
      informational_only: false,
      clarification_only: true,
      refusal_only: false,
      response_mode: responseMode,
    },
  };
}

function buildInformationalDecision(): { decision: PolicyDecision; plan: ActionPlan } {
  const responseMode: ResponseMode = 'informational';
  return {
    decision: {
      allowed_actions: ['provide_information'],
      next_policy_step: 'provide_information',
      requires_human_support: false,
      requires_live_escalation: false,
      refusal_reason: 'none',
      card_block_eligible: false,
      split_required: false,
    },
    plan: {
      case_required: false,
      ticket_required: false,
      live_escalation_required: false,
      offer_card_block: false,
      split_required: false,
      informational_only: true,
      clarification_only: false,
      refusal_only: false,
      response_mode: responseMode,
    },
  };
}

function buildOperationalDecision(
  intentResult: IntentResult,
  triageResult: TriageResult
): { decision: PolicyDecision; plan: ActionPlan } {
  const { priority } = triageResult;
  const intentType = intentResult.intent_type;

  // Base allowed actions for all operational concerns
  const allowedActions: AllowedAction[] = ['create_case', 'create_ticket'];

  // FR-POL-05: card block additive
  const cardBlockEligible = CARD_BLOCK_ELIGIBLE_INTENTS.has(intentType);
  if (cardBlockEligible) {
    allowedActions.push('offer_temporary_card_block');
  }

  // FR-POL-06: live escalation additive for P1
  const requiresLiveEscalation = priority === 'P1';
  if (requiresLiveEscalation) {
    allowedActions.push('live_escalation');
  }

  // Determine next policy step and response mode
  const nextPolicyStep: NextPolicyStep =
    priority === 'P1' ? 'live_escalation_flow' : 'standard_operational_flow';

  const responseMode: ResponseMode =
    priority === 'P1' ? 'critical_action_confirmation' : 'ticket_confirmation';

  return {
    decision: {
      allowed_actions: allowedActions,
      next_policy_step: nextPolicyStep,
      requires_human_support: true,
      requires_live_escalation: requiresLiveEscalation,
      refusal_reason: 'none',
      card_block_eligible: cardBlockEligible,
      split_required: false,
    },
    plan: {
      case_required: true,
      ticket_required: true,
      live_escalation_required: requiresLiveEscalation,
      offer_card_block: cardBlockEligible,
      split_required: false,
      informational_only: false,
      clarification_only: false,
      refusal_only: false,
      response_mode: responseMode,
    },
  };
}

// ---------------------------------------------------------------------------
// PolicyOutput — both decision and plan returned together
// Downstream agents receive both without a second call.
// ---------------------------------------------------------------------------

export interface PolicyOutput {
  decision: PolicyDecision;
  plan: ActionPlan;
  /** The tone the Response Agent should use for this response mode */
  tone: ToneProfile;
  /** Short audit trail of which branch fired and why */
  evidence: string[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evaluates IntentResult + optional TriageResult and returns a PolicyOutput.
 *
 * triageResult is required when intent_group = 'operational'.
 * It is ignored for informational, clarification, and refusal branches.
 *
 * Branch evaluation order (must not be changed):
 *   1. Malicious / out-of-scope  → refusal
 *   2. Ambiguous                 → clarification_loop
 *   3. Informational             → provide_information
 *   4. Operational               → create_case + create_ticket (± extras)
 *   5. Fallback                  → clarification_loop (safety net)
 */
export function decide(
  intentResult: IntentResult,
  triageResult?: TriageResult
): PolicyOutput {
  const evidence: string[] = [];

  // ── Branch 1: Malicious or out-of-scope (FR-POL-08) ──────────────────────
  if (isMaliciousOrOutOfScope(intentResult)) {
    const refusalReason: RefusalReason = intentResult.flags.malicious_input
      ? 'malicious_input'
      : 'unsupported_request';

    evidence.push(`Branch: refusal (${refusalReason})`);
    if (intentResult.flags.malicious_input) {
      evidence.push('Trigger: flags.malicious_input = true');
    } else {
      evidence.push(`Trigger: intent_type=${intentResult.intent_type} intent_group=${intentResult.intent_group}`);
    }

    const { decision, plan } = buildRefusalDecision(refusalReason);
    return { decision, plan, tone: resolveTone(plan.response_mode), evidence };
  }

  // ── Branch 2: Ambiguous (FR-POL-01) ──────────────────────────────────────
  if (isAmbiguous(intentResult)) {
    evidence.push('Branch: clarification_loop');
    evidence.push(`Trigger: flags.ambiguous=${intentResult.flags.ambiguous} intent_type=${intentResult.intent_type} confidence=${intentResult.confidence.toFixed(2)}`);

    const { decision, plan } = buildClarificationDecision();
    return { decision, plan, tone: resolveTone(plan.response_mode), evidence };
  }

  // ── Branch 3: Informational (FR-POL-03) ──────────────────────────────────
  if (isInformational(intentResult)) {
    evidence.push('Branch: provide_information');
    evidence.push(`Trigger: intent_group=informational intent_type=${intentResult.intent_type}`);

    const { decision, plan } = buildInformationalDecision();
    return { decision, plan, tone: resolveTone(plan.response_mode), evidence };
  }

  // ── Branch 4: Operational (FR-POL-04, FR-POL-05, FR-POL-06) ─────────────
  if (isOperational(intentResult)) {
    if (!triageResult) {
      // Safety guard: triage must always precede policy for operational intents.
      // Fall through to the safety-net clarification rather than throwing,
      // to keep the API path alive.
      evidence.push('Branch: clarification_loop (safety fallback — triage missing for operational intent)');
      const { decision, plan } = buildClarificationDecision();
      return { decision, plan, tone: resolveTone(plan.response_mode), evidence };
    }

    const { priority } = triageResult;
    const cardBlockEligible = CARD_BLOCK_ELIGIBLE_INTENTS.has(intentResult.intent_type);

    evidence.push(`Branch: ${priority === 'P1' ? 'live_escalation_flow' : 'standard_operational_flow'}`);
    evidence.push(`Trigger: intent_type=${intentResult.intent_type} priority=${priority} recommended_path=${triageResult.recommended_path}`);
    if (cardBlockEligible) {
      evidence.push(`Card block eligible: intent_type=${intentResult.intent_type}`);
    }
    if (priority === 'P1') {
      evidence.push(`Live escalation required: priority=P1 override_reason=${triageResult.override_reason}`);
    }

    const { decision, plan } = buildOperationalDecision(intentResult, triageResult);
    return { decision, plan, tone: resolveTone(plan.response_mode), evidence };
  }

  // ── Branch 5: Safety-net fallback ────────────────────────────────────────
  // Reached only if none of the above branches matched.
  // Treats anything unclassifiable as ambiguous to avoid silent failures.
  evidence.push('Branch: clarification_loop (safety-net fallback — no branch matched)');
  evidence.push(`Unmatched: intent_type=${intentResult.intent_type} intent_group=${intentResult.intent_group}`);

  const { decision, plan } = buildClarificationDecision();
  return { decision, plan, tone: resolveTone(plan.response_mode), evidence };
}