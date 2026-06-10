/**
 * SQLite database schema for 观墨.
 * These will be used with Tauri's SQLite plugin.
 */

export const DB_SCHEMA = `
-- Documents table
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  file_path TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  last_modified INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Chunks table for RAG
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT,
  chunk_index INTEGER NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  title_path TEXT,
  heading TEXT,
  source_type TEXT NOT NULL DEFAULT 'markdown',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

-- Embeddings table (stored as JSON blob)
CREATE TABLE IF NOT EXISTS embeddings (
  chunk_id TEXT PRIMARY KEY,
  embedding BLOB NOT NULL,
  FOREIGN KEY (chunk_id) REFERENCES chunks(id) ON DELETE CASCADE
);

-- Embedding jobs for automatic RAG queue
CREATE TABLE IF NOT EXISTS embedding_jobs (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'done', 'failed')),
  error TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

-- Chat sessions
CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Chat messages
CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant')),
  content TEXT NOT NULL,
  metadata TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
);

-- Long-term memories
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  source TEXT NOT NULL DEFAULT 'auto_extracted',
  locked INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Application settings (key-value)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_chunks_document_id ON chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_chunks_content_hash ON chunks(content_hash);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session_id ON chat_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
CREATE INDEX IF NOT EXISTS idx_embedding_jobs_status ON embedding_jobs(status);
`

export const DB_MIGRATIONS = [
  {
    table: 'memories',
    column: 'source',
    sql: "ALTER TABLE memories ADD COLUMN source TEXT NOT NULL DEFAULT 'auto_extracted'",
  },
  {
    table: 'memories',
    column: 'locked',
    sql: 'ALTER TABLE memories ADD COLUMN locked INTEGER NOT NULL DEFAULT 0',
  },
  {
    table: 'memories',
    column: 'status',
    sql: "ALTER TABLE memories ADD COLUMN status TEXT NOT NULL DEFAULT 'active'",
  },
  {
    table: 'chat_messages',
    column: 'metadata',
    sql: 'ALTER TABLE chat_messages ADD COLUMN metadata TEXT',
  },
  {
    table: 'chunks',
    column: 'content_hash',
    sql: 'ALTER TABLE chunks ADD COLUMN content_hash TEXT',
  },
  {
    table: 'chunks',
    column: 'title_path',
    sql: 'ALTER TABLE chunks ADD COLUMN title_path TEXT',
  },
  {
    table: 'chunks',
    column: 'heading',
    sql: 'ALTER TABLE chunks ADD COLUMN heading TEXT',
  },
  {
    table: 'chunks',
    column: 'source_type',
    sql: "ALTER TABLE chunks ADD COLUMN source_type TEXT NOT NULL DEFAULT 'markdown'",
  },
  {
    table: 'chunks',
    column: 'created_at',
    sql: 'ALTER TABLE chunks ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0',
  },
  {
    table: 'chunks',
    column: 'updated_at',
    sql: 'ALTER TABLE chunks ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0',
  },
] as const

export const DB_NAME = 'guanmo.db'
