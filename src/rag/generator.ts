// ─────────────────────────────────────────────────────────────────────────────
// RAG answer generator
// Grounds the answer in retrieved KB chunks.
// Uses Groq (llama-3.1-8b) — fast and free-tier friendly for short answers.
// ─────────────────────────────────────────────────────────────────────────────

import { callGemini } from '../llm/gemini.client';
import { env }         from '../config/env';
import type { ScoredChunk, RAGAnswer } from './types';

const FALLBACK_ANSWER =
  'I have some information on that topic, but I want to make sure I give you accurate details. ' +
  'For the most up-to-date policy information, please contact our support team directly or visit your nearest branch.';

const SYSTEM_PROMPT = `You are a BFSI customer support information assistant.
Answer the customer's question using ONLY the information provided in the knowledge base excerpts below.

Rules:
- Be concise and direct — 2 to 4 sentences maximum
- If the excerpts do not clearly answer the question, say so honestly and suggest contacting support
- Do not invent fees, timelines, or policies not present in the excerpts
- Do not mention that you are using excerpts or a knowledge base
- Use a helpful, professional tone
- Do not include internal document titles or IDs in your response`;

export async function generateRAGAnswer(
  query:  string,
  chunks: ScoredChunk[]
): Promise<RAGAnswer> {
  if (chunks.length === 0) {
    return {
      answer_text: FALLBACK_ANSWER,
      source_mode: 'placeholder',
      source_docs: [],
      is_fallback: true,
    };
  }

  const context = chunks
    .map((c, i) => `[${i + 1}] ${c.title}\n${c.text}`)
    .join('\n\n');

  const userContent = `Knowledge base excerpts:\n${context}\n\nCustomer question: ${query}\n\nAnswer:`;

  try {
    const response = await callGemini({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: userContent },
      ],
      model:       env.RAG_GENERATION_MODEL,
      temperature: 0.2,
      maxTokens:   300,
    });

    const text = response.text.trim();
    if (!text || text.length < 10) {
      throw new Error('Empty response from generator');
    }

    return {
      answer_text: text,
      source_mode: 'rag',
      source_docs: [...new Set(chunks.map(c => c.doc_id))],
      is_fallback: false,
    };
  } catch (err) {
    console.warn('[RAG] Generation failed — using fallback', err instanceof Error ? err.message : err);
    return {
      answer_text: FALLBACK_ANSWER,
      source_mode: 'placeholder',
      source_docs: [],
      is_fallback: true,
    };
  }
}