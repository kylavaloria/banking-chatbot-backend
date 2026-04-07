// ─────────────────────────────────────────────────────────────────────────────
// Slice 6 unit tests — SLA Evaluator + Business Day Calculator
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import {
  evaluateCase,
  evaluateCases,
  computeElapsedDays,
  selectReferenceTimestamp,
} from '../src/jobs/sla-evaluator';
import {
  countBusinessDays,
  businessDaysSince,
  isBusinessDay,
} from '../src/jobs/business-days';
import type { ActiveCase } from '../src/jobs/sla-evaluator';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns a date that is exactly N business days before `from` (Mon-Fri only, ignoring holidays) */
function businessDaysAgoFrom(businessDays: number, from: Date): Date {
  const d = new Date(from);
  let counted = 0;
  while (counted < businessDays) {
    d.setUTCDate(d.getUTCDate() - 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) counted++; // skip weekends only (ignoring holidays for simplicity)
  }
  return d;
}

function makeCase(overrides: Partial<ActiveCase> = {}): ActiveCase {
  return {
    case_id:                    'test-case-001',
    priority:                   'P3',
    status:                     'open',
    sla_start_at:               new Date().toISOString(),
    priority_last_updated_at:   null,
    priority_escalation_reason: 'initial_triage',
    ...overrides,
  };
}

// Use a fixed "now" for deterministic tests — a Wednesday so we can
// reason about business days without hitting weekend edge cases
const FIXED_NOW = new Date('2025-06-04T12:00:00Z'); // Wednesday 4 June 2025

// ---------------------------------------------------------------------------
// Business day calculator tests
// ---------------------------------------------------------------------------

describe('countBusinessDays', () => {
  it('returns 0 when from === to', () => {
    const d = new Date('2025-06-02T00:00:00Z'); // Monday
    expect(countBusinessDays(d, d)).toBe(0);
  });

  it('returns 0 when to is before from', () => {
    const from = new Date('2025-06-04T00:00:00Z');
    const to   = new Date('2025-06-02T00:00:00Z');
    expect(countBusinessDays(from, to)).toBe(0);
  });

  it('counts 1 business day from Monday to Tuesday', () => {
    const from = new Date('2025-06-02T00:00:00Z'); // Monday
    const to   = new Date('2025-06-03T00:00:00Z'); // Tuesday
    expect(countBusinessDays(from, to)).toBe(1);
  });

  it('counts 1 business day from Friday to Monday (skips weekend)', () => {
    const from = new Date('2025-05-30T00:00:00Z'); // Friday
    const to   = new Date('2025-06-02T00:00:00Z'); // Monday
    expect(countBusinessDays(from, to)).toBe(1);
  });

  it('counts 5 business days across a full week Mon→Mon', () => {
    const from = new Date('2025-06-02T00:00:00Z'); // Monday
    const to   = new Date('2025-06-09T00:00:00Z'); // next Monday
    expect(countBusinessDays(from, to)).toBe(5);
  });

  it('counts 0 for a Saturday to Sunday range', () => {
    const from = new Date('2025-05-31T00:00:00Z'); // Saturday
    const to   = new Date('2025-06-01T00:00:00Z'); // Sunday
    expect(countBusinessDays(from, to)).toBe(0);
  });

  it('does not count Philippine holidays', () => {
    // Labor Day 2025 is May 1 (Thursday)
    const from = new Date('2025-04-30T00:00:00Z'); // Wednesday
    const to   = new Date('2025-05-02T00:00:00Z'); // Friday
    // Thu May 1 is a holiday — only Friday May 2 counts
    expect(countBusinessDays(from, to)).toBe(1);
  });

  it('counts correctly over Christmas week with multiple holidays', () => {
    // Dec 24 (Wed special non-working), Dec 25 (Thu holiday), Dec 26 (Fri normal)
    // Dec 27-28 weekend, Dec 29 (Mon), Dec 30 (Tue holiday — Rizal Day), Dec 31 (Wed special)
    const from = new Date('2025-12-23T00:00:00Z'); // Tuesday
    const to   = new Date('2026-01-01T00:00:00Z'); // New Year's Day (holiday)
    // Dec 24: holiday, Dec 25: holiday, Dec 26: business day (+1)
    // Dec 29: business day (+1), Dec 30: holiday, Dec 31: holiday, Jan 1: holiday
    expect(countBusinessDays(from, to)).toBe(2);
  });
});

describe('isBusinessDay', () => {
  it('returns true for a normal weekday', () => {
    expect(isBusinessDay(new Date('2025-06-04T00:00:00Z'))).toBe(true); // Wednesday
  });

  it('returns false for Saturday', () => {
    expect(isBusinessDay(new Date('2025-05-31T00:00:00Z'))).toBe(false);
  });

  it('returns false for Sunday', () => {
    expect(isBusinessDay(new Date('2025-06-01T00:00:00Z'))).toBe(false);
  });

  it('returns false for a Philippine holiday', () => {
    expect(isBusinessDay(new Date('2025-12-25T00:00:00Z'))).toBe(false);
  });

  it('returns false for Labor Day', () => {
    expect(isBusinessDay(new Date('2025-05-01T00:00:00Z'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// computeElapsedDays — now returns business days
// ---------------------------------------------------------------------------

describe('computeElapsedDays (business days)', () => {
  it('returns 0 for a timestamp set to now', () => {
    expect(computeElapsedDays(FIXED_NOW.toISOString(), FIXED_NOW)).toBe(0);
  });

  it('returns 3 for exactly 3 weekdays ago (Mon–Wed)', () => {
    // FIXED_NOW is Wednesday Jun 4. 3 business days back = Friday May 30.
    const ref = new Date('2025-05-30T12:00:00Z'); // Friday
    // Sat Jun 31 skipped, Sun Jun 1 skipped → Mon Jun 2, Tue Jun 3, Wed Jun 4 = 3 days
    expect(computeElapsedDays(ref.toISOString(), FIXED_NOW)).toBe(3);
  });

  it('returns 1 for yesterday (Tuesday)', () => {
    const ref = new Date('2025-06-03T12:00:00Z'); // Tuesday
    expect(computeElapsedDays(ref.toISOString(), FIXED_NOW)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// selectReferenceTimestamp (unchanged from before)
// ---------------------------------------------------------------------------

describe('selectReferenceTimestamp', () => {
  it('uses sla_start_at for P3 cases always', () => {
    const c = makeCase({
      priority:                 'P3',
      sla_start_at:             '2025-01-01T00:00:00Z',
      priority_last_updated_at: '2025-01-05T00:00:00Z',
    });
    expect(selectReferenceTimestamp(c)).toBe('2025-01-01T00:00:00Z');
  });

  it('uses priority_last_updated_at for P2 when available', () => {
    const c = makeCase({
      priority:                 'P2',
      sla_start_at:             '2025-01-01T00:00:00Z',
      priority_last_updated_at: '2025-01-04T00:00:00Z',
    });
    expect(selectReferenceTimestamp(c)).toBe('2025-01-04T00:00:00Z');
  });

  it('falls back to sla_start_at for P2 when priority_last_updated_at is null', () => {
    const c = makeCase({
      priority:                 'P2',
      sla_start_at:             '2025-01-01T00:00:00Z',
      priority_last_updated_at: null,
    });
    expect(selectReferenceTimestamp(c)).toBe('2025-01-01T00:00:00Z');
  });
});

// ---------------------------------------------------------------------------
// P3 → P2 escalation (using fixed now + businessDaysAgoFrom for determinism)
// ---------------------------------------------------------------------------

describe('P3 → P2 escalation (business days)', () => {
  it('escalates P3 to P2 when 4 business days have elapsed', () => {
    const ref = businessDaysAgoFrom(4, FIXED_NOW);
    const c   = makeCase({ priority: 'P3', sla_start_at: ref.toISOString() });
    const decision = evaluateCase(c, FIXED_NOW);
    expect(decision).not.toBeNull();
    expect(decision!.outcome).toBe('p3_to_p2');
    expect(decision!.elapsed_days).toBeGreaterThanOrEqual(3);
  });

  it('does not escalate P3 when only 2 business days have elapsed', () => {
    const ref = businessDaysAgoFrom(2, FIXED_NOW);
    const c   = makeCase({ priority: 'P3', sla_start_at: ref.toISOString() });
    expect(evaluateCase(c, FIXED_NOW)).toBeNull();
  });

  it('escalates exactly at the 3-business-day boundary', () => {
    const ref = businessDaysAgoFrom(3, FIXED_NOW);
    const c   = makeCase({ priority: 'P3', sla_start_at: ref.toISOString() });
    const decision = evaluateCase(c, FIXED_NOW);
    expect(decision).not.toBeNull();
    expect(decision!.outcome).toBe('p3_to_p2');
  });
});

// ---------------------------------------------------------------------------
// P2 → P1 escalation
// ---------------------------------------------------------------------------

describe('P2 → P1 escalation (business days)', () => {
  it('escalates P2 to P1 when 8 business days have elapsed since last update', () => {
    const ref = businessDaysAgoFrom(8, FIXED_NOW);
    const c   = makeCase({
      priority:                 'P2',
      sla_start_at:             businessDaysAgoFrom(12, FIXED_NOW).toISOString(),
      priority_last_updated_at: ref.toISOString(),
    });
    const decision = evaluateCase(c, FIXED_NOW);
    expect(decision).not.toBeNull();
    expect(decision!.outcome).toBe('p2_to_p1');
    expect(decision!.elapsed_days).toBeGreaterThanOrEqual(7);
  });

  it('does not escalate P2 when only 5 business days have elapsed', () => {
    const ref = businessDaysAgoFrom(5, FIXED_NOW);
    const c   = makeCase({
      priority:                 'P2',
      priority_last_updated_at: ref.toISOString(),
    });
    expect(evaluateCase(c, FIXED_NOW)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// P1 SLA breach
// ---------------------------------------------------------------------------

describe('P1 SLA breach (business days)', () => {
  it('detects breach when 15 business days have elapsed', () => {
    const ref = businessDaysAgoFrom(15, FIXED_NOW);
    const c   = makeCase({
      priority:                 'P1',
      priority_last_updated_at: ref.toISOString(),
    });
    const decision = evaluateCase(c, FIXED_NOW);
    expect(decision).not.toBeNull();
    expect(decision!.outcome).toBe('sla_breach');
    expect(decision!.new_priority).toBe('P1');
  });

  it('does not flag breach when only 10 business days have elapsed', () => {
    const ref = businessDaysAgoFrom(10, FIXED_NOW);
    const c   = makeCase({
      priority:                 'P1',
      priority_last_updated_at: ref.toISOString(),
    });
    expect(evaluateCase(c, FIXED_NOW)).toBeNull();
  });

  it('exactly at 14-business-day boundary triggers breach', () => {
    const ref = businessDaysAgoFrom(14, FIXED_NOW);
    const c   = makeCase({
      priority:                 'P1',
      priority_last_updated_at: ref.toISOString(),
    });
    expect(evaluateCase(c, FIXED_NOW)!.outcome).toBe('sla_breach');
  });
});

// ---------------------------------------------------------------------------
// No escalation within SLA
// ---------------------------------------------------------------------------

describe('No escalation for cases within SLA', () => {
  it('returns null for a brand-new P3 case', () => {
    const c = makeCase({ priority: 'P3', sla_start_at: FIXED_NOW.toISOString() });
    expect(evaluateCase(c, FIXED_NOW)).toBeNull();
  });

  it('returns null for a P3 case with 1 business day elapsed', () => {
    const ref = businessDaysAgoFrom(1, FIXED_NOW);
    const c   = makeCase({ priority: 'P3', sla_start_at: ref.toISOString() });
    expect(evaluateCase(c, FIXED_NOW)).toBeNull();
  });

  it('returns null for P2 with 6 business days elapsed', () => {
    const ref = businessDaysAgoFrom(6, FIXED_NOW);
    const c   = makeCase({ priority: 'P2', priority_last_updated_at: ref.toISOString() });
    expect(evaluateCase(c, FIXED_NOW)).toBeNull();
  });

  it('returns null for P1 with 13 business days elapsed', () => {
    const ref = businessDaysAgoFrom(13, FIXED_NOW);
    const c   = makeCase({ priority: 'P1', priority_last_updated_at: ref.toISOString() });
    expect(evaluateCase(c, FIXED_NOW)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Batch evaluation
// ---------------------------------------------------------------------------

describe('evaluateCases batch processing', () => {
  it('correctly evaluates a mixed batch', () => {
    const now = FIXED_NOW;
    const cases: ActiveCase[] = [
      makeCase({ case_id: 'c1', priority: 'P3', sla_start_at: businessDaysAgoFrom(5, now).toISOString() }),
      makeCase({ case_id: 'c2', priority: 'P3', sla_start_at: businessDaysAgoFrom(1, now).toISOString() }),
      makeCase({ case_id: 'c3', priority: 'P2', priority_last_updated_at: businessDaysAgoFrom(8, now).toISOString() }),
      makeCase({ case_id: 'c4', priority: 'P1', priority_last_updated_at: businessDaysAgoFrom(15, now).toISOString() }),
      makeCase({ case_id: 'c5', priority: 'P1', priority_last_updated_at: businessDaysAgoFrom(3, now).toISOString() }),
    ];

    const decisions = evaluateCases(cases, now);
    expect(decisions).toHaveLength(3);

    const ids = decisions.map(d => d.case_id);
    expect(ids).toContain('c1'); // P3 → P2
    expect(ids).toContain('c3'); // P2 → P1
    expect(ids).toContain('c4'); // breach
    expect(ids).not.toContain('c2');
    expect(ids).not.toContain('c5');
  });

  it('returns empty array when no cases need action', () => {
    const now = FIXED_NOW;
    const cases: ActiveCase[] = [
      makeCase({ priority: 'P3', sla_start_at: businessDaysAgoFrom(1, now).toISOString() }),
      makeCase({ priority: 'P2', priority_last_updated_at: businessDaysAgoFrom(2, now).toISOString() }),
      makeCase({ priority: 'P1', priority_last_updated_at: businessDaysAgoFrom(5, now).toISOString() }),
    ];
    expect(evaluateCases(cases, now)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe('Idempotency via elapsed time reset', () => {
  it('does not re-escalate a case just escalated (0 business days elapsed)', () => {
    const c = makeCase({
      priority:                 'P2',
      sla_start_at:             businessDaysAgoFrom(10, FIXED_NOW).toISOString(),
      priority_last_updated_at: FIXED_NOW.toISOString(),
    });
    expect(evaluateCase(c, FIXED_NOW)).toBeNull();
  });

  it('evaluating the same cases twice returns identical decisions', () => {
    const now = FIXED_NOW;
    const cases: ActiveCase[] = [
      makeCase({ case_id: 'idem-1', priority: 'P3', sla_start_at: businessDaysAgoFrom(5, now).toISOString() }),
      makeCase({ case_id: 'idem-2', priority: 'P2', priority_last_updated_at: businessDaysAgoFrom(9, now).toISOString() }),
    ];
    expect(evaluateCases(cases, now)).toEqual(evaluateCases(cases, now));
  });
});

// ---------------------------------------------------------------------------
// escalation_reason
// ---------------------------------------------------------------------------

describe('escalation_reason is set correctly', () => {
  it('sets aging_3_business_days for P3→P2', () => {
    const ref = businessDaysAgoFrom(4, FIXED_NOW);
    const c   = makeCase({ priority: 'P3', sla_start_at: ref.toISOString() });
    expect(evaluateCase(c, FIXED_NOW)!.escalation_reason).toBe('aging_3_business_days');
  });

  it('sets aging_7_business_days for P2→P1', () => {
    const ref = businessDaysAgoFrom(8, FIXED_NOW);
    const c   = makeCase({ priority: 'P2', priority_last_updated_at: ref.toISOString() });
    expect(evaluateCase(c, FIXED_NOW)!.escalation_reason).toBe('aging_7_business_days');
  });

  it('sets sla_breach for P1 breach', () => {
    const ref = businessDaysAgoFrom(15, FIXED_NOW);
    const c   = makeCase({ priority: 'P1', priority_last_updated_at: ref.toISOString() });
    expect(evaluateCase(c, FIXED_NOW)!.escalation_reason).toBe('sla_breach');
  });
});