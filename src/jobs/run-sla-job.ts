// ─────────────────────────────────────────────────────────────────────────────
// SLA Job Runner — Slice 6
// Orchestrates the full SLA evaluation cycle.
//
// Usage:
//   npm run sla-job
//   npx ts-node src/jobs/run-sla-job.ts
//
// This script:
//   1. Fetches all active cases
//   2. Evaluates each case against SLA thresholds
//   3. Applies DB updates (priority, reason, timestamp)
//   4. Logs a case_action record for every escalation
//   5. Prints a summary
// ─────────────────────────────────────────────────────────────────────────────

import dotenv from 'dotenv';
dotenv.config();

import { serviceClient }             from '../config/supabase';
import { getActiveCases, evaluateCases } from './sla-evaluator';
import type { EscalationDecision }   from './sla-evaluator';
import { v4 as uuidv4 }              from 'uuid';

// ---------------------------------------------------------------------------
// DB write: update case priority
// ---------------------------------------------------------------------------

async function updateCasePriority(decision: EscalationDecision): Promise<void> {
  const now = new Date().toISOString();

  const { error } = await serviceClient
    .from('cases')
    .update({
      priority:                   decision.new_priority,
      priority_last_updated_at:   now,
      priority_escalation_reason: decision.escalation_reason,
      // Escalated cases should reflect the new status
      status:                     decision.new_priority === 'P1' ? 'escalated' : undefined,
      updated_at:                 now,
    })
    .eq('case_id', decision.case_id);

  if (error) {
    throw new Error(
      `[SLA Job] Failed to update priority for case ${decision.case_id}: ${error.message}`
    );
  }
}

// ---------------------------------------------------------------------------
// DB write: insert case_action record
// ---------------------------------------------------------------------------

async function insertCaseAction(decision: EscalationDecision): Promise<void> {
  const actionType = decision.outcome === 'sla_breach'
    ? 'sla_breach_detected'
    : 'priority_escalated';

  const { error } = await serviceClient
    .from('case_actions')
    .insert({
      action_id:     uuidv4(),
      case_id:       decision.case_id,
      ticket_id:     null,
      action_type:   actionType,
      action_status: 'completed',
      actor_type:    'system',
      actor_name:    'sla_job',
      notes:         `SLA evaluation: ${decision.outcome}. Elapsed: ${decision.elapsed_days.toFixed(2)} days.`,
      metadata_json: {
        old_priority:  decision.old_priority,
        new_priority:  decision.new_priority,
        elapsed_days:  parseFloat(decision.elapsed_days.toFixed(4)),
        outcome:       decision.outcome,
      },
      created_at: new Date().toISOString(),
    });

  if (error) {
    throw new Error(
      `[SLA Job] Failed to insert case_action for case ${decision.case_id}: ${error.message}`
    );
  }
}

// ---------------------------------------------------------------------------
// Idempotency guard
// Check whether a sla_breach action was already logged today for a P1 breach
// to prevent duplicate breach records on repeated daily runs.
// For priority escalations (P3→P2, P2→P1), idempotency is naturally enforced
// by elapsed time: once a case is escalated, priority_last_updated_at resets,
// so the clock starts over and the threshold won't be crossed again until
// the next SLA window elapses.
// ---------------------------------------------------------------------------

async function slaBreachAlreadyLoggedToday(caseId: string): Promise<boolean> {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const { data, error } = await serviceClient
    .from('case_actions')
    .select('action_id')
    .eq('case_id', caseId)
    .eq('action_type', 'sla_breach_detected')
    .gte('created_at', todayStart.toISOString())
    .limit(1)
    .maybeSingle();

  if (error) {
    console.warn(`[SLA Job] Could not check idempotency for case ${caseId}: ${error.message}`);
    return false;
  }
  return data !== null;
}

// ---------------------------------------------------------------------------
// Main job
// ---------------------------------------------------------------------------

async function runSLAJob(): Promise<void> {
  console.log('[SLA JOB] Starting SLA evaluation...');

  const startTime = Date.now();
  let scanned  = 0;
  let escalated = 0;
  let breaches  = 0;
  const errors: string[] = [];

  // Step 1: Fetch eligible cases
  let cases;
  try {
    cases = await getActiveCases();
  } catch (err) {
    console.error('[SLA JOB] Fatal: could not fetch cases.', err instanceof Error ? err.message : err);
    process.exit(1);
  }

  scanned = cases.length;
  console.log(`[SLA JOB] Fetched ${scanned} active case(s).`);

  // Step 2: Evaluate all cases
  const decisions = evaluateCases(cases);
  console.log(`[SLA JOB] ${decisions.length} case(s) require action.`);

  // Step 3: Apply decisions
  for (const decision of decisions) {
    try {
      // Idempotency guard for P1 breaches
      if (decision.outcome === 'sla_breach') {
        const alreadyLogged = await slaBreachAlreadyLoggedToday(decision.case_id);
        if (alreadyLogged) {
          console.log(`[SLA JOB] Skipping duplicate breach for case ${decision.case_id} (already logged today)`);
          continue;
        }
        breaches++;
      } else {
        escalated++;
      }

      // Apply priority update (for breaches, this is a no-op on priority
      // but still updates priority_escalation_reason)
      await updateCasePriority(decision);

      // Log the action
      await insertCaseAction(decision);

      const label = decision.outcome === 'sla_breach'
        ? `BREACH (P1 at ${decision.elapsed_days.toFixed(1)} days)`
        : `${decision.old_priority} → ${decision.new_priority} (${decision.elapsed_days.toFixed(1)} days)`;

      console.log(`[SLA JOB] Case ${decision.case_id}: ${label}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Case ${decision.case_id}: ${msg}`);
      console.error(`[SLA JOB] Error processing case ${decision.case_id}:`, msg);
    }
  }

  // Step 4: Summary
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log('');
  console.log(`[SLA JOB] scanned: ${scanned}`);
  console.log(`[SLA JOB] escalated: ${escalated}`);
  console.log(`[SLA JOB] breaches: ${breaches}`);
  if (errors.length > 0) {
    console.log(`[SLA JOB] errors: ${errors.length}`);
    errors.forEach(e => console.error(`  → ${e}`));
  }
  console.log(`[SLA JOB] Done in ${elapsed}s`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

runSLAJob().catch(err => {
  console.error('[SLA JOB] Unhandled error:', err);
  process.exit(1);
});