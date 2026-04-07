// ─────────────────────────────────────────────────────────────────────────────
// SLA Evaluator — Slice 6 + Business Day Logic
// ─────────────────────────────────────────────────────────────────────────────

import { serviceClient }      from '../config/supabase';
import { businessDaysSince }  from './business-days';

// ---------------------------------------------------------------------------
// Types (unchanged)
// ---------------------------------------------------------------------------

export type CasePriority = 'P1' | 'P2' | 'P3';

export interface ActiveCase {
  case_id:                    string;
  priority:                   CasePriority;
  status:                     'open' | 'escalated';
  sla_start_at:               string;
  priority_last_updated_at:   string | null;
  priority_escalation_reason: string | null;
}

export type EscalationOutcome =
  | 'p3_to_p2'
  | 'p2_to_p1'
  | 'sla_breach';

export interface EscalationDecision {
  case_id:           string;
  old_priority:      CasePriority;
  new_priority:      CasePriority;
  outcome:           EscalationOutcome;
  /** Business days elapsed — replaces calendar days */
  elapsed_days:      number;
  escalation_reason: string;
}

// ---------------------------------------------------------------------------
// SLA thresholds — now in BUSINESS days
// ---------------------------------------------------------------------------

const SLA_THRESHOLDS = {
  P3_ESCALATE_DAYS:  3,   // P3 → P2 after 3 business days
  P2_ESCALATE_DAYS:  7,   // P2 → P1 after 7 business days
  P1_BREACH_DAYS:   14,   // P1 breach after 14 business days
} as const;

// ---------------------------------------------------------------------------
// Elapsed time — now counts business days
// ---------------------------------------------------------------------------

/**
 * Returns the number of business days elapsed since referenceTimestamp.
 * Replaces the old calendar-day computeElapsedDays function.
 */
export function computeElapsedDays(
  referenceTimestamp: string,
  now: Date = new Date()
): number {
  return businessDaysSince(referenceTimestamp, now);
}

// ---------------------------------------------------------------------------
// Reference timestamp selection (unchanged)
// ---------------------------------------------------------------------------

export function selectReferenceTimestamp(c: ActiveCase): string {
  if (c.priority === 'P3') return c.sla_start_at;
  return c.priority_last_updated_at ?? c.sla_start_at;
}

// ---------------------------------------------------------------------------
// Single-case evaluation (unchanged logic, now uses business days)
// ---------------------------------------------------------------------------

export function evaluateCase(
  c: ActiveCase,
  now: Date = new Date()
): EscalationDecision | null {
  const ref         = selectReferenceTimestamp(c);
  const elapsedDays = computeElapsedDays(ref, now);

  switch (c.priority) {
    case 'P3': {
      if (elapsedDays >= SLA_THRESHOLDS.P3_ESCALATE_DAYS) {
        return {
          case_id:           c.case_id,
          old_priority:      'P3',
          new_priority:      'P2',
          outcome:           'p3_to_p2',
          elapsed_days:      elapsedDays,
          escalation_reason: 'aging_3_business_days',
        };
      }
      return null;
    }

    case 'P2': {
      if (elapsedDays >= SLA_THRESHOLDS.P2_ESCALATE_DAYS) {
        return {
          case_id:           c.case_id,
          old_priority:      'P2',
          new_priority:      'P1',
          outcome:           'p2_to_p1',
          elapsed_days:      elapsedDays,
          escalation_reason: 'aging_7_business_days',
        };
      }
      return null;
    }

    case 'P1': {
      if (elapsedDays >= SLA_THRESHOLDS.P1_BREACH_DAYS) {
        return {
          case_id:           c.case_id,
          old_priority:      'P1',
          new_priority:      'P1',
          outcome:           'sla_breach',
          elapsed_days:      elapsedDays,
          escalation_reason: 'sla_breach',
        };
      }
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Batch evaluation (unchanged)
// ---------------------------------------------------------------------------

export function evaluateCases(
  cases: ActiveCase[],
  now: Date = new Date()
): EscalationDecision[] {
  const decisions: EscalationDecision[] = [];
  for (const c of cases) {
    const decision = evaluateCase(c, now);
    if (decision) decisions.push(decision);
  }
  return decisions;
}

// ---------------------------------------------------------------------------
// DB fetch (unchanged)
// ---------------------------------------------------------------------------

export async function getActiveCases(): Promise<ActiveCase[]> {
  const { data, error } = await serviceClient
    .from('cases')
    .select('case_id, priority, status, sla_start_at, priority_last_updated_at, priority_escalation_reason')
    .in('status', ['open', 'escalated']);

  if (error) {
    throw new Error(`[SLA Evaluator] Failed to fetch active cases: ${error.message}`);
  }

  return (data ?? []) as ActiveCase[];
}