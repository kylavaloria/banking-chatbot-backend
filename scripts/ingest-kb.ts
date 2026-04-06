// ─────────────────────────────────────────────────────────────────────────────
// KB ingestion script
// Run once (or whenever KB docs change):
//   npx ts-node scripts/ingest-kb.ts
// ─────────────────────────────────────────────────────────────────────────────

import fs   from 'fs';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config();

import { env }          from '../src/config/env';
import { embedBatch }   from '../src/rag/embeddings';
import { upsertChunk, deleteChunksByDocId, getChunkCount } from '../src/rag/store';
import type { KBChunk } from '../src/rag/types';

// ---------------------------------------------------------------------------
// Document parsing
// Reads markdown files and extracts frontmatter-style metadata from
// the first few lines (lines starting with <!-- key: value -->).
// ---------------------------------------------------------------------------

interface ParsedDoc {
  doc_id:      string;
  title:       string;
  category:    string;
  last_updated:string;
  source_type: string;
  content:     string;
  file_path:   string;
}

function parseDoc(filePath: string): ParsedDoc {
  const raw     = fs.readFileSync(filePath, 'utf-8');
  const docId   = path.basename(filePath, path.extname(filePath));

  // Extract HTML comment metadata: <!-- key: value -->
  const meta: Record<string, string> = {};
  const metaRegex = /<!--\s*([\w_]+):\s*(.+?)\s*-->/g;
  let match: RegExpExecArray | null;
  while ((match = metaRegex.exec(raw)) !== null) {
    meta[match[1]] = match[2];
  }

  // Strip metadata comments from content
  const content = raw.replace(/<!--.*?-->/gs, '').trim();

  return {
    doc_id:       docId,
    title:        meta['title']        ?? docId.replace(/-/g, ' '),
    category:     meta['category']     ?? 'general',
    last_updated: meta['last_updated'] ?? '2025-01-01',
    source_type:  meta['source_type']  ?? 'kb_seed',
    content,
    file_path:    filePath,
  };
}

// ---------------------------------------------------------------------------
// Chunking — paragraph-based with max length guard
// ---------------------------------------------------------------------------

const MAX_CHUNK_CHARS = 800;
const OVERLAP_CHARS   = 80;

function chunkText(text: string): string[] {
  // Split on double newlines (paragraphs)
  const paragraphs = text.split(/\n\n+/).map(p => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    if ((current + '\n\n' + para).length > MAX_CHUNK_CHARS && current) {
      chunks.push(current.trim());
      // Keep a small overlap from the end of the previous chunk
      current = current.slice(-OVERLAP_CHARS) + '\n\n' + para;
    } else {
      current = current ? current + '\n\n' + para : para;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

// ---------------------------------------------------------------------------
// Main ingestion
// ---------------------------------------------------------------------------

async function ingest(): Promise<void> {
  const docsPath = path.resolve(env.KB_DOCS_PATH);
  if (!fs.existsSync(docsPath)) {
    console.error(`KB docs path not found: ${docsPath}`);
    process.exit(1);
  }

  const files = fs.readdirSync(docsPath)
    .filter(f => f.endsWith('.md') || f.endsWith('.txt'))
    .map(f => path.join(docsPath, f));

  if (files.length === 0) {
    console.error('No .md or .txt files found in KB docs path.');
    process.exit(1);
  }

  console.log(`Found ${files.length} KB document(s). Starting ingestion...`);

  for (const filePath of files) {
    const doc    = parseDoc(filePath);
    const chunks = chunkText(doc.content);

    console.log(`  [${doc.doc_id}] "${doc.title}" → ${chunks.length} chunk(s)`);

    // Remove old chunks for this doc before re-ingesting
    deleteChunksByDocId(doc.doc_id);

    // Build chunk objects
    const kbChunks: KBChunk[] = chunks.map((text, i) => ({
      chunk_id:    `${doc.doc_id}__${i}`,
      doc_id:      doc.doc_id,
      title:       doc.title,
      category:    doc.category,
      text,
      chunk_index: i,
    }));

    // Embed in one batch call per document
    const texts      = kbChunks.map(c => `${doc.title}\n\n${c.text}`);
    const embeddings = await embedBatch(texts);

    for (let i = 0; i < kbChunks.length; i++) {
      upsertChunk(kbChunks[i], embeddings[i]);
    }
  }

  const total = getChunkCount();
  console.log(`\nIngestion complete. Total chunks in store: ${total}`);
}

ingest().catch(err => {
  console.error('Ingestion failed:', err);
  process.exit(1);
});