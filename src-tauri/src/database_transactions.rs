use serde::{Deserialize, Serialize};
use sqlx::{
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    Row, Sqlite, SqlitePool, Transaction,
};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistDocumentRequest {
    document: DocumentInput,
    enqueue_embedding_job: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DocumentInput {
    id: String,
    file_path: String,
    title: String,
    content: String,
    content_hash: Option<String>,
    last_modified: i64,
    chunks: Vec<ChunkInput>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChunkInput {
    id: String,
    content: String,
    content_hash: Option<String>,
    index: i64,
    start_line: i64,
    end_line: i64,
    title_path: Option<Vec<String>>,
    heading: Option<String>,
    source_type: Option<String>,
    embedding: Option<Vec<f64>>,
    embedding_model: Option<String>,
    embedding_preprocess_version: Option<String>,
    embedding_input_hash: Option<String>,
    created_at: Option<i64>,
    updated_at: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct BackupPayloadInput {
    version: u32,
    sessions: Vec<BackupSessionInput>,
    memories: Vec<MemoryInput>,
}

#[derive(Clone, Debug, Deserialize)]
struct BackupSessionInput {
    session: ChatSessionInput,
    messages: Vec<ChatMessageInput>,
}

#[derive(Clone, Debug, Deserialize)]
struct ChatSessionInput {
    id: String,
    title: String,
    created_at: i64,
    updated_at: i64,
}

#[derive(Clone, Debug, Deserialize)]
struct ChatMessageInput {
    id: String,
    #[serde(rename = "session_id")]
    _session_id: String,
    parent_id: Option<String>,
    role: String,
    content: String,
    created_at: i64,
    metadata: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemoryInput {
    id: String,
    content: String,
    category: String,
    source: Option<String>,
    locked: Option<bool>,
    status: Option<String>,
    scope_type: Option<String>,
    scope_key: Option<String>,
    subject: Option<String>,
    fact_key: Option<String>,
    fact_value: Option<String>,
    confidence: Option<f64>,
    evidence: Option<String>,
    supersedes_id: Option<String>,
    embedding: Option<Vec<f64>>,
    embedding_model: Option<String>,
    content_hash: Option<String>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct BackupImportSummary {
    sessions: usize,
    messages: usize,
    memories: usize,
}

fn database_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|path| path.join("guanmo.db"))
        .map_err(|error| error.to_string())
}

async fn open_write_pool(path: PathBuf) -> Result<SqlitePool, String> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(false)
        .foreign_keys(true);
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(|error| error.to_string())
}

async fn persist_document(
    transaction: &mut Transaction<'_, Sqlite>,
    request: PersistDocumentRequest,
) -> Result<(), sqlx::Error> {
    let document = request.document;
    let conflicting_ids =
        sqlx::query("SELECT id FROM documents WHERE (file_path = ? OR id = ?) AND id <> ?")
            .bind(&document.file_path)
            .bind(&document.id)
            .bind(&document.id)
            .fetch_all(&mut **transaction)
            .await?;
    for row in conflicting_ids {
        let id: String = row.try_get("id")?;
        sqlx::query("DELETE FROM documents WHERE id = ?")
            .bind(id)
            .execute(&mut **transaction)
            .await?;
    }

    sqlx::query(
        "INSERT INTO documents (id, file_path, title, content, content_hash, last_modified, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM documents WHERE id = ?), unixepoch())) \
         ON CONFLICT(id) DO UPDATE SET file_path = excluded.file_path, title = excluded.title, \
         content = excluded.content, content_hash = excluded.content_hash, last_modified = excluded.last_modified",
    )
    .bind(&document.id)
    .bind(&document.file_path)
    .bind(&document.title)
    .bind(&document.content)
    .bind(&document.content_hash)
    .bind(document.last_modified)
    .bind(&document.id)
    .execute(&mut **transaction)
    .await?;

    let existing_chunks = sqlx::query("SELECT id FROM chunks WHERE document_id = ?")
        .bind(&document.id)
        .fetch_all(&mut **transaction)
        .await?;
    let next_ids: std::collections::HashSet<&str> = document
        .chunks
        .iter()
        .map(|chunk| chunk.id.as_str())
        .collect();
    for row in existing_chunks {
        let id: String = row.try_get("id")?;
        if !next_ids.contains(id.as_str()) {
            sqlx::query("DELETE FROM chunks WHERE id = ?")
                .bind(id)
                .execute(&mut **transaction)
                .await?;
        }
    }

    let now = chrono_timestamp_millis();
    for chunk in document.chunks {
        let title_path = chunk
            .title_path
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|error| sqlx::Error::Encode(Box::new(error)))?;
        sqlx::query(
            "INSERT INTO chunks (id, document_id, content, content_hash, chunk_index, start_line, end_line, \
             title_path, heading, source_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \
             COALESCE((SELECT created_at FROM chunks WHERE id = ?), ?), ?) \
             ON CONFLICT(id) DO UPDATE SET document_id = excluded.document_id, content = excluded.content, \
             content_hash = excluded.content_hash, chunk_index = excluded.chunk_index, start_line = excluded.start_line, \
             end_line = excluded.end_line, title_path = excluded.title_path, heading = excluded.heading, \
             source_type = excluded.source_type, updated_at = excluded.updated_at",
        )
        .bind(&chunk.id)
        .bind(&document.id)
        .bind(&chunk.content)
        .bind(&chunk.content_hash)
        .bind(chunk.index)
        .bind(chunk.start_line)
        .bind(chunk.end_line)
        .bind(title_path)
        .bind(&chunk.heading)
        .bind(chunk.source_type.as_deref().unwrap_or("markdown"))
        .bind(&chunk.id)
        .bind(chunk.created_at.unwrap_or(now))
        .bind(chunk.updated_at.unwrap_or(now))
        .execute(&mut **transaction)
        .await?;

        if let Some(embedding) = chunk.embedding {
            let embedding = serde_json::to_string(&embedding)
                .map_err(|error| sqlx::Error::Encode(Box::new(error)))?;
            sqlx::query(
                "INSERT INTO embeddings (chunk_id, embedding, embedding_model, preprocess_version, input_hash) \
                 VALUES (?, ?, ?, ?, ?) ON CONFLICT(chunk_id) DO UPDATE SET embedding = excluded.embedding, \
                 embedding_model = excluded.embedding_model, preprocess_version = excluded.preprocess_version, \
                 input_hash = excluded.input_hash",
            )
            .bind(&chunk.id)
            .bind(embedding)
            .bind(&chunk.embedding_model)
            .bind(&chunk.embedding_preprocess_version)
            .bind(&chunk.embedding_input_hash)
            .execute(&mut **transaction)
            .await?;
        } else {
            sqlx::query("DELETE FROM embeddings WHERE chunk_id = ?")
                .bind(&chunk.id)
                .execute(&mut **transaction)
                .await?;
        }
    }

    if let Some(enqueue) = request.enqueue_embedding_job {
        sqlx::query("DELETE FROM embedding_jobs WHERE file_path = ?")
            .bind(&document.file_path)
            .execute(&mut **transaction)
            .await?;
        if enqueue {
            sqlx::query(
                "INSERT INTO embedding_jobs (id, document_id, file_path, status, error, retry_count, created_at, updated_at) \
                 VALUES (?, ?, ?, 'pending', NULL, 0, unixepoch(), unixepoch())",
            )
            .bind(format!("job-{}", document.id))
            .bind(&document.id)
            .bind(&document.file_path)
            .execute(&mut **transaction)
            .await?;
        }
    }
    Ok(())
}

fn chrono_timestamp_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

async fn run_persist_document(
    pool: &SqlitePool,
    request: PersistDocumentRequest,
) -> Result<(), String> {
    let mut transaction = pool.begin().await.map_err(|error| error.to_string())?;
    persist_document(&mut transaction, request)
        .await
        .map_err(|error| error.to_string())?;
    transaction
        .commit()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn persist_document_transaction(
    app: AppHandle,
    request: PersistDocumentRequest,
) -> Result<(), String> {
    let pool = open_write_pool(database_path(&app)?).await?;
    run_persist_document(&pool, request).await
}

async fn run_confirm_memory_candidate(pool: &SqlitePool, id: &str) -> Result<bool, String> {
    let mut transaction = pool.begin().await.map_err(|error| error.to_string())?;
    let candidate =
        sqlx::query("SELECT supersedes_id FROM memories WHERE id = ? AND status = 'candidate'")
            .bind(id)
            .fetch_optional(&mut *transaction)
            .await
            .map_err(|error| error.to_string())?;
    let Some(candidate) = candidate else {
        transaction
            .rollback()
            .await
            .map_err(|error| error.to_string())?;
        return Ok(false);
    };
    let supersedes_id: Option<String> = candidate
        .try_get("supersedes_id")
        .map_err(|error| error.to_string())?;
    if let Some(supersedes_id) = supersedes_id {
        sqlx::query(
            "UPDATE memories SET status = 'superseded', updated_at = unixepoch() * 1000 \
             WHERE id = ? AND status = 'active'",
        )
        .bind(supersedes_id)
        .execute(&mut *transaction)
        .await
        .map_err(|error| error.to_string())?;
    }
    let result = sqlx::query(
        "UPDATE memories SET status = 'active', source = 'user_explicit', \
         updated_at = unixepoch() * 1000 WHERE id = ? AND status = 'candidate'",
    )
    .bind(id)
    .execute(&mut *transaction)
    .await
    .map_err(|error| error.to_string())?;
    transaction
        .commit()
        .await
        .map_err(|error| error.to_string())?;
    Ok(result.rows_affected() > 0)
}

#[tauri::command]
pub async fn confirm_memory_candidate_transaction(
    app: AppHandle,
    id: String,
) -> Result<bool, String> {
    let pool = open_write_pool(database_path(&app)?).await?;
    run_confirm_memory_candidate(&pool, &id).await
}

async fn import_backup_rows(
    transaction: &mut Transaction<'_, Sqlite>,
    payload: BackupPayloadInput,
) -> Result<BackupImportSummary, sqlx::Error> {
    let session_count = payload.sessions.len();
    let memory_count = payload.memories.len();
    let mut message_count = 0;
    for item in payload.sessions {
        sqlx::query(
            "INSERT INTO chat_sessions (id, title, created_at, updated_at) VALUES (?, ?, \
             COALESCE((SELECT created_at FROM chat_sessions WHERE id = ?), ?), ?) \
             ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at",
        )
        .bind(&item.session.id)
        .bind(&item.session.title)
        .bind(&item.session.id)
        .bind(item.session.created_at)
        .bind(item.session.updated_at)
        .execute(&mut **transaction)
        .await?;

        let mut previous_message: Option<&ChatMessageInput> = None;
        for message in &item.messages {
            let parent_id = message.parent_id.as_deref().or_else(|| {
                previous_message
                    .filter(|previous| message.role == "assistant" && previous.role == "user")
                    .map(|previous| previous.id.as_str())
            });
            sqlx::query(
                "INSERT INTO chat_messages (id, session_id, parent_id, role, content, metadata, created_at) \
                 VALUES (?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM chat_messages WHERE id = ?), ?)) \
                 ON CONFLICT(id) DO UPDATE SET session_id = excluded.session_id, parent_id = excluded.parent_id, \
                 role = excluded.role, content = excluded.content, metadata = excluded.metadata",
            )
            .bind(&message.id)
            .bind(&item.session.id)
            .bind(parent_id)
            .bind(&message.role)
            .bind(&message.content)
            .bind(&message.metadata)
            .bind(&message.id)
            .bind(message.created_at)
            .execute(&mut **transaction)
            .await?;
            message_count += 1;
            previous_message = Some(message);
        }
    }

    for memory in &payload.memories {
        let embedding = memory
            .embedding
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|error| sqlx::Error::Encode(Box::new(error)))?;
        sqlx::query(
            "INSERT OR REPLACE INTO memories (id, content, category, source, locked, status, scope_type, scope_key, \
             subject, fact_key, fact_value, confidence, evidence, supersedes_id, embedding, embedding_model, \
             content_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&memory.id)
        .bind(&memory.content)
        .bind(&memory.category)
        .bind(memory.source.as_deref().unwrap_or("auto_extracted"))
        .bind(memory.locked.unwrap_or(false))
        .bind(memory.status.as_deref().unwrap_or("active"))
        .bind(memory.scope_type.as_deref().unwrap_or("global"))
        .bind(&memory.scope_key)
        .bind(&memory.subject)
        .bind(&memory.fact_key)
        .bind(&memory.fact_value)
        .bind(memory.confidence.unwrap_or(1.0))
        .bind(&memory.evidence)
        .bind(&memory.supersedes_id)
        .bind(embedding)
        .bind(&memory.embedding_model)
        .bind(&memory.content_hash)
        .bind(memory.created_at)
        .bind(memory.updated_at)
        .execute(&mut **transaction)
        .await?;
    }

    Ok(BackupImportSummary {
        sessions: session_count,
        messages: message_count,
        memories: memory_count,
    })
}

async fn run_import_backup(
    pool: &SqlitePool,
    payload: BackupPayloadInput,
) -> Result<BackupImportSummary, String> {
    if payload.version != 1 {
        return Err(format!("不支持的备份版本：{}", payload.version));
    }
    let mut transaction = pool.begin().await.map_err(|error| error.to_string())?;
    let summary = import_backup_rows(&mut transaction, payload)
        .await
        .map_err(|error| error.to_string())?;
    transaction
        .commit()
        .await
        .map_err(|error| error.to_string())?;
    Ok(summary)
}

#[tauri::command]
pub async fn import_backup_transaction(
    app: AppHandle,
    payload: BackupPayloadInput,
) -> Result<BackupImportSummary, String> {
    let pool = open_write_pool(database_path(&app)?).await?;
    run_import_backup(&pool, payload).await
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("PRAGMA foreign_keys = ON")
            .execute(&pool)
            .await
            .unwrap();
        for statement in [
            "CREATE TABLE documents (id TEXT PRIMARY KEY, file_path TEXT NOT NULL UNIQUE, title TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT, last_modified INTEGER NOT NULL, created_at INTEGER NOT NULL)",
            "CREATE TABLE chunks (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT, chunk_index INTEGER NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, title_path TEXT, heading TEXT, source_type TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE)",
            "CREATE TABLE embeddings (chunk_id TEXT PRIMARY KEY, embedding TEXT NOT NULL, embedding_model TEXT, preprocess_version TEXT, input_hash TEXT, FOREIGN KEY (chunk_id) REFERENCES chunks(id) ON DELETE CASCADE)",
            "CREATE TABLE embedding_jobs (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, file_path TEXT NOT NULL, status TEXT NOT NULL, error TEXT, retry_count INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE)",
            "CREATE TABLE chat_sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
            "CREATE TABLE chat_messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, parent_id TEXT, role TEXT NOT NULL, content TEXT NOT NULL, metadata TEXT, created_at INTEGER NOT NULL, FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE)",
            "CREATE TABLE memories (id TEXT PRIMARY KEY, content TEXT NOT NULL, category TEXT NOT NULL, source TEXT NOT NULL, locked INTEGER NOT NULL, status TEXT NOT NULL, scope_type TEXT NOT NULL, scope_key TEXT, subject TEXT, fact_key TEXT, fact_value TEXT, confidence REAL NOT NULL, evidence TEXT, supersedes_id TEXT, embedding TEXT, embedding_model TEXT, content_hash TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
        ] {
            sqlx::query(statement).execute(&pool).await.unwrap();
        }
        pool
    }

    fn document_with_chunks(contents: &[&str]) -> PersistDocumentRequest {
        PersistDocumentRequest {
            document: DocumentInput {
                id: "document-1".into(),
                file_path: "C:/anonymous/document.md".into(),
                title: "匿名文档".into(),
                content: contents.join("\n"),
                content_hash: Some("hash".into()),
                last_modified: 1,
                chunks: contents
                    .iter()
                    .enumerate()
                    .map(|(index, content)| ChunkInput {
                        id: format!("chunk-{index}"),
                        content: (*content).into(),
                        content_hash: None,
                        index: index as i64,
                        start_line: index as i64 + 1,
                        end_line: index as i64 + 1,
                        title_path: None,
                        heading: None,
                        source_type: Some("markdown".into()),
                        embedding: None,
                        embedding_model: None,
                        embedding_preprocess_version: None,
                        embedding_input_hash: None,
                        created_at: Some(1),
                        updated_at: Some(1),
                    })
                    .collect(),
            },
            enqueue_embedding_job: Some(true),
        }
    }

    fn backup_with_messages(contents: &[&str]) -> BackupPayloadInput {
        BackupPayloadInput {
            version: 1,
            sessions: vec![BackupSessionInput {
                session: ChatSessionInput {
                    id: "session-1".into(),
                    title: "匿名会话".into(),
                    created_at: 1,
                    updated_at: 2,
                },
                messages: contents
                    .iter()
                    .enumerate()
                    .map(|(index, content)| ChatMessageInput {
                        id: format!("message-{index}"),
                        _session_id: "session-1".into(),
                        parent_id: None,
                        role: if index % 2 == 0 { "user" } else { "assistant" }.into(),
                        content: (*content).into(),
                        created_at: index as i64,
                        metadata: None,
                    })
                    .collect(),
            }],
            memories: Vec::new(),
        }
    }

    #[tokio::test]
    async fn backup_import_rolls_back_everything_when_a_late_write_fails() {
        let pool = test_pool().await;
        sqlx::query(
            "CREATE TRIGGER reject_failure_message BEFORE INSERT ON chat_messages \
             WHEN NEW.content = '触发回滚' BEGIN SELECT RAISE(ABORT, 'forced failure'); END",
        )
        .execute(&pool)
        .await
        .unwrap();

        assert!(
            run_import_backup(&pool, backup_with_messages(&["先写入", "触发回滚"]))
                .await
                .is_err()
        );
        let session_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM chat_sessions")
            .fetch_one(&pool)
            .await
            .unwrap();
        let message_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM chat_messages")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(session_count, 0);
        assert_eq!(message_count, 0);
    }

    #[tokio::test]
    async fn backup_import_preserves_parent_compatibility_for_old_records() {
        let pool = test_pool().await;
        let summary = run_import_backup(&pool, backup_with_messages(&["问题", "回答"]))
            .await
            .unwrap();
        let parent_id: Option<String> =
            sqlx::query_scalar("SELECT parent_id FROM chat_messages WHERE id = 'message-1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(summary.messages, 2);
        assert_eq!(parent_id.as_deref(), Some("message-0"));
    }

    #[tokio::test]
    async fn document_persistence_rolls_back_document_chunks_and_job_together() {
        let pool = test_pool().await;
        sqlx::query(
            "CREATE TRIGGER reject_failure_chunk BEFORE INSERT ON chunks \
             WHEN NEW.content = '触发回滚' BEGIN SELECT RAISE(ABORT, 'forced failure'); END",
        )
        .execute(&pool)
        .await
        .unwrap();

        assert!(
            run_persist_document(&pool, document_with_chunks(&["先写入", "触发回滚"]),)
                .await
                .is_err()
        );
        for table in ["documents", "chunks", "embedding_jobs"] {
            let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(count, 0, "{table} should roll back");
        }
    }

    #[tokio::test]
    async fn candidate_confirmation_rolls_back_superseded_memory_when_activation_fails() {
        let pool = test_pool().await;
        for (id, status, supersedes_id) in [
            ("active-1", "active", None),
            ("candidate-1", "candidate", Some("active-1")),
        ] {
            sqlx::query(
                "INSERT INTO memories (id, content, category, source, locked, status, scope_type, confidence, supersedes_id, created_at, updated_at) \
                 VALUES (?, '匿名内容', 'general', 'auto_extracted', 0, ?, 'global', 1, ?, 1, 1)",
            )
            .bind(id)
            .bind(status)
            .bind(supersedes_id)
            .execute(&pool)
            .await
            .unwrap();
        }
        sqlx::query(
            "CREATE TRIGGER reject_candidate_activation BEFORE UPDATE ON memories \
             WHEN OLD.id = 'candidate-1' BEGIN SELECT RAISE(ABORT, 'forced failure'); END",
        )
        .execute(&pool)
        .await
        .unwrap();

        assert!(run_confirm_memory_candidate(&pool, "candidate-1")
            .await
            .is_err());
        let active_status: String =
            sqlx::query_scalar("SELECT status FROM memories WHERE id = 'active-1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(active_status, "active");
    }
}
