// ─────────────────────────────────────────────────────────────────────────────
// RAG public API
// Single entry point for the orchestrator.
// ─────────────────────────────────────────────────────────────────────────────

import { retrieve }          from './retrieval';
import { generateRAGAnswer } from './generator';
import type { RAGAnswer }    from './types';

export type { RAGAnswer, KBChunk, ScoredChunk, RetrievalResult } from './types';

/**
 * Answers an informational BFSI query using the knowledge base.
 * Safe to call for any informational intent — falls back gracefully.
 *
 * This must NEVER be called for operational intents.
 * The orchestrator enforces this boundary.
 */
export async function answerInformational(query: string): Promise<RAGAnswer> {
  const retrieval = await retrieve(query);
  return generateRAGAnswer(query, retrieval.chunks);
}