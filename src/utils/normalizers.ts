// ─────────────────────────────────────────────────────────────────────────────
// Normalizers
// Validates and sanitises IntentResult before it leaves the Intent Agent.
// Ensures all downstream agents receive a type-safe, logically consistent
// output regardless of how classification was performed (rule-based or LLM).
// ─────────────────────────────────────────────────────────────────────────────

import type {
  IntentResult,
  SupportedIntentType,
  IntentGroup,
  IntentFlags,
  IntentEntities,
  IssueComponent,
  CaseConsistency,
} from '../contracts/intent.contract';

import {
  ALL_VALID_INTENT_TYPES,
  INFORMATIONAL_INTENTS,
  OPERATIONAL_INTENTS,
  resolveIntentGroup,
  CONFIDENCE_THRESHOLDS,
} from '../constants/intent-taxonomy';

// ---------------------------------------------------------------------------
// Safe fallback values
// ---------------------------------------------------------------------------

const FALLBACK_INTENT_TYPE: SupportedIntentType = 'unclear_issue';
const FALLBACK_INTENT_GROUP: IntentGroup = 'out_of_scope';

const DEFAULT_FLAGS: IntentFlags = {
  ambiguous: true,
  multi_issue: false,
  hybrid: false,
  topic_switch: false,
  malicious_input: false,
};

const DEFAULT_ENTITIES: IntentEntities = {
  product: null,
  amount: null,
  date_reference: null,
  channel: null,
  reference_number: null,
  urgency_cue: null,
  reported_action: null,
};

// ---------------------------------------------------------------------------
// Individual field validators
// ---------------------------------------------------------------------------

/**
 * Returns the input if it is a valid SupportedIntentType,
 * otherwise returns the fallback.
 */
export function normalizeIntentType(
  raw: unknown,
  fallback: SupportedIntentType = FALLBACK_INTENT_TYPE
): SupportedIntentType {
  if (typeof raw === 'string' && ALL_VALID_INTENT_TYPES.has(raw as SupportedIntentType)) {
    return raw as SupportedIntentType;
  }
  return fallback;
}

/**
 * Returns a valid IntentGroup for a given SupportedIntentType.
 * Overrides the provided group if it is inconsistent with the intent type.
 */
export function normalizeIntentGroup(
  intentType: SupportedIntentType,
  providedGroup: unknown
): IntentGroup {
  const derivedGroup = resolveIntentGroup(intentType);

  if (
    typeof providedGroup === 'string' &&
    ['informational', 'operational', 'out_of_scope'].includes(providedGroup)
  ) {
    // Trust the derived group over the provided group to prevent inconsistency.
    // e.g. intent_type = 'unauthorized_transaction' must always be 'operational'
    return derivedGroup;
  }

  return derivedGroup;
}

/**
 * Clamps confidence to the [0, 1] range.
 * Falls back to 0 if the value is not a finite number.
 */
export function normalizeConfidence(raw: unknown): number {
  if (typeof raw !== 'number' || !isFinite(raw)) return 0;
  return Math.min(1, Math.max(0, raw));
}

/**
 * Filters an array of intent types, removing any unrecognised values.
 * Returns an empty array if the input is not an array.
 */
export function normalizeSecondaryIntents(raw: unknown): SupportedIntentType[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is SupportedIntentType =>
      typeof item === 'string' && ALL_VALID_INTENT_TYPES.has(item as SupportedIntentType)
  );
}

/**
 * Sanitises an entities object.
 * - Non-object inputs return the default entities shape.
 * - String fields are trimmed; null/undefined become null.
 * - amount must be a positive finite number or null.
 */
export function normalizeEntities(raw: unknown): IntentEntities {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_ENTITIES };
  }

  const obj = raw as Record<string, unknown>;

  const safeString = (v: unknown): string | null => {
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
    return null;
  };

  const safeAmount = (v: unknown): number | null => {
    if (typeof v === 'number' && isFinite(v) && v > 0) return v;
    return null;
  };

  return {
    product:          safeString(obj['product']),
    amount:           safeAmount(obj['amount']),
    date_reference:   safeString(obj['date_reference']),
    channel:          safeString(obj['channel']),
    reference_number: safeString(obj['reference_number']),
    urgency_cue:      safeString(obj['urgency_cue']),
    reported_action:  safeString(obj['reported_action']),
  };
}

/**
 * Ensures all flags are booleans.
 * Any non-boolean value becomes false.
 */
export function normalizeFlags(
  raw: unknown,
  overrides: Partial<IntentFlags> = {}
): IntentFlags {
  const safeBool = (v: unknown): boolean =>
    typeof v === 'boolean' ? v : false;

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_FLAGS, ...overrides };
  }

  const obj = raw as Record<string, unknown>;

  return {
    ambiguous:      overrides.ambiguous      ?? safeBool(obj['ambiguous']),
    multi_issue:    overrides.multi_issue    ?? safeBool(obj['multi_issue']),
    hybrid:         overrides.hybrid         ?? safeBool(obj['hybrid']),
    topic_switch:   overrides.topic_switch   ?? safeBool(obj['topic_switch']),
    malicious_input:overrides.malicious_input?? safeBool(obj['malicious_input']),
  };
}

/**
 * Validates issue_components array.
 * Each component must have a valid intent_type; invalid components are dropped.
 */
export function normalizeIssueComponents(raw: unknown): IssueComponent[] {
  if (!Array.isArray(raw)) return [];

  return raw.reduce<IssueComponent[]>((acc, item) => {
    if (item === null || typeof item !== 'object') return acc;

    const obj = item as Record<string, unknown>;
    const intentType = normalizeIntentType(obj['intent_type']);
    const intentGroup = normalizeIntentGroup(intentType, obj['intent_group']);
    const confidence = normalizeConfidence(obj['confidence']);
    const entities = normalizeEntities(obj['entities']);
    const summary =
      typeof obj['summary'] === 'string' && obj['summary'].trim().length > 0
        ? obj['summary'].trim()
        : `Concern about ${intentType.replace(/_/g, ' ')}`;

    acc.push({ intent_type: intentType, intent_group: intentGroup, confidence, entities, summary });
    return acc;
  }, []);
}

/**
 * Validates candidate_intents_for_clarification array.
 */
export function normalizeCandidateIntents(raw: unknown): SupportedIntentType[] {
  return normalizeSecondaryIntents(raw);
}

/**
 * Validates the consistency_with_active_case field.
 */
export function normalizeCaseConsistency(raw: unknown): CaseConsistency {
  const valid: CaseConsistency[] = [
    'same_case',
    'possible_topic_switch',
    'new_issue',
    'no_active_case',
  ];
  if (typeof raw === 'string' && valid.includes(raw as CaseConsistency)) {
    return raw as CaseConsistency;
  }
  return 'no_active_case';
}

// ---------------------------------------------------------------------------
// Cross-field logical consistency checks
// Applied after individual field normalisation.
// ---------------------------------------------------------------------------

/**
 * Checks for logical inconsistencies and applies corrective overrides.
 * Returns a list of correction notes added to the evidence array.
 */
function applyConsistencyRules(result: IntentResult): string[] {
  const corrections: string[] = [];

  // Rule 1: informational intent + P1 override would be invalid.
  // Informational intents must never be paired with malicious_input = true
  // (that path belongs to out_of_scope / unsupported_request).
  if (
    INFORMATIONAL_INTENTS.has(result.intent_type) &&
    result.flags.malicious_input
  ) {
    result.intent_type = 'unsupported_request';
    result.intent_group = 'out_of_scope';
    corrections.push(
      'Consistency fix: informational intent with malicious_input=true → reclassified as unsupported_request'
    );
  }

  // Rule 2: If confidence is below the ambiguous threshold, force ambiguous = true.
  if (result.confidence < CONFIDENCE_THRESHOLDS.CLARIFY && !result.flags.ambiguous) {
    result.flags.ambiguous = true;
    corrections.push(
      `Consistency fix: confidence ${result.confidence.toFixed(2)} < ${CONFIDENCE_THRESHOLDS.CLARIFY} → ambiguous forced true`
    );
  }

  // Rule 3: hybrid = true requires at least one informational AND one operational component.
  if (result.flags.hybrid) {
    const hasInfo = result.issue_components.some(c =>
      INFORMATIONAL_INTENTS.has(c.intent_type)
    );
    const hasOp = result.issue_components.some(c =>
      OPERATIONAL_INTENTS.has(c.intent_type)
    );
    if (!hasInfo || !hasOp) {
      result.flags.hybrid = false;
      corrections.push(
        'Consistency fix: hybrid=true but components do not span both groups → hybrid forced false'
      );
    }
  }

  // Rule 4: multi_issue = true requires at least 2 operational components.
  if (result.flags.multi_issue) {
    const opCount = result.issue_components.filter(c =>
      OPERATIONAL_INTENTS.has(c.intent_type)
    ).length;
    if (opCount < 2) {
      result.flags.multi_issue = false;
      corrections.push(
        `Consistency fix: multi_issue=true but only ${opCount} operational component(s) → multi_issue forced false`
      );
    }
  }

  // Rule 5: unsupported_request must always map to out_of_scope group.
  if (result.intent_type === 'unsupported_request' && result.intent_group !== 'out_of_scope') {
    result.intent_group = 'out_of_scope';
    corrections.push(
      'Consistency fix: unsupported_request must have intent_group=out_of_scope'
    );
  }

  // Rule 6: malicious_input forces unsupported_request regardless of other signals.
  if (result.flags.malicious_input && result.intent_type !== 'unsupported_request') {
    result.intent_type = 'unsupported_request';
    result.intent_group = 'out_of_scope';
    corrections.push(
      'Consistency fix: malicious_input=true → intent_type forced to unsupported_request'
    );
  }

  return corrections;
}

// ---------------------------------------------------------------------------
// Primary export: normalizeIntentResult
// ---------------------------------------------------------------------------

/**
 * Takes any object (LLM output, rule-based result, partial data) and returns
 * a fully validated, logically consistent IntentResult.
 *
 * On catastrophic failure (non-object input), returns a safe unclear_issue fallback.
 */
export function normalizeIntentResult(raw: unknown): IntentResult {
  // Catastrophic fallback — should never happen in the rule-based path
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return buildFallbackIntentResult('normalizeIntentResult received a non-object input');
  }

  const obj = raw as Record<string, unknown>;

  const intentType = normalizeIntentType(obj['intent_type']);
  const intentGroup = normalizeIntentGroup(intentType, obj['intent_group']);
  const confidence = normalizeConfidence(obj['confidence']);
  const secondaryIntents = normalizeSecondaryIntents(obj['secondary_intents']);
  const entities = normalizeEntities(obj['entities']);
  const flags = normalizeFlags(obj['flags']);
  const issueComponents = normalizeIssueComponents(obj['issue_components']);
  const candidateIntents = normalizeCandidateIntents(obj['candidate_intents_for_clarification']);
  const consistency = normalizeCaseConsistency(obj['consistency_with_active_case']);
  const evidence = Array.isArray(obj['evidence'])
    ? obj['evidence'].filter((e): e is string => typeof e === 'string')
    : [];

  const result: IntentResult = {
    intent_type: intentType,
    intent_group: intentGroup,
    confidence,
    secondary_intents: secondaryIntents,
    entities,
    flags,
    issue_components: issueComponents,
    candidate_intents_for_clarification: candidateIntents,
    consistency_with_active_case: consistency,
    evidence,
    raw_llm_output: obj['raw_llm_output'],
  };

  // Apply cross-field consistency rules and append any correction notes.
  const corrections = applyConsistencyRules(result);
  result.evidence = [...result.evidence, ...corrections];

  return result;
}

/**
 * Builds a safe IntentResult for unclear_issue.
 * Used as the ultimate fallback when classification fails entirely.
 */
export function buildFallbackIntentResult(reason: string): IntentResult {
  return {
    intent_type: FALLBACK_INTENT_TYPE,
    intent_group: FALLBACK_INTENT_GROUP,
    confidence: 0,
    secondary_intents: [],
    entities: { ...DEFAULT_ENTITIES },
    flags: { ...DEFAULT_FLAGS, ambiguous: true },
    issue_components: [],
    candidate_intents_for_clarification: [],
    consistency_with_active_case: 'no_active_case',
    evidence: [`Fallback applied: ${reason}`],
  };
}