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
  content_hash TEXT,
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
  embedding_model TEXT,
  preprocess_version TEXT,
  input_hash TEXT,
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
  parent_id TEXT,
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
  scope_type TEXT NOT NULL DEFAULT 'global',
  scope_key TEXT,
  subject TEXT,
  fact_key TEXT,
  fact_value TEXT,
  confidence REAL NOT NULL DEFAULT 1,
  evidence TEXT,
  supersedes_id TEXT,
  embedding TEXT,
  embedding_model TEXT,
  content_hash TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Application settings (key-value)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Usage tracking: daily foreground seconds.
CREATE TABLE IF NOT EXISTS usage_daily (
  date TEXT PRIMARY KEY,
  foreground_seconds INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- Lightweight legacy IndexedDB detection state.
-- Stores whether old IndexedDB data was detected and whether user was notified.
CREATE TABLE IF NOT EXISTS legacy_idb_detection (
  id INTEGER PRIMARY KEY DEFAULT 1,
  legacy_detected INTEGER NOT NULL DEFAULT 0,
  user_noticed INTEGER NOT NULL DEFAULT 0,
  detected_at INTEGER,
  noticed_at INTEGER,
  detected_counts TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Structured reading artifacts.
CREATE TABLE IF NOT EXISTS reading_artifacts (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('summary', 'question_set', 'annotation', 'note')),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  structured_content TEXT,
  source_file_path TEXT,
  source_file_name TEXT,
  source_content_hash TEXT,
  source_heading_path TEXT,
  source_start_line INTEGER,
  source_end_line INTEGER,
  source_quote TEXT,
  source_message_id TEXT,
  source_scope TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- One-shot reading reminders. Notification delivery is reconciled from this table.
CREATE TABLE IF NOT EXISTS reading_reminders (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  due_at_utc INTEGER NOT NULL,
  created_timezone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'scheduled', 'fired', 'cancel_pending', 'cancelled', 'failed')),
  source_artifact_id TEXT,
  source_file_path TEXT,
  source_message_id TEXT,
  notification_id INTEGER,
  error_code TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Stable source-anchored reading marks. DOM ranges are never persisted.
CREATE TABLE IF NOT EXISTS reading_marks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  document_path TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('highlight', 'annotation')),
  start_block_id TEXT NOT NULL,
  start_block_offset INTEGER NOT NULL,
  end_block_id TEXT NOT NULL,
  end_block_offset INTEGER NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  quote TEXT NOT NULL,
  context_before TEXT NOT NULL DEFAULT '',
  context_after TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL CHECK (color IN ('yellow', 'green', 'blue', 'pink')),
  note TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK (start_offset >= 0 AND end_offset > start_offset)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_chunks_document_id ON chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_chunks_content_hash ON chunks(content_hash);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session_id ON chat_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_parent_id ON chat_messages(parent_id);
CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
CREATE INDEX IF NOT EXISTS idx_embedding_jobs_status ON embedding_jobs(status);
CREATE INDEX IF NOT EXISTS idx_reading_artifacts_type ON reading_artifacts(type);
CREATE INDEX IF NOT EXISTS idx_reading_artifacts_status ON reading_artifacts(status);
CREATE INDEX IF NOT EXISTS idx_reading_artifacts_source ON reading_artifacts(source_file_path);
CREATE INDEX IF NOT EXISTS idx_reading_reminders_status ON reading_reminders(status);
CREATE INDEX IF NOT EXISTS idx_reading_reminders_due_at ON reading_reminders(due_at_utc);
CREATE INDEX IF NOT EXISTS idx_reading_marks_document_id ON reading_marks(document_id);
`

export const DB_MIGRATIONS = [
  {
    table: 'documents',
    column: 'content_hash',
    sql: 'ALTER TABLE documents ADD COLUMN content_hash TEXT',
  },
  {
    table: 'embeddings',
    column: 'embedding_model',
    sql: 'ALTER TABLE embeddings ADD COLUMN embedding_model TEXT',
  },
  {
    table: 'embeddings',
    column: 'preprocess_version',
    sql: 'ALTER TABLE embeddings ADD COLUMN preprocess_version TEXT',
  },
  {
    table: 'embeddings',
    column: 'input_hash',
    sql: 'ALTER TABLE embeddings ADD COLUMN input_hash TEXT',
  },
  ...[
    ['scope_type', "ALTER TABLE memories ADD COLUMN scope_type TEXT NOT NULL DEFAULT 'global'"],
    ['scope_key', 'ALTER TABLE memories ADD COLUMN scope_key TEXT'],
    ['subject', 'ALTER TABLE memories ADD COLUMN subject TEXT'],
    ['fact_key', 'ALTER TABLE memories ADD COLUMN fact_key TEXT'],
    ['fact_value', 'ALTER TABLE memories ADD COLUMN fact_value TEXT'],
    ['confidence', 'ALTER TABLE memories ADD COLUMN confidence REAL NOT NULL DEFAULT 1'],
    ['evidence', 'ALTER TABLE memories ADD COLUMN evidence TEXT'],
    ['supersedes_id', 'ALTER TABLE memories ADD COLUMN supersedes_id TEXT'],
    ['embedding', 'ALTER TABLE memories ADD COLUMN embedding TEXT'],
    ['embedding_model', 'ALTER TABLE memories ADD COLUMN embedding_model TEXT'],
    ['content_hash', 'ALTER TABLE memories ADD COLUMN content_hash TEXT'],
  ].map(([column, sql]) => ({ table: 'memories', column, sql })),
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
    table: 'chat_messages',
    column: 'parent_id',
    sql: 'ALTER TABLE chat_messages ADD COLUMN parent_id TEXT',
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

export const CURRENT_DB_SCHEMA_VERSION = 2

export const DB_LEGACY_BACKFILL_STATEMENTS = [
  `WITH ordered_messages AS (
     SELECT
       id,
       role,
       LAG(id) OVER (PARTITION BY session_id ORDER BY created_at ASC, rowid ASC) AS previous_id,
       LAG(role) OVER (PARTITION BY session_id ORDER BY created_at ASC, rowid ASC) AS previous_role
     FROM chat_messages
   )
   UPDATE chat_messages
   SET parent_id = (
     SELECT previous_id FROM ordered_messages WHERE ordered_messages.id = chat_messages.id
   )
   WHERE role = 'assistant'
     AND parent_id IS NULL
     AND id IN (
       SELECT id FROM ordered_messages WHERE role = 'assistant' AND previous_role = 'user'
     )`,
] as const

export const DB_POST_MIGRATION_STATEMENTS = [
  `CREATE INDEX IF NOT EXISTS idx_memories_retrieval
   ON memories(status, scope_type, scope_key, category, updated_at DESC)`,
] as const

export const DB_NAME = 'guanmo.db'

export function splitDatabaseSchemaStatements(schema: string): string[] {
  return schema
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean)
}
