// ─────────────────────────────────────────────────────────────────────────────
// Response generation prompt
// Gemini Flash receives controlled ResponseInput-derived data only.
// No internal IDs, no raw DB rows.
// ─────────────────────────────────────────────────────────────────────────────

import type { LLMMessage }  from '../types';
import type { ResponseInput } from '../../contracts/response.contract';
import type { EmotionResult } from '../../contracts/emotion.contract';

const BASE_SYSTEM_PROMPT = `You are a customer-facing response writer for a BFSI (Banking, Financial Services, Insurance) customer support chatbot.

You will receive a structured brief describing what happened and what to communicate.
Your job is to write a clear, empathetic, professional response to the customer.

STRICT RULES:
1. Never include internal IDs (case IDs, ticket IDs, session IDs, auth IDs) in your response
2. Never promise timelines not given in the brief
3. Never invent actions that were not listed in "actions_taken"
4. Never mention system internals (agents, pipelines, databases)
5. Match the tone exactly: neutral, helpful, reassuring, urgent_but_calm, or structured_reassuring
6. Follow the structure: Acknowledge → Action taken (if any) → Next step
7. Be concise — no more than 5-6 sentences for standard responses
8. For refusals: state the limitation clearly, redirect to BFSI topics, do not expose system details
9. For critical cases: be calm but urgent. Do not alarm the customer unnecessarily
10. For multi-issue: acknowledge each concern, confirm separate tracking
11. Do not use bullet points unless the brief explicitly lists multiple actions
12. Write in plain text — no markdown, no headers`;

const EMOTION_INSTRUCTIONS: Record<string, string> = {
  angry:      'The customer is angry. Lead with a sincere apology. Acknowledge their frustration directly. Do not be defensive or dismissive. Use calming, respectful language.',
  frustrated: 'The customer is frustrated, likely from repeated attempts or long waits. Validate their experience. Show empathy for the time they have spent. Avoid generic responses.',
  anxious:    'The customer is anxious or worried. Be reassuring and calming. Emphasize that their concern is being handled and they are not alone. Provide clear next steps.',
  distressed: 'The customer is in distress and may be facing a personal hardship. Be compassionate and warm. Prioritize empathy over process. Show genuine care.',
  confused:   'The customer is confused. Use clear, simple language. Avoid jargon. Confirm understanding step by step.',
  satisfied:  'The customer is satisfied. Keep the response warm and friendly. Reinforce that their concern is handled.',
  neutral:    '',
};

const FOLLOW_UP_INSTRUCTION = `
CONTEXT: The customer already has an OPEN support case being actively reviewed.
They are sending a follow-up — an update, a question, or an emotional reaction.

DO NOT say:
- "We have opened a case" or "A ticket has been created"
- "We have noted your message regarding..."
- "Thank you for your update" as an opener

INSTEAD, respond naturally and empathetically:
- Acknowledge what they just said specifically
- If they are angry ("This is unacceptable"), validate their frustration
  with a sincere apology and affirm that it is being treated as urgent
- If they are asking a question ("Why is this happening?"), explain briefly
  that the team is investigating and will provide answers
- If they are worried, reassure them directly
- Keep it to 2-3 sentences maximum
- Sound like a real human agent, not a system

For high-priority (fraud/unauthorized) cases specifically:
- Emphasize urgency and that a dedicated team is already on it
- Do not minimize their concern
- If they express anger, lead with a sincere apology before reassuring
`.trim();

function buildEmotionInstruction(emotionLabel?: string | null): string {
  if (!emotionLabel) return '';
  return EMOTION_INSTRUCTIONS[emotionLabel] ?? '';
}

function buildSystemPrompt(emotionLabel?: string | null, isFollowUp?: boolean): string {
  const followUpBlock = isFollowUp ? FOLLOW_UP_INSTRUCTION : '';
  const emotionBlock  = buildEmotionInstruction(emotionLabel);
  const basePrompt      = BASE_SYSTEM_PROMPT;
  return [followUpBlock, emotionBlock, basePrompt].filter(Boolean).join('\n\n');
}

export function buildResponseMessages(
  input: ResponseInput,
  extra: {
    hybridInformationalAnswer?: string | null;
    topicSwitched?:             boolean;
    ticketCount?:               number;
    cardBlockOutcome?:          'confirmed' | 'declined' | null;
    emotionLabel?:              string;
    isFollowUp?:                boolean;
    followUpUserMessage?:       string | null;
    followUpEmotionResult?:     EmotionResult | null;
  }
): LLMMessage[] {
  const brief: string[] = [];

  if (extra.isFollowUp === true && extra.followUpUserMessage) {
    brief.push(
      `CUSTOMER'S LATEST MESSAGE (respond to this directly; do not echo internal summaries verbatim):\n` +
      `"${extra.followUpUserMessage.slice(0, 500)}"`
    );
  }

  if (extra.isFollowUp === true && extra.followUpEmotionResult && extra.followUpEmotionResult.label !== 'neutral') {
    brief.push(
      `CUSTOMER EMOTION (soft signal): ${extra.followUpEmotionResult.label}, ` +
      `intensity ${extra.followUpEmotionResult.intensity.toFixed(2)}`
    );
  }

  brief.push(
    `RESPONSE MODE: ${input.response_mode}`,
    `TONE: ${input.tone_profile}`,
    `INTENT SUMMARY: ${input.intent_summary}`,
  );

  if (input.actions_taken.length > 0) {
    brief.push(`ACTIONS TAKEN:\n${input.actions_taken.map(a => `  - ${a}`).join('\n')}`);
  }

  brief.push(`NEXT STEP FOR CUSTOMER: ${input.next_step}`);

  if (extra.cardBlockOutcome === 'confirmed') {
    brief.push('SPECIAL: Customer confirmed the temporary card block. Acknowledge the block is active.');
  } else if (extra.cardBlockOutcome === 'declined') {
    brief.push('SPECIAL: Customer declined the temporary card block. Acknowledge their choice and reassure.');
  } else if (input.card_block_offered) {
    brief.push('SPECIAL: Offer the customer a temporary card block. Ask them to reply YES to confirm or NO to keep the card active.');
  }

  if (input.live_escalation_triggered) {
    brief.push('NOTE: This is a high-priority case flagged for urgent human review. Do not imply a real-time agent connection is happening right now.');
  }

  if (extra.topicSwitched) {
    brief.push('NOTE: This is a new concern separate from any previous case the customer had. Acknowledge that this new concern is being handled separately.');
  }

  if (extra.hybridInformationalAnswer) {
    brief.push(`INFORMATIONAL ANSWER TO INCLUDE: ${extra.hybridInformationalAnswer}`);
    brief.push('NOTE: The customer asked both an informational question and has an operational concern. Address both parts.');
  }

  if (input.clarification_question) {
    brief.push(`CLARIFICATION QUESTION TO ASK: ${input.clarification_question}`);
  }

  if (input.refusal_reason) {
    brief.push(`REFUSAL REASON: ${input.refusal_reason === 'malicious_input' ? 'Suspicious or unsafe request detected' : 'Request is outside our BFSI support scope'}`);
  }

  if (extra.ticketCount && extra.ticketCount > 1) {
    brief.push(`TICKET COUNT: ${extra.ticketCount} separate tickets created, one per concern`);
  }

  const userContent = brief.join('\n') + '\n\nWrite the customer response now (plain text only, no markdown):';

  return [
    {
      role:    'system',
      content: buildSystemPrompt(extra.emotionLabel ?? null, extra.isFollowUp === true),
    },
    { role: 'user', content: userContent },
  ];
}