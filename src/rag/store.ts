// ─────────────────────────────────────────────────────────────────────────────
// SQLite vector store
// Schema: one table for chunks, one column for the embedding (JSON blob).
// No sqlite-vec extension required — cosine similarity is computed in JS.
// ─────────────────────────────────────────────────────────────────────────────

import Database from 'better-sqlite3';
import path     from 'path';
import fs       from 'fs';
import { env }  from '../config/env';
import type { KBChunk, ScoredChunk } from './types';
import { cosineSimilarity }          from './embeddings';

let _db: Database.Database | null = null;

function getDB(): Database.Database {
  if (_db) return _db;

  const dbPath = path.resolve(env.VECTOR_STORE_PATH);
  const dir    = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      chunk_id    TEXT PRIMARY KEY,
      doc_id      TEXT NOT NULL,
      title       TEXT NOT NULL,
      category    TEXT NOT NULL,
      text        TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      embedding   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_doc_id ON chunks(doc_id);
  `);
  return _db;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export function upsertChunk(chunk: KBChunk, embedding: number[]): void {
  const db = getDB();
  db.prepare(`
    INSERT INTO chunks (chunk_id, doc_id, title, category, text, chunk_index, embedding)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chunk_id) DO UPDATE SET
      text        = excluded.text,
      embedding   = excluded.embedding,
      title       = excluded.title,
      category    = excluded.category,
      chunk_index = excluded.chunk_index
  `).run(
    chunk.chunk_id,
    chunk.doc_id,
    chunk.title,
    chunk.category,
    chunk.text,
    chunk.chunk_index,
    JSON.stringify(embedding)
  );
}

export function deleteChunksByDocId(docId: string): void {
  getDB().prepare('DELETE FROM chunks WHERE doc_id = ?').run(docId);
}

export function getChunkCount(): number {
  const row = getDB().prepare('SELECT COUNT(*) as n FROM chunks').get() as any;
  return row.n as number;
}

// ---------------------------------------------------------------------------
// Read — returns all chunks with their embeddings for similarity scoring
// ---------------------------------------------------------------------------

interface StoredRow {
  chunk_id:    string;
  doc_id:      string;
  title:       string;
  category:    string;
  text:        string;
  chunk_index: number;
  embedding:   string;
}

export function getAllChunks(): Array<{ chunk: KBChunk; embedding: number[] }> {
  const rows = getDB().prepare('SELECT * FROM chunks').all() as StoredRow[];
  return rows.map(row => ({
    chunk: {
      chunk_id:    row.chunk_id,
      doc_id:      row.doc_id,
      title:       row.title,
      category:    row.category,
      text:        row.text,
      chunk_index: row.chunk_index,
    },
    embedding: JSON.parse(row.embedding) as number[],
  }));
}

// ---------------------------------------------------------------------------
// Search — cosine similarity in JS
// ---------------------------------------------------------------------------

export function searchChunks(
  queryEmbedding: number[],
  topK:           number,
  threshold:      number
): ScoredChunk[] {
  const all = getAllChunks();

  const scored = all.map(({ chunk, embedding }) => ({
    ...chunk,
    similarity: cosineSimilarity(queryEmbedding, embedding),
  }));

  return scored
    .filter(c  => c.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topK);
}

export function closeDB(): void {
  if (_db) { _db.close(); _db = null; }
}