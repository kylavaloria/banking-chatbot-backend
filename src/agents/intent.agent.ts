// ─────────────────────────────────────────────────────────────────────────────
// Intent Agent — Slice 4 + informational pre-check + Gemini intent model
//
// Execution order:
//   1. Deterministic security pre-checks (malicious / out-of-scope)
//   2. Informational override pre-check — two-tier:
//      Tier 1: strong interrogative starters (What is/are, How does/do/long,
//              Can you explain, Do you have, etc.) — always informational
//              unless a conjunction + operational keyword is also present
//      Tier 2: specific regex patterns — only informational if no strong
//              operational keyword match
//   3. Deterministic structural pre-checks (hybrid + multi-issue)
//   4. isSimpleMessage routing → select model
//   5. LLM call (Gemini gemini-2.0-flash) for single-intent messages
//   6. JSON extraction + normalizeIntentResult()
//   7. Fallback to rule-based classifier on any failure
// ─────────────────────────────────────────────────────────────────────────────

import type {
  IntentResult, IntentEntities, IntentFlags, SupportedIntentType,
  CaseConsistency, IssueComponent,
} from '../contracts/intent.contract';
import type { ActiveCaseContext, RecentMessage } from '../contracts/orchestration.contract';

import {
  INFORMATIONAL_KEYWORD_RULES, OPERATIONAL_KEYWORD_RULES,
  AMBIGUOUS_SIGNAL_PHRASES, AMBIGUOUS_STANDALONE_PATTERNS,
  CLARIFICATION_CANDIDATE_INTENTS, CONFIDENCE_THRESHOLDS,
  INFORMATIONAL_INTENTS, OPERATIONAL_INTENTS, resolveIntentGroup,
  KeywordRule, MULTI_ISSUE_PAIRS, MULTI_ISSUE_CONJUNCTION_PHRASES,
  HYBRID_INFORMATIONAL_SIGNALS, PHYSICAL_CARD_LOSS_OR_THEFT_PHRASES,
} from '../constants/intent-taxonomy';

import {
  PROMPT_INJECTION_SUBSTRINGS, PROMPT_INJECTION_PATTERNS,
  OUT_OF_SCOPE_SUBSTRINGS, DATA_EXFILTRATION_SUBSTRINGS,
  MaliciousSignal,
} from '../constants/malicious-patterns';

import {
  normalizeIntentResult, buildFallbackIntentResult, normalizeEntities,
} from '../utils/normalizers';

import { callGemini }          from '../llm/gemini.client';
import { extractJSON }         from '../utils/json-extract';
import { buildIntentMessages } from '../llm/prompts/intent.prompt';
import { env }                 from '../config/env';

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
// Contraction expansion
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

// ---------------------------------------------------------------------------
// Keyword classification helpers
// ---------------------------------------------------------------------------

function runKeywordClassification(
  normalizedText: string,
  expanded: string,
  rules: KeywordRule[]
): ClassificationMatch | null {
  let bestMatch: ClassificationMatch | null = null;
  for (const rule of rules) {
    const matched = rule.keywords.filter(
      kw => normalizedText.includes(kw) || expanded.includes(kw)
    );
    if (matched.length === 0) continue;
    const confidence = Math.min(
      1,
      rule.baseConfidence + Math.min(0.05, (matched.length - 1) * 0.015)
    );
    if (!bestMatch || confidence > bestMatch.confidence) {
      bestMatch = {
        intent:   rule.intent,
        confidence,
        evidence: `Matched: "${matched.slice(0, 3).join('", "')}"`,
      };
    }
  }
  return bestMatch;
}

function runAllOperationalMatches(
  normalizedText: string,
  expanded: string,
  minConfidence = CONFIDENCE_THRESHOLDS.CLARIFY
): ClassificationMatch[] {
  const results: ClassificationMatch[] = [];
  const seen = new Set<SupportedIntentType>();
  for (const rule of OPERATIONAL_KEYWORD_RULES) {
    if (seen.has(rule.intent)) continue;
    const matched = rule.keywords.filter(
      kw => normalizedText.includes(kw) || expanded.includes(kw)
    );
    if (matched.length === 0) continue;
    const confidence = Math.min(
      1,
      rule.baseConfidence + Math.min(0.05, (matched.length - 1) * 0.015)
    );
    if (confidence >= minConfidence) {
      results.push({
        intent:   rule.intent,
        confidence,
        evidence: `Matched: "${matched.slice(0, 2).join('", "')}"`,
      });
      seen.add(rule.intent);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Informational override pre-check (Step 2.5)
//
// Tier 1 — STRONG interrogative starters
// These sentence structures are unambiguously questions/inquiries.
// "What is your refund policy" cannot be a complaint even if "refund" is
// an operational keyword. Override fires unless a conjunction phrase is
// also present (hybrid case).
//
// Tier 2 — specific pattern-based overrides
// Only fire when no strong operational keyword is also present.
// ---------------------------------------------------------------------------

const STRONG_INTERROGATIVE_STARTERS: RegExp[] = [
  // "What is/are [your/the/a] ..."
  /^what (is|are) (your|the) /i,
  /^what (is|are) a /i,
  /^what (is|are) an /i,
  // "What do/does X mean/include/require/cover ..."
  /^what (do|does) .{0,30} (mean|include|cover|require|involve|offer|provide)/i,
  // "How does/do ..."
  /^how (does|do) /i,
  // "How long ..."
  /^how long /i,
  // "How much ..."
  /^how much /i,
  // "How can/could/would/should I ..."
  /^how (can|could|would|should) i /i,
  // "How is/are ..."
  /^how (is|are) /i,
  // "Can you explain/tell/describe/clarify ..."
  /^can you (explain|tell|describe|clarify|help me understand)/i,
  // "Tell me about/how/what ..."
  /^tell me (about|how|what)/i,
  // "Do you have/offer/provide/support ..."
  /^do you (have|offer|provide|support|allow|accept)/i,
  // "Is there a/an ..."
  /^is there (a|an) /i,
  // "Are there any ..."
  /^are there (any|some) /i,
  // "What happens if/when ..."
  /^what happens (if|when) /i,
  // "Who do/should/can I contact/call/reach ..."
  /^who (do i|should i|can i) (contact|call|reach|talk)/i,
  // "Where is/are your ..."
  /^where (is|are) (your|the) /i,
  // "When does/is/are ..."
  /^when (does|is|are) /i,
];

const INFORMATIONAL_OVERRIDE_PATTERNS: RegExp[] = [
  // Tier 2 — specific patterns (op keyword guard applies)
  /kyc (process|requirements|procedure|steps)/i,
  /what do i need (to provide |to submit )?(for )?kyc/i,
  /(branch|office|atm) (hours|schedule|location|address)/i,
  /(customer|support) (service |support )?(channels?|hotline|number|contact)/i,
];

function detectInformationalOverride(
  normalizedText: string
): { override: boolean; strong: boolean } {
  if (STRONG_INTERROGATIVE_STARTERS.some(p => p.test(normalizedText))) {
    return { override: true, strong: true };
  }
  if (INFORMATIONAL_OVERRIDE_PATTERNS.some(p => p.test(normalizedText))) {
    return { override: true, strong: false };
  }
  return { override: false, strong: false };
}

// ---------------------------------------------------------------------------
// Simple message routing heuristic
// ---------------------------------------------------------------------------

export function isSimpleMessage(normalizedText: string): boolean {
  const hasConjunction = MULTI_ISSUE_CONJUNCTION_PHRASES.some(p =>
    normalizedText.includes(p)
  );
  if (hasConjunction) return false;

  const hasHybridSignal = HYBRID_INFORMATIONAL_SIGNALS.some(s =>
    normalizedText.includes(s)
  );
  if (hasHybridSignal) {
    const expandedText = expandContractions(normalizedText);
    const hasOpKeyword = runAllOperationalMatches(normalizedText, expandedText).length > 0;
    if (hasOpKeyword) return false;
  }

  const expandedText = expandContractions(normalizedText);
  const allOpMatches = runAllOperationalMatches(normalizedText, expandedText);
  if (allOpMatches.length >= 2) return false;

  const wordCount = normalizedText.split(/\s+/).length;
  if (wordCount > 20) return false;

  if (/\b(earlier|before|previously|last time|my other|another case)\b/i.test(normalizedText)) {
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Deterministic security checks
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
    const m = pattern.exec(normalizedText);
    if (m) {
      return { detected: true, signal_type: 'prompt_injection', matched_indicator: pattern.toString() };
    }
  }
  return { detected: false, signal_type: null, matched_indicator: null };
}

function detectOutOfScope(
  normalizedText: string
): { detected: boolean; indicator: string | null } {
  for (const phrase of OUT_OF_SCOPE_SUBSTRINGS) {
    if (normalizedText.includes(phrase)) return { detected: true, indicator: phrase };
  }
  return { detected: false, indicator: null };
}

// ---------------------------------------------------------------------------
// Entity extraction
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
    const p = parseFloat(amountMatch[1].replace(/,/g, ''));
    if (isFinite(p) && p > 0) entities.amount = p;
  }

  const refMatch = rawMessage.match(/\b([A-Z0-9]{6,20})\b/);
  if (refMatch) entities.reference_number = refMatch[1];

  const datePatterns = [
    /yesterday/i,
    /last (monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i,
    /last week/i,
    /\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?/,
    /january|february|march|april|may|june|july|august|september|october|november|december/i,
    /today|this morning|this afternoon|this evening|earlier today/i,
  ];
  for (const p of datePatterns) {
    const m = rawMessage.match(p);
    if (m) { entities.date_reference = m[0]; break; }
  }

  if (lower.includes('mobile app') || lower.includes('app')) entities.channel = 'mobile_app';
  else if (lower.includes('atm'))                             entities.channel = 'atm';
  else if (lower.includes('online banking'))                  entities.channel = 'online_banking';
  else if (lower.includes('branch') || lower.includes('teller')) entities.channel = 'branch';

  if (lower.includes('credit card'))          entities.product = 'credit_card';
  else if (lower.includes('debit card'))      entities.product = 'debit_card';
  else if (lower.includes('savings account')) entities.product = 'savings_account';
  else if (lower.includes('loan'))            entities.product = 'loan';

  const cue = ['urgent', 'emergency', 'immediately', 'asap', 'right now']
    .find(c => lower.includes(c));
  if (cue) entities.urgency_cue = cue;

  if (/i (did not|didn't) (make|authorize|do)/i.test(rawMessage))
    entities.reported_action = 'denied_action';
  else if (/someone (used|took|withdrew|transferred)/i.test(rawMessage))
    entities.reported_action = 'third_party_action';

  return normalizeEntities(entities);
}

// ---------------------------------------------------------------------------
// Consistency check
// ---------------------------------------------------------------------------

function resolveConsistency(
  intentType: SupportedIntentType,
  activeCase: ActiveCaseContext | null
): CaseConsistency {
  if (!activeCase) return 'no_active_case';
  if (activeCase.primary_intent_type === intentType) return 'same_case';
  if (intentType === 'complaint_follow_up') return 'same_case';
  if (intentType === 'general_complaint')   return 'possible_topic_switch';
  if (OPERATIONAL_INTENTS.has(intentType))  return 'new_issue';
  return 'possible_topic_switch';
}

// ---------------------------------------------------------------------------
// Issue summary builder
// ---------------------------------------------------------------------------

function buildIssueSummary(
  intentType: SupportedIntentType,
  entities: IntentEntities
): string {
  const product = entities.product ? ` related to ${entities.product.replace(/_/g, ' ')}` : '';
  const amount  = entities.amount  != null ? ` for ${entities.amount}` : '';
  const map: Partial<Record<SupportedIntentType, string>> = {
    unauthorized_transaction:          `Unauthorized transaction reported${amount}${product}.`,
    lost_or_stolen_card:               `Lost or stolen card reported${product}.`,
    failed_or_delayed_transfer:        `Failed or delayed transfer reported${amount}.`,
    refund_or_reversal_issue:          `Refund or reversal issue reported${amount}.`,
    account_access_issue:              `Customer cannot access their account${product}.`,
    account_restriction_issue:         `Account restriction reported${product}.`,
    billing_or_fee_dispute:            `Billing error or fee dispute reported${amount}.`,
    complaint_follow_up:               `Customer following up on an existing complaint.`,
    service_quality_complaint:         `Customer complaint about service quality.`,
    document_or_certification_request:`Request for bank document${product}.`,
    product_info:                      `Customer asking about product information${product}.`,
    requirements_inquiry:              `Customer asking about requirements${product}.`,
    policy_or_process_inquiry:         `Customer asking about a policy or process.`,
    fee_or_rate_inquiry:               `Customer asking about fees or rates${product}.`,
    branch_or_service_info:            `Customer asking about branch or service information.`,
  };
  return map[intentType] ?? `Customer inquiry: ${intentType.replace(/_/g, ' ')}.`;
}

// ---------------------------------------------------------------------------
// Rule-based fallback classifier
// ---------------------------------------------------------------------------

async function classifyIntentRuleBased(input: IntentAgentInput): Promise<IntentResult> {
  const { userMessage, activeCase, clarificationContext } = input;
  const normalizedText = userMessage.toLowerCase().trim();
  const expanded       = expandContractions(normalizedText);
  const evidence: string[] = ['[FALLBACK: rule-based classifier]'];

  const isStandaloneAmbiguous = AMBIGUOUS_STANDALONE_PATTERNS.some(p =>
    p.test(normalizedText)
  );
  if (isStandaloneAmbiguous) evidence.push('Standalone ambiguous pattern');

  const allOpMatches  = runAllOperationalMatches(normalizedText, expanded);
  const bestOpMatch   = allOpMatches[0] ?? null;
  const bestInfoMatch = runKeywordClassification(normalizedText, expanded, INFORMATIONAL_KEYWORD_RULES);

  // Multi-issue fallback
  if (allOpMatches.length >= 2) {
    const hasConjunction = MULTI_ISSUE_CONJUNCTION_PHRASES.some(p => normalizedText.includes(p));
    const matchedIntents = new Set(allOpMatches.map(m => m.intent));
    const hasPair        = MULTI_ISSUE_PAIRS.some(([a, b]) =>
      matchedIntents.has(a) && matchedIntents.has(b)
    );
    const highConf = allOpMatches.filter(m => m.confidence >= CONFIDENCE_THRESHOLDS.ACCEPT);
    if (hasPair || (hasConjunction && highConf.length >= 2)) {
      const top2     = [...allOpMatches].sort((a, b) => b.confidence - a.confidence).slice(0, 2);
      const entities = extractEntities(userMessage);
      const components: IssueComponent[] = top2.map(c => ({
        intent_type:  c.intent,
        intent_group: 'operational' as const,
        confidence:   c.confidence,
        entities,
        summary:      buildIssueSummary(c.intent, entities),
      }));
      return normalizeIntentResult({
        intent_type: 'multi_issue_case', intent_group: 'operational',
        confidence:  Math.min(...top2.map(c => c.confidence)),
        secondary_intents: [top2[1].intent], entities,
        flags: {
          ambiguous: false, multi_issue: true, hybrid: false,
          topic_switch: false, malicious_input: false,
        },
        issue_components:                    components,
        candidate_intents_for_clarification: [],
        consistency_with_active_case:        resolveConsistency(top2[0].intent, activeCase),
        evidence,
      });
    }
  }

  // Hybrid fallback
  if (bestOpMatch && bestInfoMatch &&
      bestOpMatch.confidence >= CONFIDENCE_THRESHOLDS.ACCEPT) {
    const hasHybridSignal = HYBRID_INFORMATIONAL_SIGNALS.some(s =>
      normalizedText.includes(s)
    );
    if (hasHybridSignal) {
      const entities = extractEntities(userMessage);
      return normalizeIntentResult({
        intent_type:  bestOpMatch.intent,
        intent_group: 'operational',
        confidence:   bestOpMatch.confidence,
        secondary_intents: [bestInfoMatch.intent],
        entities,
        flags: {
          ambiguous: false, multi_issue: false, hybrid: true,
          topic_switch: false, malicious_input: false,
        },
        issue_components: [
          {
            intent_type:  bestInfoMatch.intent,
            intent_group: 'informational' as const,
            confidence:   bestInfoMatch.confidence,
            entities,
            summary:      buildIssueSummary(bestInfoMatch.intent, entities),
          },
          {
            intent_type:  bestOpMatch.intent,
            intent_group: 'operational' as const,
            confidence:   bestOpMatch.confidence,
            entities,
            summary:      buildIssueSummary(bestOpMatch.intent, entities),
          },
        ],
        candidate_intents_for_clarification: [],
        consistency_with_active_case: resolveConsistency(bestOpMatch.intent, activeCase),
        evidence,
      });
    }
  }

  // Standard single-intent fallback
  let bestMatch: ClassificationMatch | null =
    bestOpMatch && bestInfoMatch
      ? (bestOpMatch.confidence >= bestInfoMatch.confidence ? bestOpMatch : bestInfoMatch)
      : (bestOpMatch ?? bestInfoMatch);

  if (clarificationContext && bestMatch) {
    if (clarificationContext.candidateIntents.includes(bestMatch.intent)) {
      bestMatch = { ...bestMatch, confidence: Math.min(1, bestMatch.confidence + 0.05) };
    }
  }

  const finalConf = bestMatch
    ? Math.max(
        0,
        bestMatch.confidence -
          Math.min(
            0.20,
            AMBIGUOUS_SIGNAL_PHRASES.filter(p => normalizedText.includes(p)).length * 0.05
          )
      )
    : 0;

  const intentType: SupportedIntentType =
    !bestMatch || finalConf < CONFIDENCE_THRESHOLDS.AMBIGUOUS || isStandaloneAmbiguous
      ? 'unclear_issue'
      : bestMatch.intent;

  const entities    = extractEntities(userMessage);
  const group       = resolveIntentGroup(intentType);
  const consistency = resolveConsistency(intentType, activeCase);
  const isAmbiguous = isStandaloneAmbiguous || finalConf < CONFIDENCE_THRESHOLDS.CLARIFY;

  return normalizeIntentResult({
    intent_type:  intentType,
    intent_group: group,
    confidence:   finalConf,
    secondary_intents: [],
    entities,
    flags: {
      ambiguous:       isAmbiguous,
      multi_issue:     false,
      hybrid:          false,
      topic_switch:    consistency === 'new_issue' || consistency === 'possible_topic_switch',
      malicious_input: false,
    },
    issue_components: intentType !== 'unclear_issue' && intentType !== 'unsupported_request'
      ? [{
          intent_type:  intentType,
          intent_group: group,
          confidence:   finalConf,
          entities,
          summary:      buildIssueSummary(intentType, entities),
        }]
      : [],
    candidate_intents_for_clarification: isAmbiguous
      ? (clarificationContext?.candidateIntents ?? CLARIFICATION_CANDIDATE_INTENTS)
      : [],
    consistency_with_active_case: consistency,
    evidence,
  });
}

// ---------------------------------------------------------------------------
// Fraud-only multi_issue collapse
// ---------------------------------------------------------------------------

const FRAUD_MULTI_ISSUE_INTENTS = new Set<SupportedIntentType>([
  'unauthorized_transaction',
  'lost_or_stolen_card',
]);

function messageIndicatesPhysicalCardLossOrTheft(
  normalizedText: string,
  expandedText: string
): boolean {
  return PHYSICAL_CARD_LOSS_OR_THEFT_PHRASES.some(
    p => normalizedText.includes(p) || expandedText.includes(p)
  );
}

function collapseFraudOnlyFalseMultiIssue(
  result: IntentResult,
  normalizedText: string
): void {
  if (!result.flags.multi_issue && result.intent_type !== 'multi_issue_case') return;

  const opComponents = result.issue_components.filter(c =>
    OPERATIONAL_INTENTS.has(c.intent_type)
  );
  if (opComponents.length < 2) return;
  if (!opComponents.every(c => FRAUD_MULTI_ISSUE_INTENTS.has(c.intent_type))) return;

  const expandedText = expandContractions(normalizedText);
  if (messageIndicatesPhysicalCardLossOrTheft(normalizedText, expandedText)) return;

  const unauthorizedComp = opComponents.find(
    c => c.intent_type === 'unauthorized_transaction'
  );
  const pick =
    unauthorizedComp ??
    opComponents.reduce((a, b) => (b.confidence > a.confidence ? b : a));
  const maxConf = Math.max(...opComponents.map(c => c.confidence));

  result.intent_type    = 'unauthorized_transaction';
  result.intent_group   = 'operational';
  result.flags.multi_issue = false;
  result.secondary_intents = result.secondary_intents.filter(
    t => !FRAUD_MULTI_ISSUE_INTENTS.has(t)
  );
  result.issue_components = [{
    ...pick,
    intent_type:  'unauthorized_transaction',
    intent_group: 'operational',
    confidence:   maxConf,
    summary:
      pick.summary ||
      buildIssueSummary('unauthorized_transaction', pick.entities),
  }];
  result.evidence.push(
    'Collapsed fraud-only multi_issue to single unauthorized_transaction (no physical card-loss phrasing)'
  );
}

// ---------------------------------------------------------------------------
// LLM-backed classification — Gemini
// ---------------------------------------------------------------------------

async function classifyIntentLLM(
  input: IntentAgentInput,
  model: string
): Promise<IntentResult | null> {
  try {
    const messages = buildIntentMessages(
      input.userMessage,
      input.recentMessages,
      input.activeCase,
      input.clarificationContext ?? null
    );

    const llmResponse = await callGemini({
      messages,
      model,
      temperature: 0.1,
      maxTokens:   2048,
    });

    const parsed = extractJSON(llmResponse.text);
    if (!parsed) {
      console.warn('[IntentAgent] LLM returned unparseable JSON', {
        model,
        text: llmResponse.text.slice(0, 200),
      });
      return null;
    }

    parsed['raw_llm_output'] = {
      model_used: llmResponse.model_used,
      usage:      llmResponse.usage,
    };

    const normalized = normalizeIntentResult(parsed);
    collapseFraudOnlyFalseMultiIssue(
      normalized,
      input.userMessage.toLowerCase().trim()
    );
    return normalized;
  } catch (err) {
    console.warn(
      '[IntentAgent] LLM call failed, will use fallback',
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function classifyIntent(input: IntentAgentInput): Promise<IntentResult> {
  const { userMessage, activeCase } = input;

  if (!userMessage || userMessage.trim().length === 0) {
    return buildFallbackIntentResult('Empty user message');
  }

  const normalizedText = userMessage.toLowerCase().trim();

  // ── Step 1: Malicious pre-check ───────────────────────────────────────────
  const maliciousSignal = detectMaliciousSignal(normalizedText);
  if (maliciousSignal.detected) {
    return normalizeIntentResult({
      intent_type:  'unsupported_request',
      intent_group: 'out_of_scope',
      confidence:   1.0,
      secondary_intents: [],
      entities: extractEntities(userMessage),
      flags: {
        ambiguous: false, multi_issue: false, hybrid: false,
        topic_switch: false, malicious_input: true,
      },
      issue_components:                    [],
      candidate_intents_for_clarification: [],
      consistency_with_active_case: activeCase ? 'same_case' : 'no_active_case',
      evidence: [
        `Malicious pre-check: ${maliciousSignal.signal_type} — "${maliciousSignal.matched_indicator}"`,
      ],
    });
  }

  // ── Step 2: Out-of-scope pre-check ────────────────────────────────────────
  const outOfScope = detectOutOfScope(normalizedText);
  if (outOfScope.detected) {
    return normalizeIntentResult({
      intent_type:  'unsupported_request',
      intent_group: 'out_of_scope',
      confidence:   0.95,
      secondary_intents: [],
      entities: extractEntities(userMessage),
      flags: {
        ambiguous: false, multi_issue: false, hybrid: false,
        topic_switch: false, malicious_input: false,
      },
      issue_components:                    [],
      candidate_intents_for_clarification: [],
      consistency_with_active_case: activeCase ? 'same_case' : 'no_active_case',
      evidence: [`Out-of-scope pre-check: "${outOfScope.indicator}"`],
    });
  }

  // ── Step 2.5: Informational override pre-check ────────────────────────────
  // Tier 1 — strong interrogative starters (What is/are, How does/do/long,
  //           Can you explain, Do you have, etc.)
  //           Always returns informational UNLESS a conjunction phrase is
  //           also present (indicating a hybrid message like
  //           "What are your hours, and also my transfer failed").
  //
  // Tier 2 — specific regex patterns
  //           Returns informational only if no strong operational keyword match.
  const overrideResult = detectInformationalOverride(normalizedText);

  if (overrideResult.override) {
    const expandedText   = expandContractions(normalizedText);
    const hasConjunction = MULTI_ISSUE_CONJUNCTION_PHRASES.some(p =>
      normalizedText.includes(p)
    );

    // Conjunction present → likely hybrid, fall through to structural checks
    if (!hasConjunction) {
      const opMatches   = runAllOperationalMatches(normalizedText, expandedText);
      const hasStrongOp = opMatches.length > 0 &&
        opMatches[0].confidence >= CONFIDENCE_THRESHOLDS.ACCEPT;

      // Tier 1: always informational (question structure overrides op noun)
      // Tier 2: only informational if no strong op keyword
      if (overrideResult.strong || !hasStrongOp) {
        const bestInfo   = runKeywordClassification(
          normalizedText, expandedText, INFORMATIONAL_KEYWORD_RULES
        );
        const intentType = bestInfo?.intent ?? 'policy_or_process_inquiry' as SupportedIntentType;
        const confidence = bestInfo?.confidence ?? 0.90;
        const entities   = extractEntities(userMessage);
        const group      = resolveIntentGroup(intentType);

        return normalizeIntentResult({
          intent_type:  intentType,
          intent_group: group,
          confidence,
          secondary_intents: [],
          entities,
          flags: {
            ambiguous: false, multi_issue: false, hybrid: false,
            topic_switch: false, malicious_input: false,
          },
          issue_components: [{
            intent_type:  intentType,
            intent_group: group,
            confidence,
            entities,
            summary: buildIssueSummary(intentType, entities),
          }],
          candidate_intents_for_clarification: [],
          consistency_with_active_case: activeCase ? 'same_case' : 'no_active_case',
          evidence: [
            `Informational override (${overrideResult.strong ? 'strong' : 'pattern'}): "${normalizedText.slice(0, 80)}"`,
          ],
        });
      }
    }
    // Falls through if conjunction present or Tier 2 with strong op keyword
  }

  // ── Step 3: Structural pre-checks (hybrid + multi-issue) ─────────────────
  const expandedText  = expandContractions(normalizedText);
  const allOpMatches  = runAllOperationalMatches(normalizedText, expandedText);
  const bestOpMatch   = allOpMatches[0] ?? null;
  const bestInfoMatch = runKeywordClassification(
    normalizedText, expandedText, INFORMATIONAL_KEYWORD_RULES
  );

  // Hybrid pre-check
  if (bestOpMatch && bestInfoMatch &&
      bestOpMatch.confidence >= CONFIDENCE_THRESHOLDS.ACCEPT) {
    const hasHybridSignal = HYBRID_INFORMATIONAL_SIGNALS.some(s =>
      normalizedText.includes(s)
    );
    if (hasHybridSignal) {
      const entities    = extractEntities(userMessage);
      const consistency = resolveConsistency(bestOpMatch.intent, activeCase);
      return normalizeIntentResult({
        intent_type:  bestOpMatch.intent,
        intent_group: 'operational',
        confidence:   bestOpMatch.confidence,
        secondary_intents: [bestInfoMatch.intent],
        entities,
        flags: {
          ambiguous: false, multi_issue: false, hybrid: true,
          topic_switch: consistency === 'new_issue', malicious_input: false,
        },
        issue_components: [
          {
            intent_type:  bestInfoMatch.intent,
            intent_group: 'informational' as const,
            confidence:   bestInfoMatch.confidence,
            entities,
            summary:      buildIssueSummary(bestInfoMatch.intent, entities),
          },
          {
            intent_type:  bestOpMatch.intent,
            intent_group: 'operational' as const,
            confidence:   bestOpMatch.confidence,
            entities,
            summary:      buildIssueSummary(bestOpMatch.intent, entities),
          },
        ],
        candidate_intents_for_clarification: [],
        consistency_with_active_case:        consistency,
        evidence: [
          `Pre-check hybrid: info=${bestInfoMatch.intent} op=${bestOpMatch.intent}`,
        ],
      });
    }
  }

  // Multi-issue pre-check
  if (allOpMatches.length >= 2) {
    const hasConjunction = MULTI_ISSUE_CONJUNCTION_PHRASES.some(p =>
      normalizedText.includes(p)
    );
    const matchedIntents = new Set(allOpMatches.map(m => m.intent));
    const hasPair        = MULTI_ISSUE_PAIRS.some(([a, b]) =>
      matchedIntents.has(a) && matchedIntents.has(b)
    );
    const highConf = allOpMatches.filter(
      m => m.confidence >= CONFIDENCE_THRESHOLDS.ACCEPT
    );
    // Word-count guard: short vague messages lack the specificity needed
    // for reliable multi-issue detection — let LLM handle them
    const wordCount  = normalizedText.split(/\s+/).length;
    const isTooVague = wordCount <= 9;

    if (!isTooVague && (hasPair || (hasConjunction && highConf.length >= 2))) {
      const top2     = [...allOpMatches]
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 2);
      const entities    = extractEntities(userMessage);
      const consistency = resolveConsistency(top2[0].intent, activeCase);
      return normalizeIntentResult({
        intent_type:  'multi_issue_case',
        intent_group: 'operational',
        confidence:   Math.min(...top2.map(c => c.confidence)),
        secondary_intents: [top2[1].intent],
        entities,
        flags: {
          ambiguous: false, multi_issue: true, hybrid: false,
          topic_switch: consistency === 'new_issue', malicious_input: false,
        },
        issue_components: top2.map(c => ({
          intent_type:  c.intent,
          intent_group: 'operational' as const,
          confidence:   c.confidence,
          entities,
          summary:      buildIssueSummary(c.intent, entities),
        })),
        candidate_intents_for_clarification: [],
        consistency_with_active_case:        consistency,
        evidence: [
          `Pre-check multi-issue: ${top2.map(c => c.intent).join(' + ')}`,
        ],
      });
    }
  }

  // ── Step 4: LLM routing + call ────────────────────────────────────────────
  const useSimpleRouting = env.INTENT_USE_SIMPLE_ROUTING !== 'false';
  const simple = isSimpleMessage(normalizedText);
  const model  = useSimpleRouting && simple
    ? env.FALLBACK_INTENT_MODEL
    : env.PRIMARY_INTENT_MODEL;

  if (env.NODE_ENV !== 'test') {
    const llmResult = await classifyIntentLLM(input, model);
    if (llmResult) {
      (llmResult as any)._routing = { simple, model_used: model };
      return llmResult;
    }
    console.warn('[IntentAgent] Falling back to rule-based classifier');
  }

  // ── Step 5: Rule-based fallback ───────────────────────────────────────────
  return classifyIntentRuleBased(input);
}