// ─────────────────────────────────────────────────────────────────────────────
// Intent Taxonomy Constants
// Single source of truth for keyword-based classification.
// All keyword arrays are lowercase. Matching is done against
// the lowercased, trimmed user message.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  SupportedIntentType,
  InformationalIntentType,
  OperationalIntentType,
  IntentGroup,
} from '../contracts/intent.contract';

// ---------------------------------------------------------------------------
// Confidence thresholds — SRS §3.2.1
// ---------------------------------------------------------------------------

export const CONFIDENCE_THRESHOLDS = {
  /** Accept and proceed to next agent */
  ACCEPT: 0.85,
  /** Ask a clarifying question */
  CLARIFY: 0.60,
  /** Treat as ambiguous; enter clarification loop */
  AMBIGUOUS: 0.59,
} as const;

// ---------------------------------------------------------------------------
// Intent group membership sets
// Used by normalizers to validate intent_group consistency.
// ---------------------------------------------------------------------------

export const INFORMATIONAL_INTENTS = new Set<SupportedIntentType>([
  'product_info',
  'requirements_inquiry',
  'policy_or_process_inquiry',
  'fee_or_rate_inquiry',
  'branch_or_service_info',
]);

export const OPERATIONAL_INTENTS = new Set<SupportedIntentType>([
  'unauthorized_transaction',
  'lost_or_stolen_card',
  'failed_or_delayed_transfer',
  'refund_or_reversal_issue',
  'account_access_issue',
  'account_restriction_issue',
  'billing_or_fee_dispute',
  'complaint_follow_up',
  'service_quality_complaint',
  'document_or_certification_request',
]);

export const SPECIAL_INTENTS = new Set<SupportedIntentType>([
  'multi_issue_case',
  'general_complaint',
  'unclear_issue',
]);

export const ALL_VALID_INTENT_TYPES = new Set<SupportedIntentType>([
  ...INFORMATIONAL_INTENTS,
  ...OPERATIONAL_INTENTS,
  ...SPECIAL_INTENTS,
  'unsupported_request',
]);

// ---------------------------------------------------------------------------
// Intent group lookup helper
// ---------------------------------------------------------------------------

// AFTER
export function resolveIntentGroup(intentType: SupportedIntentType): IntentGroup {
  if (INFORMATIONAL_INTENTS.has(intentType)) return 'informational';
  if (OPERATIONAL_INTENTS.has(intentType))   return 'operational';
  // Special intents (unclear_issue, general_complaint, multi_issue_case) are
  // NOT out_of_scope — they are ambiguous operational signals that trigger
  // clarification. Only unsupported_request is truly out_of_scope.
  if (intentType === 'unsupported_request')   return 'out_of_scope';
  return 'operational'; // special intents treated as ambiguous operational
}

// ---------------------------------------------------------------------------
// Keyword maps — ordered from most specific to least specific within each intent.
// Each entry is { keywords, intent, baseConfidence }.
// The classifier picks the highest-confidence match.
// ---------------------------------------------------------------------------

export interface KeywordRule {
  keywords: string[];
  intent: SupportedIntentType;
  /** Confidence assigned when this rule fires (0–1) */
  baseConfidence: number;
}

// ── Informational keyword rules ──────────────────────────────────────────────

export const INFORMATIONAL_KEYWORD_RULES: KeywordRule[] = [
  // fee_or_rate_inquiry
  {
    keywords: [
      'interest rate', 'annual fee', 'monthly fee', 'service charge',
      'transaction fee', 'fee schedule', 'what does it cost', 'how much does it cost',
      'charges', 'penalty fee', 'late payment fee', 'overdraft fee',
      'foreign transaction fee', 'atm fee', 'wire transfer fee',
    ],
    intent: 'fee_or_rate_inquiry',
    baseConfidence: 0.88,
  },

  // branch_or_service_info
  {
    keywords: [
      'branch', 'nearest branch', 'branch hours', 'office hours', 'atm location',
      'where is', 'how do i find', 'open on weekends', 'branch address',
      'operating hours', 'call center', 'hotline number', 'contact number',
      'customer service number',
    ],
    intent: 'branch_or_service_info',
    baseConfidence: 0.88,
  },

  // requirements_inquiry
  {
    keywords: [
      'what are the requirements', 'what do i need to', 'documents required',
      'documents needed', 'eligibility', 'how to apply', 'how do i apply',
      'can i open', 'minimum balance', 'initial deposit', 'age requirement',
      'valid id', 'government id', 'proof of income', 'requirements for',
    ],
    intent: 'requirements_inquiry',
    baseConfidence: 0.88,
  },

  // policy_or_process_inquiry
  {
    keywords: [
      'how does it work', 'what is the process', 'how long does it take',
      'processing time', 'what happens if', 'policy on', 'bank policy',
      'terms and conditions', 'how to dispute', 'how to request',
      'what is the procedure', 'clearing period', 'hold period',
      'how to cancel', 'how to close my account',
    ],
    intent: 'policy_or_process_inquiry',
    baseConfidence: 0.87,
  },

  // product_info
  {
    keywords: [
      'tell me about', 'what is', 'what are', 'what kind of',
      'types of account', 'savings account', 'checking account',
      'credit card features', 'loan features', 'product features',
      'do you offer', 'do you have', 'is there a',
      'what products', 'what services', 'personal loan',
    ],
    intent: 'product_info',
    baseConfidence: 0.86,
  },
];

// ── Operational keyword rules ─────────────────────────────────────────────────

export const OPERATIONAL_KEYWORD_RULES: KeywordRule[] = [
  // unauthorized_transaction
  {
    keywords: [
      'unauthorized transaction', 'i did not authorize', 'i did not make',
      'fraudulent charge', 'fraud', 'someone used my card', 'unauthorized charge',
      'unrecognized transaction', 'i don\'t recognize', 'suspicious transaction',
      'my card was used', 'compromised card', 'unauthorized purchase',
      'did not approve', 'scam transaction',
    ],
    intent: 'unauthorized_transaction',
    baseConfidence: 0.92,
  },

  // lost_or_stolen_card
  {
    keywords: [
        'lost my card', 'lost my debit card', 'lost my credit card',
        'lost my atm card', 'stolen card', 'card was stolen', 'lost card',
        'my card is missing', 'my debit card is missing', 'my credit card is missing',
        'i can\'t find my card', 'i cannot find my card', 'card theft',
        'misplaced my card', 'report lost card', 'report my lost card',
        'block my card', 'cancel my card', 'card stolen',
        'card has been stolen', 'my card was stolen', 'my card has been stolen',
        'need to report my card', 'report it immediately', 'lost and need to report',
    ],
    intent: 'lost_or_stolen_card',
    baseConfidence: 0.92,
  },

  // failed_or_delayed_transfer
  {
    keywords: [
        'transfer failed', 'transfer not received', 'transfer hasn\'t arrived',
        'transfer has not arrived', 'transfer did not arrive', 'transfer not arrived',
        'transfer didn\'t go through', 'transfer did not go through',
        'money not received', 'money has not arrived', 'money did not arrive',
        'payment not received', 'payment has not arrived', 'payment not arrived',
        'funds not credited', 'funds did not arrive', 'delayed transfer',
        'transfer is pending', 'transfer stuck', 'wire not received',
        'remittance not received', 'send money failed', 'payment failed',
        'transaction failed', 'my payment did not go through',
        'not arrived yet', 'hasn\'t arrived yet', 'has not arrived yet',
        'did not receive', 'never received', 'still not received',
    ],
    intent: 'failed_or_delayed_transfer',
    baseConfidence: 0.91,
  },

  // refund_or_reversal_issue
  {
    keywords: [
      'refund', 'reversal', 'my refund', 'where is my refund',
      'refund not received', 'refund not processed', 'refund still pending',
      'request a refund', 'i want a refund', 'return my money',
      'credit reversal', 'charge reversal', 'chargeback',
    ],
    intent: 'refund_or_reversal_issue',
    baseConfidence: 0.90,
  },

  // account_access_issue
  {
    keywords: [
      'can\'t log in', 'cannot log in', 'locked out', 'account locked',
      'forgot password', 'reset password', 'can\'t access my account',
      'cannot access', 'login issue', 'login problem', 'authentication failed',
      'otp not received', 'otp not working', 'can\'t receive otp',
      'two factor', '2fa issue', 'account suspended',
    ],
    intent: 'account_access_issue',
    baseConfidence: 0.91,
  },

  // account_restriction_issue
  {
    keywords: [
      'account restricted', 'account blocked', 'account frozen',
      'account on hold', 'transaction limit', 'limit reached',
      'my account is blocked', 'why is my account restricted',
      'account flagged', 'kyc', 'know your customer', 'account verification required',
      'my transactions are blocked',
    ],
    intent: 'account_restriction_issue',
    baseConfidence: 0.90,
  },

  // billing_or_fee_dispute
  {
    keywords: [
      'wrong charge', 'incorrect charge', 'dispute a charge', 'billing error',
      'charged twice', 'double charge', 'overcharged', 'charged incorrectly',
      'unexpected deduction', 'deducted without notice', 'unauthorized deduction',
      'dispute fee', 'wrong fee charged', 'billing dispute',
    ],
    intent: 'billing_or_fee_dispute',
    baseConfidence: 0.90,
  },

  // complaint_follow_up
  {
    keywords: [
      'follow up on my complaint', 'status of my complaint', 'complaint reference',
      'i filed a complaint', 'i submitted a complaint', 'my complaint',
      'ticket status', 'case status', 'what happened to my report',
      'update on my case', 'any update on my complaint',
    ],
    intent: 'complaint_follow_up',
    baseConfidence: 0.89,
  },

  // service_quality_complaint
  {
    keywords: [
      'bad service', 'poor service', 'rude staff', 'unhelpful staff',
      'disappointed with', 'complain about', 'i want to complain',
      'terrible experience', 'bad experience', 'unacceptable',
      'your staff', 'your agent', 'customer service was',
    ],
    intent: 'service_quality_complaint',
    baseConfidence: 0.87,
  },

  // document_or_certification_request
  {
    keywords: [
      'bank certificate', 'bank statement', 'account statement', 'statement of account',
      'proof of account', 'certificate of deposit', 'loan certificate',
      'request a document', 'i need a document', 'certification', 'soa',
      'statement request', 'account balance certificate',
    ],
    intent: 'document_or_certification_request',
    baseConfidence: 0.89,
  },
];

/** Physical loss or theft of the card — distinguishes stolen-card multi-issue from a single third-party fraud narrative. */
export const PHYSICAL_CARD_LOSS_OR_THEFT_PHRASES: readonly string[] = [
  'lost my card', 'lost my debit card', 'lost my credit card', 'lost my atm card',
  'stolen card', 'card was stolen', 'lost card',
  'my card is missing', 'my debit card is missing', 'my credit card is missing',
  'i can\'t find my card', 'i cannot find my card', 'card theft',
  'misplaced my card', 'report lost card', 'report my lost card',
  'card stolen', 'card has been stolen', 'my card was stolen', 'my card has been stolen',
  'lost and need to report', 'need to report my card',
];

// ---------------------------------------------------------------------------
// Vague / ambiguous signal phrases
// Presence of these without specific operational/informational context
// lowers confidence and may trigger a clarification loop.
// ---------------------------------------------------------------------------

export const AMBIGUOUS_SIGNAL_PHRASES: string[] = [
  'something is wrong',
  'there is a problem',
  'i have a problem',
  'i have an issue',
  'i have a concern',
  'something happened',
  'i need help',
  'help me',
  'i don\'t know what to do',
  'i\'m not sure',
  'something is off',
  'my account',
  'my card',
  'my transaction',
  'my transfer',
  'my payment',
];

/**
 * A message is considered a pure ambiguous signal when it matches one of
 * these phrases AND no higher-confidence keyword rule fires.
 */
export const AMBIGUOUS_STANDALONE_PATTERNS: RegExp[] = [
  /^(help|help me|hi|hello|hey|good morning|good afternoon|good evening)[\s!?.]*$/i,
  /^(i have a (problem|concern|issue|question))[\s!?.]*$/i,
  /^(something (is|went) (wrong|off|bad))[\s!?.]*$/i,
  /^(i need (help|assistance|support))[\s!?.]*$/i,
  /^(my (account|card|transfer|payment|transaction))[\s!?.]*$/i,
];

// ---------------------------------------------------------------------------
// Candidate intent groups for clarification — used when ambiguous = true
// These inform the clarification question presented to the user.
// ---------------------------------------------------------------------------

export const CLARIFICATION_CANDIDATE_INTENTS: SupportedIntentType[] = [
  'account_access_issue',
  'unauthorized_transaction',
  'failed_or_delayed_transfer',
  'lost_or_stolen_card',
  'refund_or_reversal_issue',
  'billing_or_fee_dispute',
  'fee_or_rate_inquiry',
  'policy_or_process_inquiry',
];

/**
 * Phrases that indicate the user is confirming a card block offer.
 * Checked only when case stage = awaiting_card_block_confirmation.
 */
export const CARD_BLOCK_CONFIRM_PHRASES: string[] = [
  'yes', 'yes please', 'confirm', 'please block', 'block it', 'go ahead',
  'proceed', 'do it', 'sure', 'ok', 'okay', 'block my card', 'yes block',
  'please proceed', 'i confirm', 'block the card', 'yes do it',
];

/**
 * Phrases that indicate the user is declining a card block offer.
 * Checked only when case stage = awaiting_card_block_confirmation.
 */
export const CARD_BLOCK_DECLINE_PHRASES: string[] = [
  'no', 'no thanks', 'no thank you', 'don\'t block', 'do not block',
  'skip', 'cancel', 'nevermind', 'never mind', 'not now', 'decline',
  'i will keep it', 'keep it active', 'no need', 'not necessary',
];

// ── Slice 3 additions ─────────────────────────────────────────────────────────

/**
 * Pairs of operational intents that commonly appear together in a single message.
 * Used for conservative multi-issue detection.
 * Each entry is [intentA, intentB] — order does not matter during matching.
 */
export const MULTI_ISSUE_PAIRS: Array<[SupportedIntentType, SupportedIntentType]> = [
  ['unauthorized_transaction',   'lost_or_stolen_card'],
  ['unauthorized_transaction',   'account_access_issue'],
  ['unauthorized_transaction',   'account_restriction_issue'],
  ['lost_or_stolen_card',        'account_access_issue'],
  ['failed_or_delayed_transfer', 'billing_or_fee_dispute'],
  ['failed_or_delayed_transfer', 'refund_or_reversal_issue'],
  ['account_access_issue',       'account_restriction_issue'],
  ['refund_or_reversal_issue',   'billing_or_fee_dispute'],
];

/**
 * Conjunction phrases that signal the user is describing multiple issues.
 * Presence of one of these increases multi-issue detection confidence.
 */
export const MULTI_ISSUE_CONJUNCTION_PHRASES: string[] = [
  ' and also ', ' and i also ', ' and there are ', ' and there is ',
  ' also, ', ' additionally, ', ' furthermore, ', ' on top of that, ',
  ' as well as ', ' plus ', ' in addition ',
];

/**
 * Keyword phrases that signal an informational component within a hybrid message.
 * Presence of one of these alongside an operational keyword suggests hybrid = true.
 */
export const HYBRID_INFORMATIONAL_SIGNALS: string[] = [
  'what is your', 'what are your', 'what is the', 'what are the',
  'how does', 'how do', 'can you tell me', 'do you have',
  'tell me about', 'i want to know', 'what is the policy',
  'how long does it take', 'what are the requirements',
  'what are the fees', 'what are the charges', 'what are the rates',
  'what are your hours', 'where is your branch', 'branch hours',
];