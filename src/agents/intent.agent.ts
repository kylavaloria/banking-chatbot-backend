// ─────────────────────────────────────────────────────────────────────────────
// Intent Agent — Slice 1 + Slice 2 + Slice 3
// Slice 3 additions:
//   - detectMultiIssue: populates issue_components for 2+ operational concerns
//   - detectHybrid: identifies mixed informational + operational messages
//   - topic_switch: strengthened consistency check
// ─────────────────────────────────────────────────────────────────────────────

import type {
  IntentResult,
  IntentEntities,
  IntentFlags,
  SupportedIntentType,
  CaseConsistency,
  IssueComponent,
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
  MULTI_ISSUE_PAIRS,
  MULTI_ISSUE_CONJUNCTION_PHRASES,
  HYBRID_INFORMATIONAL_SIGNALS,
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
// Types
// ---------------------------------------------------------------------------

export interface ClarificationContext {
  question:         string;
  candidateIntents: SupportedIntentType[];
  turnCount:        number;
}

export interface IntentAgentInput {
  userMessage:           string;
  recentMessages:        RecentMessage[];
  activeCase:            ActiveCaseContext | null;
  clarificationContext?: ClarificationContext | null;
}

interface ClassificationMatch {
  intent:     SupportedIntentType;
  confidence: number;
  evidence:   string;
}

// ---------------------------------------------------------------------------
// Security detection (unchanged from Slice 2)
// ---------------------------------------------------------------------------

function detectMaliciousSignal(normalizedText: string): MaliciousSignal {
  for (const phrase of DATA_EXFILTRATION_SUBSTRINGS) {
    if (normalizedText.includes(phrase)) return { detected: true, signal_type: 'data_exfiltration', matched_indicator: phrase };
  }
  for (const phrase of PROMPT_INJECTION_SUBSTRINGS) {
    if (normalizedText.includes(phrase)) return { detected: true, signal_type: 'prompt_injection', matched_indicator: phrase };
  }
  for (const pattern of PROMPT_INJECTION_PATTERNS) {
    const match = pattern.exec(normalizedText);
    if (match) return { detected: true, signal_type: 'prompt_injection', matched_indicator: pattern.toString() };
  }
  return { detected: false, signal_type: null, matched_indicator: null };
}

function detectOutOfScope(normalizedText: string): { detected: boolean; indicator: string | null } {
  for (const phrase of OUT_OF_SCOPE_SUBSTRINGS) {
    if (normalizedText.includes(phrase)) return { detected: true, indicator: phrase };
  }
  return { detected: false, indicator: null };
}

function detectAmbiguous(normalizedText: string): boolean {
  return AMBIGUOUS_STANDALONE_PATTERNS.some(p => p.test(normalizedText));
}

function applyAmbiguityPenalty(baseConfidence: number, normalizedText: string): number {
  const matched = AMBIGUOUS_SIGNAL_PHRASES.filter(p => normalizedText.includes(p));
  if (matched.length === 0) return baseConfidence;
  return Math.max(0, baseConfidence - Math.min(0.20, matched.length * 0.05));
}

// ---------------------------------------------------------------------------
// Keyword classification (unchanged from Slice 2)
// ---------------------------------------------------------------------------

function expandContractions(text: string): string {
  return text
    .replace(/hasn't/g,  'has not')
    .replace(/haven't/g, 'have not')
    .replace(/didn't/g,  'did not')
    .replace(/don't/g,   'do not')
    .replace(/doesn't/g, 'does not')
    .replace(/can't/g,   'cannot')
    .replace(/won't/g,   'will not')
    .replace(/isn't/g,   'is not')
    .replace(/wasn't/g,  'was not')
    .replace(/weren't/g, 'were not')
    .replace(/i've/g,    'i have')
    .replace(/i'm/g,     'i am')
    .replace(/i'd/g,     'i did');
}

function runKeywordClassification(
  normalizedText: string,
  rules: KeywordRule[]
): ClassificationMatch | null {
  const expanded = expandContractions(normalizedText);
  let bestMatch: ClassificationMatch | null = null;

  for (const rule of rules) {
    const matched = rule.keywords.filter(
      kw => normalizedText.includes(kw) || expanded.includes(kw)
    );
    if (matched.length === 0) continue;
    const bonus = Math.min(0.05, (matched.length - 1) * 0.015);
    const confidence = Math.min(1, rule.baseConfidence + bonus);
    if (!bestMatch || confidence > bestMatch.confidence) {
      bestMatch = {
        intent:     rule.intent,
        confidence,
        evidence:   `Matched ${matched.length} keyword(s): "${matched.slice(0, 3).join('", "')}"`,
      };
    }
  }
  return bestMatch;
}

/**
 * Runs all operational keyword rules against a text and returns ALL matches
 * above the given threshold, not just the best one.
 * Used for multi-issue and hybrid detection.
 */
function runAllOperationalMatches(
  normalizedText: string,
  minConfidence = CONFIDENCE_THRESHOLDS.CLARIFY
): ClassificationMatch[] {
  const expanded = expandContractions(normalizedText);
  const results: ClassificationMatch[] = [];
  const seen = new Set<SupportedIntentType>();

  for (const rule of OPERATIONAL_KEYWORD_RULES) {
    if (seen.has(rule.intent)) continue;
    const matched = rule.keywords.filter(
      kw => normalizedText.includes(kw) || expanded.includes(kw)
    );
    if (matched.length === 0) continue;
    const bonus = Math.min(0.05, (matched.length - 1) * 0.015);
    const confidence = Math.min(1, rule.baseConfidence + bonus);
    if (confidence >= minConfidence) {
      results.push({ intent: rule.intent, confidence, evidence: `Matched: "${matched.slice(0, 2).join('", "')}"` });
      seen.add(rule.intent);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Slice 3: Multi-issue detection
// Conservative: requires a known co-occurrence pair AND a conjunction phrase
// OR two independent high-confidence matches from distinct intent categories.
// ---------------------------------------------------------------------------

interface MultiIssueDetection {
  detected:        boolean;
  components:      Array<{ intent: SupportedIntentType; confidence: number; evidence: string }>;
  evidence:        string[];
}

function detectMultiIssue(
  normalizedText: string,
  allMatches: ClassificationMatch[]
): MultiIssueDetection {
  if (allMatches.length < 2) {
    return { detected: false, components: [], evidence: ['Fewer than 2 operational matches — no multi-issue'] };
  }

  const evidence: string[] = [];

  // Check if any known pair is present
  const matchedIntents = new Set(allMatches.map(m => m.intent));
  let pairFound = false;

  for (const [a, b] of MULTI_ISSUE_PAIRS) {
    if (matchedIntents.has(a) && matchedIntents.has(b)) {
      pairFound = true;
      evidence.push(`Known multi-issue pair detected: [${a}, ${b}]`);
      break;
    }
  }

  // Check for conjunction phrase
  const conjunctionFound = MULTI_ISSUE_CONJUNCTION_PHRASES.some(p => normalizedText.includes(p));
  if (conjunctionFound) evidence.push('Conjunction phrase detected (signals multiple issues)');

  // Split decision: require pair OR (two high-confidence matches + conjunction)
  const highConfidenceMatches = allMatches.filter(m => m.confidence >= CONFIDENCE_THRESHOLDS.ACCEPT);
  const splitByConjunction = conjunctionFound && highConfidenceMatches.length >= 2;

  if (!pairFound && !splitByConjunction) {
    evidence.push('No known pair and no conjunction with 2 high-confidence matches — not splitting');
    return { detected: false, components: [], evidence };
  }

  // Collect the two strongest distinct matches
  const top2 = allMatches
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 2);

  evidence.push(`Splitting into ${top2.length} components: ${top2.map(m => m.intent).join(', ')}`);
  return {
    detected:   true,
    components: top2,
    evidence,
  };
}

// ---------------------------------------------------------------------------
// Slice 3: Hybrid detection
// Requires one informational signal AND one operational match above threshold.
// ---------------------------------------------------------------------------

interface HybridDetection {
  detected:              boolean;
  informationalSignal:   string | null;
  operationalMatch:      ClassificationMatch | null;
  evidence:              string[];
}

function detectHybrid(
  normalizedText: string,
  bestOperationalMatch: ClassificationMatch | null
): HybridDetection {
  const evidence: string[] = [];

  if (!bestOperationalMatch || bestOperationalMatch.confidence < CONFIDENCE_THRESHOLDS.ACCEPT) {
    return { detected: false, informationalSignal: null, operationalMatch: null, evidence: ['No high-confidence operational match for hybrid check'] };
  }

  const infoSignal = HYBRID_INFORMATIONAL_SIGNALS.find(s => normalizedText.includes(s));
  if (!infoSignal) {
    return { detected: false, informationalSignal: null, operationalMatch: null, evidence: ['No informational signal found'] };
  }

  // Verify the informational signal also matches a known informational keyword rule
  const infoMatch = runKeywordClassification(normalizedText, INFORMATIONAL_KEYWORD_RULES);
  if (!infoMatch || infoMatch.confidence < CONFIDENCE_THRESHOLDS.CLARIFY) {
    evidence.push(`Informational signal "${infoSignal}" found but no strong informational rule match`);
    return { detected: false, informationalSignal: null, operationalMatch: null, evidence };
  }

  evidence.push(`Hybrid detected: informational="${infoMatch.intent}" + operational="${bestOperationalMatch.intent}"`);
  return {
    detected:            true,
    informationalSignal: infoSignal,
    operationalMatch:    bestOperationalMatch,
    evidence,
  };
}

// ---------------------------------------------------------------------------
// Entity extraction (unchanged from Slice 2)
// ---------------------------------------------------------------------------

function extractEntities(rawMessage: string): IntentEntities {
  const entities: IntentEntities = {
    product: null, amount: null, date_reference: null,
    channel: null, reference_number: null, urgency_cue: null, reported_action: null,
  };
  const lower = rawMessage.toLowerCase();

  const amountMatch = rawMessage.match(/(?:php|usd|p|₱)?\s*([\d,]+(?:\.\d{1,2})?)\s*(?:php|usd|pesos?|dollars?)?/i);
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
  for (const p of datePatterns) {
    const m = rawMessage.match(p);
    if (m) { entities.date_reference = m[0]; break; }
  }

  if (lower.includes('mobile app') || lower.includes('app'))         entities.channel = 'mobile_app';
  else if (lower.includes('atm'))                                     entities.channel = 'atm';
  else if (lower.includes('online banking'))                          entities.channel = 'online_banking';
  else if (lower.includes('branch') || lower.includes('teller'))     entities.channel = 'branch';
  else if (lower.includes('pos') || lower.includes('point of sale'))  entities.channel = 'pos';

  if (lower.includes('credit card'))          entities.product = 'credit_card';
  else if (lower.includes('debit card'))      entities.product = 'debit_card';
  else if (lower.includes('savings account')) entities.product = 'savings_account';
  else if (lower.includes('checking account') || lower.includes('current account'))
                                              entities.product = 'checking_account';
  else if (lower.includes('loan'))            entities.product = 'loan';
  else if (lower.includes('time deposit') || lower.includes('td')) entities.product = 'time_deposit';

  const urgencyCues = ['urgent', 'emergency', 'immediately', 'asap', 'right now',
                       'critical', 'important', 'as soon as possible'];
  const cue = urgencyCues.find(c => lower.includes(c));
  if (cue) entities.urgency_cue = cue;

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
// Case consistency (Slice 3: strengthened)
// ---------------------------------------------------------------------------

function resolveConsistency(
  intentType: SupportedIntentType,
  activeCase: ActiveCaseContext | null
): CaseConsistency {
  if (!activeCase) return 'no_active_case';
  if (activeCase.primary_intent_type === intentType) return 'same_case';
  if (intentType === 'complaint_follow_up') return 'same_case';
  if (intentType === 'general_complaint')   return 'possible_topic_switch';

  // Slice 3: if the new intent is clearly operational and different, mark as new_issue
  if (OPERATIONAL_INTENTS.has(intentType)) return 'new_issue';
  return 'possible_topic_switch';
}

// ---------------------------------------------------------------------------
// Flag computation
// ---------------------------------------------------------------------------

function buildFlags(options: {
  malicious:   boolean;
  ambiguous:   boolean;
  confidence:  number;
  consistency: CaseConsistency;
  multiIssue:  boolean;
  hybrid:      boolean;
}): IntentFlags {
  return {
    ambiguous:      options.ambiguous || options.confidence < CONFIDENCE_THRESHOLDS.CLARIFY,
    multi_issue:    options.multiIssue,
    hybrid:         options.hybrid,
    topic_switch:   options.consistency === 'new_issue' || options.consistency === 'possible_topic_switch',
    malicious_input:options.malicious,
  };
}

// ---------------------------------------------------------------------------
// Clarification bias (unchanged from Slice 2)
// ---------------------------------------------------------------------------

function applyClarificationBias(
  bestMatch: ClassificationMatch | null,
  clarificationCtx: ClarificationContext,
  normalizedText: string,
  evidence: string[]
): ClassificationMatch | null {
  if (!bestMatch) {
    const candidateRules = [
      ...OPERATIONAL_KEYWORD_RULES,
      ...INFORMATIONAL_KEYWORD_RULES,
    ].filter(rule => clarificationCtx.candidateIntents.includes(rule.intent));
    const biasedMatch = runKeywordClassification(normalizedText, candidateRules);
    if (biasedMatch) {
      const boosted = Math.min(1, biasedMatch.confidence + 0.05);
      evidence.push(`Clarification bias: matched candidate "${biasedMatch.intent}" → ${boosted.toFixed(2)}`);
      return { ...biasedMatch, confidence: boosted };
    }
    evidence.push('Clarification bias: no candidate matched in follow-up');
    return null;
  }
  if (clarificationCtx.candidateIntents.includes(bestMatch.intent)) {
    const boosted = Math.min(1, bestMatch.confidence + 0.05);
    evidence.push(`Clarification bias: boosted existing match "${bestMatch.intent}" → ${boosted.toFixed(2)}`);
    return { ...bestMatch, confidence: boosted };
  }
  return bestMatch;
}

// ---------------------------------------------------------------------------
// Issue summary builder
// ---------------------------------------------------------------------------

function buildIssueSummary(intentType: SupportedIntentType, entities: IntentEntities): string {
  const product = entities.product ? ` related to ${entities.product.replace(/_/g, ' ')}` : '';
  const amount  = entities.amount  != null ? ` for ${entities.amount}` : '';
  const map: Partial<Record<SupportedIntentType, string>> = {
    unauthorized_transaction:          `Unauthorized or unrecognized transaction reported${amount}${product}.`,
    lost_or_stolen_card:               `Lost or stolen card reported${product}.`,
    failed_or_delayed_transfer:        `Failed or delayed transfer reported${amount}.`,
    refund_or_reversal_issue:          `Refund or reversal issue reported${amount}.`,
    account_access_issue:              `Customer cannot access their account${product}.`,
    account_restriction_issue:         `Account restriction or block reported${product}.`,
    billing_or_fee_dispute:            `Billing error or fee dispute reported${amount}.`,
    complaint_follow_up:               `Customer following up on an existing complaint.`,
    service_quality_complaint:         `Customer complaint about service quality.`,
    document_or_certification_request:`Request for bank document or certificate${product}.`,
    product_info:                      `Customer asking about product information${product}.`,
    requirements_inquiry:              `Customer asking about requirements${product}.`,
    policy_or_process_inquiry:         `Customer asking about a policy or process.`,
    fee_or_rate_inquiry:               `Customer asking about fees or interest rates${product}.`,
    branch_or_service_info:            `Customer asking about branch or service information.`,
  };
  return map[intentType] ?? `Customer inquiry: ${intentType.replace(/_/g, ' ')}.`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function classifyIntent(input: IntentAgentInput): Promise<IntentResult> {
  const { userMessage, recentMessages, activeCase, clarificationContext } = input;

  if (!userMessage || userMessage.trim().length === 0) {
    return buildFallbackIntentResult('Empty user message');
  }

  const normalizedText = userMessage.toLowerCase().trim();
  const evidence: string[] = [];

  // ── Step 1: Malicious ────────────────────────────────────────────────────
  const maliciousSignal = detectMaliciousSignal(normalizedText);
  if (maliciousSignal.detected) {
    evidence.push(`Malicious: ${maliciousSignal.signal_type} — "${maliciousSignal.matched_indicator}"`);
    return normalizeIntentResult({
      intent_type: 'unsupported_request', intent_group: 'out_of_scope', confidence: 1.0,
      secondary_intents: [], entities: extractEntities(userMessage),
      flags: { ambiguous: false, multi_issue: false, hybrid: false, topic_switch: false, malicious_input: true },
      issue_components: [], candidate_intents_for_clarification: [],
      consistency_with_active_case: activeCase ? 'same_case' : 'no_active_case', evidence,
    });
  }

  // ── Step 2: Out-of-scope ─────────────────────────────────────────────────
  const outOfScope = detectOutOfScope(normalizedText);
  if (outOfScope.detected) {
    evidence.push(`Out-of-scope: "${outOfScope.indicator}"`);
    return normalizeIntentResult({
      intent_type: 'unsupported_request', intent_group: 'out_of_scope', confidence: 0.95,
      secondary_intents: [], entities: extractEntities(userMessage),
      flags: { ambiguous: false, multi_issue: false, hybrid: false, topic_switch: false, malicious_input: false },
      issue_components: [], candidate_intents_for_clarification: [],
      consistency_with_active_case: activeCase ? 'same_case' : 'no_active_case', evidence,
    });
  }

  // ── Step 3: Standalone ambiguity ─────────────────────────────────────────
  const isStandaloneAmbiguous = detectAmbiguous(normalizedText);
  if (isStandaloneAmbiguous) evidence.push('Standalone ambiguous pattern matched');

  // ── Step 4: All operational matches (for multi-issue + hybrid) ───────────
  const allOperationalMatches = runAllOperationalMatches(normalizedText);
  const bestOperationalMatch  = allOperationalMatches[0] ?? null;
  const bestInformationalMatch = runKeywordClassification(normalizedText, INFORMATIONAL_KEYWORD_RULES);

  // ── Step 5: Hybrid detection ─────────────────────────────────────────────
  const hybridDetection = detectHybrid(normalizedText, bestOperationalMatch);
  if (hybridDetection.detected && bestOperationalMatch && bestInformationalMatch) {
    evidence.push(...hybridDetection.evidence);
    const entities = extractEntities(userMessage);
    const components: IssueComponent[] = [
      {
        intent_type:  bestInformationalMatch.intent,
        intent_group: 'informational' as const,
        confidence:   bestInformationalMatch.confidence,
        entities,
        summary:      buildIssueSummary(bestInformationalMatch.intent, entities),
      },
      {
        intent_type:  bestOperationalMatch.intent,
        intent_group: 'operational' as const,
        confidence:   bestOperationalMatch.confidence,
        entities,
        summary:      buildIssueSummary(bestOperationalMatch.intent, entities),
      },
    ];
    const consistency = resolveConsistency(bestOperationalMatch.intent, activeCase);
    return normalizeIntentResult({
      intent_type:  bestOperationalMatch.intent,
      intent_group: 'operational',
      confidence:   bestOperationalMatch.confidence,
      secondary_intents: [bestInformationalMatch.intent],
      entities,
      flags: {
        ambiguous: false, multi_issue: false, hybrid: true,
        topic_switch: consistency === 'new_issue', malicious_input: false,
      },
      issue_components:                    components,
      candidate_intents_for_clarification: [],
      consistency_with_active_case:        consistency,
      evidence,
    });
  }

  // ── Step 6: Multi-issue detection ────────────────────────────────────────
  const multiIssueDetection = detectMultiIssue(normalizedText, allOperationalMatches);
  if (multiIssueDetection.detected) {
    evidence.push(...multiIssueDetection.evidence);
    const entities = extractEntities(userMessage);
    const components: IssueComponent[] = multiIssueDetection.components.map(c => ({
      intent_type:  c.intent,
      intent_group: 'operational' as const,
      confidence:   c.confidence,
      entities,
      summary:      buildIssueSummary(c.intent, entities),
    }));
    const primaryIntent = multiIssueDetection.components[0].intent;
    const consistency   = resolveConsistency(primaryIntent, activeCase);
    return normalizeIntentResult({
      intent_type:  'multi_issue_case',
      intent_group: 'operational',
      confidence:   Math.min(...multiIssueDetection.components.map(c => c.confidence)),
      secondary_intents: multiIssueDetection.components.slice(1).map(c => c.intent),
      entities,
      flags: {
        ambiguous: false, multi_issue: true, hybrid: false,
        topic_switch: consistency === 'new_issue', malicious_input: false,
      },
      issue_components:                    components,
      candidate_intents_for_clarification: [],
      consistency_with_active_case:        consistency,
      evidence,
    });
  }

  // ── Step 7: Standard single-intent path (Slice 1 / Slice 2) ─────────────
  let bestMatch: ClassificationMatch | null = null;
  if (bestOperationalMatch && bestInformationalMatch) {
    bestMatch = bestOperationalMatch.confidence >= bestInformationalMatch.confidence
      ? bestOperationalMatch : bestInformationalMatch;
    evidence.push(`Both matches; selected ${bestMatch.intent} (${bestMatch.confidence.toFixed(2)})`);
  } else if (bestOperationalMatch) {
    bestMatch = bestOperationalMatch;
    evidence.push(`Operational: ${bestOperationalMatch.intent} (${bestOperationalMatch.confidence.toFixed(2)})`);
    evidence.push(bestOperationalMatch.evidence);
  } else if (bestInformationalMatch) {
    bestMatch = bestInformationalMatch;
    evidence.push(`Informational: ${bestInformationalMatch.intent} (${bestInformationalMatch.confidence.toFixed(2)})`);
    evidence.push(bestInformationalMatch.evidence);
  }

  if (clarificationContext) {
    evidence.push(`Clarification loop (turn ${clarificationContext.turnCount})`);
    bestMatch = applyClarificationBias(bestMatch, clarificationContext, normalizedText, evidence);
  }

  let finalConfidence = bestMatch
    ? applyAmbiguityPenalty(bestMatch.confidence, normalizedText) : 0;

  let intentType: SupportedIntentType;
  if (!bestMatch || finalConfidence < CONFIDENCE_THRESHOLDS.AMBIGUOUS || isStandaloneAmbiguous) {
    intentType      = 'unclear_issue';
    finalConfidence = isStandaloneAmbiguous ? 0.40 : (bestMatch ? finalConfidence : 0);
    evidence.push(bestMatch
      ? `Below threshold → unclear_issue`
      : 'No match → unclear_issue');
  } else {
    intentType = bestMatch.intent;
  }

  const entities      = extractEntities(userMessage);
  const resolvedGroup = resolveIntentGroup(intentType);
  const consistency   = resolveConsistency(intentType, activeCase);
  const isAmbiguous   = isStandaloneAmbiguous || finalConfidence < CONFIDENCE_THRESHOLDS.CLARIFY;

  const flags = buildFlags({
    malicious: false, ambiguous: isAmbiguous, confidence: finalConfidence,
    consistency, multiIssue: false, hybrid: false,
  });

  const candidateIntents: SupportedIntentType[] = isAmbiguous
    ? (clarificationContext?.candidateIntents ?? CLARIFICATION_CANDIDATE_INTENTS) : [];

  const issueComponents: IssueComponent[] =
    intentType !== 'unclear_issue' && intentType !== 'unsupported_request'
      ? [{ intent_type: intentType, intent_group: resolvedGroup, confidence: finalConfidence, entities, summary: buildIssueSummary(intentType, entities) }]
      : [];

  return normalizeIntentResult({
    intent_type: intentType, intent_group: resolvedGroup, confidence: finalConfidence,
    secondary_intents: [], entities, flags, issue_components: issueComponents,
    candidate_intents_for_clarification: candidateIntents,
    consistency_with_active_case: consistency, evidence,
  });
}