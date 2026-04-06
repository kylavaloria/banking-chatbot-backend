// ─────────────────────────────────────────────────────────────────────────────
// Retrieval pipeline
// Embeds the query and searches the vector store.
// ─────────────────────────────────────────────────────────────────────────────

import { embed }        from './embeddings';
import { searchChunks } from './store';
import { env }          from '../config/env';
import type { RetrievalResult } from './types';

export async function retrieve(query: string): Promise<RetrievalResult> {
  const topK      = parseInt(env.RAG_TOP_K, 10) || 4;
  const threshold = parseFloat(env.RAG_SIMILARITY_THRESHOLD) || 0.55;

  let queryEmbedding: number[];
  try {
    queryEmbedding = await embed(query);
  } catch (err) {
    console.warn('[RAG] Embedding failed — returning empty retrieval', err instanceof Error ? err.message : err);
    return { chunks: [], has_relevant: false, top_score: 0 };
  }

  const chunks = searchChunks(queryEmbedding, topK, threshold);

  return {
    chunks,
    has_relevant: chunks.length > 0,
    top_score:    chunks[0]?.similarity ?? 0,
  };
}