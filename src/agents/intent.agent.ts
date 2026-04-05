// ─────────────────────────────────────────────────────────────────────────────
// Intent Agent — Rule-Based Implementation (Phase 2, Slice 1 + Slice 2)
// Slice 2 addition: clarification context bias
// ─────────────────────────────────────────────────────────────────────────────

import type {
  IntentResult,
  IntentEntities,
  IntentFlags,
  SupportedIntentType,
  CaseConsistency,
} from '../contracts/intent.contract';

import type { ActiveCaseContext, RecentMessage } from '../contracts/orchestration.contract';

import {
  INFORMATIONAL_KEYWORD_RULES,
  OPERATIONAL_KEYWORD_RULES,
  AMBIGUOUS_SIGNAL_PHRASES,
  AMBIGUOUS_STANDALONE_PATTERNS,
  CLARIFICATION_CANDIDATE_INTENTS,
  CONFIDENCE_THRESHOLDS,
  INFORMATIONAL_INTENTS,
  OPERATIONAL_INTENTS,
  resolveIntentGroup,
  KeywordRule,
} from '../constants/intent-taxonomy';

import {
  PROMPT_INJECTION_SUBSTRINGS,
  PROMPT_INJECTION_PATTERNS,
  OUT_OF_SCOPE_SUBSTRINGS,
  DATA_EXFILTRATION_SUBSTRINGS,
  MaliciousSignal,
} from '../constants/malicious-patterns';

import {
  normalizeIntentResult,
  buildFallbackIntentResult,
  normalizeEntities,
} from '../utils/normalizers';

// ---------------------------------------------------------------------------
// Input type
// ---------------------------------------------------------------------------

export interface ClarificationContext {
  /** The clarification question that was asked */
  question: string;
  /** The candidate intents being disambiguated */
  candidateIntents: SupportedIntentType[];
  /** How many clarification turns have occurred so far */
  turnCount: number;
}

export interface IntentAgentInput {
  userMessage: string;
  recentMessages: RecentMessage[];
  activeCase: ActiveCaseContext | null;
  /** Populated when the previous assistant turn was a clarification question */
  clarificationContext?: ClarificationContext | null;
}

// ---------------------------------------------------------------------------
// Step 1: Malicious pattern detection
// ---------------------------------------------------------------------------

function detectMaliciousSignal(normalizedText: string): MaliciousSignal {
  for (const phrase of DATA_EXFILTRATION_SUBSTRINGS) {
    if (normalizedText.includes(phrase)) {
      return { detected: true, signal_type: 'data_exfiltration', matched_indicator: phrase };
    }
  }
  for (const phrase of PROMPT_INJECTION_SUBSTRINGS) {
    if (normalizedText.includes(phrase)) {
      return { detected: true, signal_type: 'prompt_injection', matched_indicator: phrase };
    }
  }
  for (const pattern of PROMPT_INJECTION_PATTERNS) {
    const match = pattern.exec(normalizedText);
    if (match) {
      return { detected: true, signal_type: 'prompt_injection', matched_indicator: pattern.toString() };
    }
  }
  return { detected: false, signal_type: null, matched_indicator: null };
}

// ---------------------------------------------------------------------------
// Step 2: Out-of-scope detection
// ---------------------------------------------------------------------------

function detectOutOfScope(normalizedText: string): { detected: boolean; indicator: string | null } {
  for (const phrase of OUT_OF_SCOPE_SUBSTRINGS) {
    if (normalizedText.includes(phrase)) return { detected: true, indicator: phrase };
  }
  return { detected: false, indicator: null };
}

// ---------------------------------------------------------------------------
// Step 3: Ambiguity detection
// ---------------------------------------------------------------------------

function detectAmbiguous(normalizedText: string): boolean {
  for (const pattern of AMBIGUOUS_STANDALONE_PATTERNS) {
    if (pattern.test(normalizedText)) return true;
  }
  return false;
}

function applyAmbiguityPenalty(baseConfidence: number, normalizedText: string): number {
  const matchedVague = AMBIGUOUS_SIGNAL_PHRASES.filter(phrase =>
    normalizedText.includes(phrase)
  );
  if (matchedVague.length === 0) return baseConfidence;
  const penalty = Math.min(0.20, matchedVague.length * 0.05);
  return Math.max(0, baseConfidence - penalty);
}

// ---------------------------------------------------------------------------
// Step 4: Keyword classification
// ---------------------------------------------------------------------------

interface ClassificationMatch {
  intent: SupportedIntentType;
  confidence: number;
  evidence: string;
}

function expandContractions(text: string): string {
  return text
    .replace(/hasn't/g, 'has not')
    .replace(/haven't/g, 'have not')
    .replace(/didn't/g, 'did not')
    .replace(/don't/g, 'do not')
    .replace(/doesn't/g, 'does not')
    .replace(/can't/g, 'cannot')
    .replace(/won't/g, 'will not')
    .replace(/isn't/g, 'is not')
    .replace(/wasn't/g, 'was not')
    .replace(/weren't/g, 'were not')
    .replace(/i've/g, 'i have')
    .replace(/i'm/g, 'i am')
    .replace(/i'd/g, 'i did');
}

function runKeywordClassification(
  normalizedText: string,
  rules: KeywordRule[]
): ClassificationMatch | null {
  let bestMatch: ClassificationMatch | null = null;

  const expanded = expandContractions(normalizedText);

  for (const rule of rules) {
    const matchedKeywords = rule.keywords.filter(
      kw => normalizedText.includes(kw) || expanded.includes(kw)
    );
    if (matchedKeywords.length === 0) continue;

    const bonus = Math.min(0.05, (matchedKeywords.length - 1) * 0.015);
    const confidence = Math.min(1, rule.baseConfidence + bonus);

    if (!bestMatch || confidence > bestMatch.confidence) {
      bestMatch = {
        intent: rule.intent,
        confidence,
        evidence: `Matched ${matchedKeywords.length} keyword(s): "${matchedKeywords.slice(0, 3).join('", "')}"`,
      };
    }
  }
  return bestMatch;
}

// ---------------------------------------------------------------------------
// Step 5: Entity extraction
// ---------------------------------------------------------------------------

function extractEntities(rawMessage: string): IntentEntities {
  const entities: IntentEntities = {
    product: null, amount: null, date_reference: null,
    channel: null, reference_number: null, urgency_cue: null, reported_action: null,
  };
  const lower = rawMessage.toLowerCase();

  const amountMatch = rawMessage.match(
    /(?:php|usd|p|₱)?\s*([\d,]+(?:\.\d{1,2})?)\s*(?:php|usd|pesos?|dollars?)?/i
  );
  if (amountMatch) {
    const parsed = parseFloat(amountMatch[1].replace(/,/g, ''));
    if (isFinite(parsed) && parsed > 0) entities.amount = parsed;
  }

  const refMatch = rawMessage.match(/\b([A-Z0-9]{6,20})\b/);
  if (refMatch) entities.reference_number = refMatch[1];

  const datePatterns = [
    /yesterday/i, /last (monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i,
    /last week/i, /\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?/,
    /january|february|march|april|may|june|july|august|september|october|november|december/i,
    /today|this morning|this afternoon|this evening|earlier today/i,
  ];
  for (const pattern of datePatterns) {
    const match = rawMessage.match(pattern);
    if (match) { entities.date_reference = match[0]; break; }
  }

  if (lower.includes('mobile app') || lower.includes('app'))        entities.channel = 'mobile_app';
  else if (lower.includes('atm'))                                    entities.channel = 'atm';
  else if (lower.includes('online banking'))                         entities.channel = 'online_banking';
  else if (lower.includes('branch') || lower.includes('teller'))    entities.channel = 'branch';
  else if (lower.includes('pos') || lower.includes('point of sale')) entities.channel = 'pos';

  if (lower.includes('credit card'))         entities.product = 'credit_card';
  else if (lower.includes('debit card'))     entities.product = 'debit_card';
  else if (lower.includes('savings account'))entities.product = 'savings_account';
  else if (lower.includes('checking account') || lower.includes('current account'))
                                             entities.product = 'checking_account';
  else if (lower.includes('loan'))           entities.product = 'loan';
  else if (lower.includes('time deposit') || lower.includes('td'))
                                             entities.product = 'time_deposit';

  const urgencyCues = ['urgent', 'emergency', 'immediately', 'asap', 'right now',
                       'critical', 'important', 'as soon as possible'];
  const matchedCue = urgencyCues.find(cue => lower.includes(cue));
  if (matchedCue) entities.urgency_cue = matchedCue;

  const actionPatterns: Array<[RegExp, string]> = [
    [/i (did not|didn't) (make|authorize|do)/i, 'denied_action'],
    [/someone (used|took|withdrew|transferred)/i, 'third_party_action'],
    [/i (transferred|sent|paid|withdrew)/i, 'customer_initiated_action'],
  ];
  for (const [pattern, label] of actionPatterns) {
    if (pattern.test(rawMessage)) { entities.reported_action = label; break; }
  }

  return normalizeEntities(entities);
}

// ---------------------------------------------------------------------------
// Step 6: Case consistency
// ---------------------------------------------------------------------------

function resolveConsistency(
  intentType: SupportedIntentType,
  activeCase: ActiveCaseContext | null
): CaseConsistency {
  if (!activeCase) return 'no_active_case';
  if (activeCase.primary_intent_type === intentType) return 'same_case';
  if (intentType === 'complaint_follow_up') return 'same_case';
  if (intentType === 'general_complaint') return 'possible_topic_switch';
  return 'new_issue';
}

// ---------------------------------------------------------------------------
// Step 7: Flag computation
// ---------------------------------------------------------------------------

function buildFlags(options: {
  malicious: boolean;
  ambiguous: boolean;
  confidence: number;
  consistency: CaseConsistency;
}): IntentFlags {
  return {
    ambiguous: options.ambiguous || options.confidence < CONFIDENCE_THRESHOLDS.CLARIFY,
    multi_issue: false,
    hybrid: false,
    topic_switch: options.consistency === 'new_issue' || options.consistency === 'possible_topic_switch',
    malicious_input: options.malicious,
  };
}

// ---------------------------------------------------------------------------
// Clarification context bias
// Slice 2: when we are already in a clarification loop, boost candidate intents
// that appear in the user's follow-up response.
// ---------------------------------------------------------------------------

function applyClarificationBias(
  bestMatch: ClassificationMatch | null,
  clarificationCtx: ClarificationContext,
  normalizedText: string,
  evidence: string[]
): ClassificationMatch | null {
  if (!bestMatch) {
    // No keyword match — try to match against candidate intents by scanning
    // for any keyword rules that belong to the candidate set.
    const candidateRules = [
      ...OPERATIONAL_KEYWORD_RULES,
      ...INFORMATIONAL_KEYWORD_RULES,
    ].filter(rule => clarificationCtx.candidateIntents.includes(rule.intent));

    const biasedMatch = runKeywordClassification(normalizedText, candidateRules);
    if (biasedMatch) {
      // Boost confidence slightly since we are in a clarification context
      const boosted = Math.min(1, biasedMatch.confidence + 0.05);
      evidence.push(
        `Clarification bias applied: matched candidate intent "${biasedMatch.intent}" ` +
        `(${biasedMatch.confidence.toFixed(2)} → ${boosted.toFixed(2)})`
      );
      return { ...biasedMatch, confidence: boosted };
    }
    evidence.push('Clarification bias: no candidate intent matched in follow-up');
    return null;
  }

  // There is already a match — boost it if it is one of the candidate intents
  if (clarificationCtx.candidateIntents.includes(bestMatch.intent)) {
    const boosted = Math.min(1, bestMatch.confidence + 0.05);
    evidence.push(
      `Clarification bias: existing match "${bestMatch.intent}" is a candidate — ` +
      `confidence boosted ${bestMatch.confidence.toFixed(2)} → ${boosted.toFixed(2)}`
    );
    return { ...bestMatch, confidence: boosted };
  }

  return bestMatch;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function buildIssueSummary(
  intentType: SupportedIntentType,
  entities: IntentEntities
): string {
  const product = entities.product ? ` related to ${entities.product.replace(/_/g, ' ')}` : '';
  const amount = entities.amount != null ? ` for ${entities.amount}` : '';

  const summaryMap: Partial<Record<SupportedIntentType, string>> = {
    unauthorized_transaction:          `Unauthorized or unrecognized transaction reported${amount}${product}.`,
    lost_or_stolen_card:               `Lost or stolen card reported${product}.`,
    failed_or_delayed_transfer:        `Failed or delayed transfer reported${amount}.`,
    refund_or_reversal_issue:          `Refund or reversal issue reported${amount}.`,
    account_access_issue:              `Customer cannot access their account${product}.`,
    account_restriction_issue:         `Account restriction or block reported${product}.`,
    billing_or_fee_dispute:            `Billing error or fee dispute reported${amount}.`,
    complaint_follow_up:               `Customer is following up on an existing complaint.`,
    service_quality_complaint:         `Customer complaint about service quality.`,
    document_or_certification_request:`Request for bank document or certificate${product}.`,
    product_info:                      `Customer is asking about product information${product}.`,
    requirements_inquiry:              `Customer is asking about requirements${product}.`,
    policy_or_process_inquiry:         `Customer is asking about a policy or process.`,
    fee_or_rate_inquiry:               `Customer is asking about fees or interest rates${product}.`,
    branch_or_service_info:            `Customer is asking about branch or service information.`,
  };
  return summaryMap[intentType] ?? `Customer inquiry: ${intentType.replace(/_/g, ' ')}.`;
}

export async function classifyIntent(input: IntentAgentInput): Promise<IntentResult> {
  const { userMessage, recentMessages, activeCase, clarificationContext } = input;

  if (!userMessage || userMessage.trim().length === 0) {
    return buildFallbackIntentResult('Empty or whitespace-only user message');
  }

  const normalizedText = userMessage.toLowerCase().trim();
  const evidence: string[] = [];

  // ── Step 1: Malicious detection ───────────────────────────────────────────
  const maliciousSignal = detectMaliciousSignal(normalizedText);
  if (maliciousSignal.detected) {
    evidence.push(`Malicious signal detected (${maliciousSignal.signal_type}): "${maliciousSignal.matched_indicator}"`);
    return normalizeIntentResult({
      intent_type: 'unsupported_request', intent_group: 'out_of_scope',
      confidence: 1.0, secondary_intents: [], entities: extractEntities(userMessage),
      flags: { ambiguous: false, multi_issue: false, hybrid: false, topic_switch: false, malicious_input: true },
      issue_components: [], candidate_intents_for_clarification: [],
      consistency_with_active_case: activeCase ? 'same_case' : 'no_active_case',
      evidence,
    });
  }

  // ── Step 2: Out-of-scope detection ────────────────────────────────────────
  const outOfScope = detectOutOfScope(normalizedText);
  if (outOfScope.detected) {
    evidence.push(`Out-of-scope indicator: "${outOfScope.indicator}"`);
    return normalizeIntentResult({
      intent_type: 'unsupported_request', intent_group: 'out_of_scope',
      confidence: 0.95, secondary_intents: [], entities: extractEntities(userMessage),
      flags: { ambiguous: false, multi_issue: false, hybrid: false, topic_switch: false, malicious_input: false },
      issue_components: [], candidate_intents_for_clarification: [],
      consistency_with_active_case: activeCase ? 'same_case' : 'no_active_case',
      evidence,
    });
  }

  // ── Step 3: Standalone ambiguity check ────────────────────────────────────
  const isStandaloneAmbiguous = detectAmbiguous(normalizedText);
  if (isStandaloneAmbiguous) evidence.push('Standalone ambiguous message pattern matched');

  // ── Steps 4 & 5: Keyword classification ──────────────────────────────────
  let operationalMatch = runKeywordClassification(normalizedText, OPERATIONAL_KEYWORD_RULES);
  let informationalMatch = runKeywordClassification(normalizedText, INFORMATIONAL_KEYWORD_RULES);

  let bestMatch: ClassificationMatch | null = null;
  if (operationalMatch && informationalMatch) {
    bestMatch = operationalMatch.confidence >= informationalMatch.confidence
      ? operationalMatch : informationalMatch;
    evidence.push(`Both operational (${operationalMatch.confidence.toFixed(2)}) and informational (${informationalMatch.confidence.toFixed(2)}) matches; selected higher.`);
  } else if (operationalMatch) {
    bestMatch = operationalMatch;
    evidence.push(`Operational match: ${operationalMatch.intent} (${operationalMatch.confidence.toFixed(2)})`);
    evidence.push(operationalMatch.evidence);
  } else if (informationalMatch) {
    bestMatch = informationalMatch;
    evidence.push(`Informational match: ${informationalMatch.intent} (${informationalMatch.confidence.toFixed(2)})`);
    evidence.push(informationalMatch.evidence);
  }

  // ── Slice 2: Apply clarification bias if in a clarification loop ──────────
  if (clarificationContext) {
    evidence.push(
      `In clarification loop (turn ${clarificationContext.turnCount}): ` +
      `candidates=[${clarificationContext.candidateIntents.join(', ')}]`
    );
    bestMatch = applyClarificationBias(bestMatch, clarificationContext, normalizedText, evidence);
  }

  // ── Step 6: Ambiguity penalty ─────────────────────────────────────────────
  let finalConfidence = bestMatch
    ? applyAmbiguityPenalty(bestMatch.confidence, normalizedText)
    : 0;

  if (bestMatch && finalConfidence !== bestMatch.confidence) {
    evidence.push(`Confidence adjusted by ambiguity penalty: ${bestMatch.confidence.toFixed(2)} → ${finalConfidence.toFixed(2)}`);
  }

  // ── Step 7: Fallback to unclear_issue ─────────────────────────────────────
  let intentType: SupportedIntentType;
  if (!bestMatch || finalConfidence < CONFIDENCE_THRESHOLDS.AMBIGUOUS || isStandaloneAmbiguous) {
    intentType = 'unclear_issue';
    finalConfidence = isStandaloneAmbiguous ? 0.40 : (bestMatch ? finalConfidence : 0);
    evidence.push(
      bestMatch
        ? `Below ambiguous threshold (${finalConfidence.toFixed(2)} < ${CONFIDENCE_THRESHOLDS.CLARIFY}) → unclear_issue`
        : 'No keyword match found → unclear_issue'
    );
  } else {
    intentType = bestMatch.intent;
  }

  // ── Step 8: Entity extraction ─────────────────────────────────────────────
  const entities = extractEntities(userMessage);

  // ── Step 9: Derived fields ────────────────────────────────────────────────
  const resolvedGroup = resolveIntentGroup(intentType);
  const consistency = resolveConsistency(intentType, activeCase);
  const isAmbiguous = isStandaloneAmbiguous || finalConfidence < CONFIDENCE_THRESHOLDS.CLARIFY;

  const flags = buildFlags({
    malicious: false,
    ambiguous: isAmbiguous,
    confidence: finalConfidence,
    consistency,
  });

  const candidateIntents: SupportedIntentType[] = isAmbiguous
    ? (clarificationContext?.candidateIntents ?? CLARIFICATION_CANDIDATE_INTENTS)
    : [];

  const issueComponents = intentType !== 'unclear_issue' && intentType !== 'unsupported_request'
    ? [{ intent_type: intentType, intent_group: resolvedGroup, confidence: finalConfidence, entities, summary: buildIssueSummary(intentType, entities) }]
    : [];

  return normalizeIntentResult({
    intent_type: intentType, intent_group: resolvedGroup, confidence: finalConfidence,
    secondary_intents: [], entities, flags, issue_components: issueComponents,
    candidate_intents_for_clarification: candidateIntents,
    consistency_with_active_case: consistency, evidence,
  });
}