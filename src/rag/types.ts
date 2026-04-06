// ─────────────────────────────────────────────────────────────────────────────
// RAG types
// Shared across ingestion, retrieval, and generation.
// ─────────────────────────────────────────────────────────────────────────────

export interface KBDocument {
    /** Unique stable ID derived from the filename */
    doc_id:      string;
    title:       string;
    category:    string;
    last_updated:string;
    source_type: string;
    /** Full raw text of the document */
    content:     string;
    /** Path to the source file */
    file_path:   string;
  }
  
  export interface KBChunk {
    chunk_id:    string;
    doc_id:      string;
    title:       string;
    category:    string;
    /** The text of this chunk */
    text:        string;
    /** Chunk index within the document */
    chunk_index: number;
  }
  
  export interface ScoredChunk extends KBChunk {
    similarity: number;
  }
  
  export interface RetrievalResult {
    chunks:       ScoredChunk[];
    /** True when at least one chunk cleared the similarity threshold */
    has_relevant: boolean;
    /** Best similarity score among returned chunks */
    top_score:    number;
  }
  
  export interface RAGAnswer {
    answer_text:  string;
    source_mode:  'rag' | 'placeholder';
    /** Doc IDs that contributed to the answer */
    source_docs:  string[];
    /** True when the system fell back due to weak retrieval */
    is_fallback:  boolean;
  }