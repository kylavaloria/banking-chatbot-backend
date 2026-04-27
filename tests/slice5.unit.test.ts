// ─────────────────────────────────────────────────────────────────────────────
// Slice 5 unit tests — RAG pipeline
// No real embedding API calls. Uses stubs/mocks throughout.
// Run: npx vitest run tests/slice5.unit.test.ts
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'path';
import fs   from 'fs';

vi.stubEnv('NODE_ENV',                   'test');
vi.stubEnv('MISTRAL_API_KEY',            'test-key');
vi.stubEnv('GROQ_API_KEY',               'test-key');
vi.stubEnv('GOOGLE_AI_STUDIO_API_KEY',   'test-key');
vi.stubEnv('SUPABASE_URL',               'https://fake.supabase.co');
vi.stubEnv('SUPABASE_ANON_KEY',          'fake-anon');
vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY',  'fake-service');
vi.stubEnv('VECTOR_STORE_PATH',          'data/test-vector-store.db');
vi.stubEnv('KB_DOCS_PATH',              'docs/kb');
vi.stubEnv('RAG_TOP_K',                  '3');
vi.stubEnv('RAG_SIMILARITY_THRESHOLD',   '0.5');
vi.stubEnv('EMBEDDING_MODEL',            'mistral-embed');
vi.stubEnv('RAG_GENERATION_MODEL',       'gemini-2.5-flash-lite-preview-06-17');

// Hoist the Gemini mock so it is available before module imports
const { mockCallGemini } = vi.hoisted(() => ({
  mockCallGemini: vi.fn(),
}));

vi.mock('../src/llm/gemini.client', () => ({
  callGemini: mockCallGemini,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a fake 8-dim embedding based on hash of the text — deterministic */
function fakeEmbed(text: string): number[] {
  const vec = new Array(8).fill(0);
  for (let i = 0; i < text.length; i++) {
    vec[i % 8] += text.charCodeAt(i) / 1000;
  }
  const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return vec.map(v => v / (mag || 1));
}

// ---------------------------------------------------------------------------
// SQLite store tests (no network)
// ---------------------------------------------------------------------------

describe('RAG vector store', () => {
  let store: typeof import('../src/rag/store');

  beforeAll(async () => {
    store = await import('../src/rag/store');
    // Clean slate
    store.deleteChunksByDocId('test-doc-1');
    store.deleteChunksByDocId('test-doc-2');
  });

  afterAll(() => {
    store.closeDB();
    // Remove test DB
    const dbPath = path.resolve('data/test-vector-store.db');
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('upserts a chunk and counts correctly', async () => {
    const before = store.getChunkCount();
    store.upsertChunk(
      { chunk_id: 'test-doc-1__0', doc_id: 'test-doc-1', title: 'Test', category: 'test', text: 'hello world', chunk_index: 0 },
      fakeEmbed('hello world')
    );
    expect(store.getChunkCount()).toBe(before + 1);
  });

  it('retrieves the most similar chunk above threshold', async () => {
    store.upsertChunk(
      { chunk_id: 'test-doc-2__0', doc_id: 'test-doc-2', title: 'Savings', category: 'fee', text: 'savings account minimum balance', chunk_index: 0 },
      fakeEmbed('savings account minimum balance')
    );
    store.upsertChunk(
      { chunk_id: 'test-doc-2__1', doc_id: 'test-doc-2', title: 'Savings', category: 'fee', text: 'credit card annual fee payment', chunk_index: 1 },
      fakeEmbed('credit card annual fee payment')
    );

    const queryEmbed = fakeEmbed('savings account minimum balance');
    const results = store.searchChunks(queryEmbed, 3, 0.0);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].text).toContain('savings');
  });

  it('deleteChunksByDocId removes all chunks for that doc', async () => {
    const before = store.getChunkCount();
    store.deleteChunksByDocId('test-doc-1');
    expect(store.getChunkCount()).toBe(before - 1);
  });

  it('returns no results when threshold is too high', async () => {
    const queryEmbed = fakeEmbed('completely unrelated topic xyz');
    const results = store.searchChunks(queryEmbed, 3, 0.9999);
    expect(results.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Cosine similarity
// ---------------------------------------------------------------------------

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', async () => {
    const { cosineSimilarity } = await import('../src/rag/embeddings');
    const v = [0.5, 0.5, 0.5, 0.5];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it('returns 0 for orthogonal vectors', async () => {
    const { cosineSimilarity } = await import('../src/rag/embeddings');
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
  });

  it('returns 0 for zero vectors', async () => {
    const { cosineSimilarity } = await import('../src/rag/embeddings');
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// JSON extraction
// ---------------------------------------------------------------------------

describe('extractJSON', () => {
  it('parses valid JSON', async () => {
    const { extractJSON } = await import('../src/utils/json-extract');
    expect(extractJSON('{"answer": "yes"}')).toEqual({ answer: 'yes' });
  });
});

// ---------------------------------------------------------------------------
// RAG generator — stub the Gemini call
// ---------------------------------------------------------------------------

describe('RAG generator', () => {
  beforeEach(() => {
    mockCallGemini.mockReset();
  });

  it('returns a fallback answer when no chunks are provided', async () => {
    const { generateRAGAnswer } = await import('../src/rag/generator');
    const result = await generateRAGAnswer('What are your branch hours?', []);
    expect(result.is_fallback).toBe(true);
    expect(result.source_mode).toBe('placeholder');
    expect(result.answer_text.length).toBeGreaterThan(10);
    expect(mockCallGemini).not.toHaveBeenCalled();
  });

  it('calls Gemini and returns a grounded answer when chunks are provided', async () => {
    mockCallGemini.mockResolvedValue({
      text:       'Our branches are open Monday to Friday from 9am to 5pm.',
      model_used: 'gemini-2.5-flash-lite-preview-06-17',
      usage:      { prompt_tokens: 50, completion_tokens: 20 },
    });

    const { generateRAGAnswer } = await import('../src/rag/generator');
    const fakeChunks = [{
      chunk_id:    'branch__0',
      doc_id:      'branch',
      title:       'Branch Hours',
      category:    'branch_or_service_info',
      text:        'Open Monday to Friday 9am to 5pm.',
      chunk_index: 0,
      similarity:  0.88,
    }];

    const result = await generateRAGAnswer('What are your branch hours?', fakeChunks);
    expect(result.source_mode).toBe('rag');
    expect(result.is_fallback).toBe(false);
    expect(result.answer_text).toContain('9am');
    expect(mockCallGemini).toHaveBeenCalledTimes(1);
  });

  it('falls back gracefully when Gemini throws', async () => {
    mockCallGemini.mockRejectedValue(new Error('Network error'));

    const { generateRAGAnswer } = await import('../src/rag/generator');
    const fakeChunks = [{
      chunk_id:    'branch__0',
      doc_id:      'branch',
      title:       'Branch Hours',
      category:    'branch_or_service_info',
      text:        'Open Monday to Friday.',
      chunk_index: 0,
      similarity:  0.88,
    }];

    const result = await generateRAGAnswer('What are your hours?', fakeChunks);
    expect(result.is_fallback).toBe(true);
    expect(result.answer_text.length).toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------------------
// KB docs exist on disk
// ---------------------------------------------------------------------------

describe('Seed KB documents', () => {
  it('finds at least 10 markdown files in docs/kb/', () => {
    const kbPath = path.resolve('docs/kb');
    expect(fs.existsSync(kbPath)).toBe(true);
    const files = fs.readdirSync(kbPath).filter(f => f.endsWith('.md'));
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  it('each KB file contains a title metadata comment', () => {
    const kbPath = path.resolve('docs/kb');
    const files  = fs.readdirSync(kbPath).filter(f => f.endsWith('.md'));
    for (const file of files) {
      const content = fs.readFileSync(path.join(kbPath, file), 'utf-8');
      expect(content).toMatch(/<!--\s*title:/);
    }
  });
});