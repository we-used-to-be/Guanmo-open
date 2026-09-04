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
    // 旧备份缺少成果字段时按空数组兼容
    #[serde(default)]
    artifacts: Vec<ReadingArtifactInput>,
    #[serde(default, rename = "readingReminders")]
    reading_reminders: Vec<ReadingReminderInput>,
    #[serde(default, rename = "readingMarks")]
    reading_marks: Vec<ReadingMarkInput>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingMarkInput {
    id: String,
    document_id: String,
    document_path: String,
    #[serde(rename = "type")]
    mark_type: String,
    anchor: ReadingMarkAnchorInput,
    color: String,
    note: Option<String>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingMarkAnchorInput {
    range: ReadingMarkRangeInput,
    start_offset: i64,
    end_offset: i64,
    quote: String,
    context_before: String,
    context_after: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingMarkRangeInput {
    start_block_id: String,
    start_offset: i64,
    end_block_id: String,
    end_offset: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadingArtifactInput {
    id: String,
    #[serde(rename = "type")]
    artifact_type: String,
    title: String,
    content: String,
    structured_content: Option<String>,
    source_file_path: Option<String>,
    source_file_name: Option<String>,
    source_content_hash: Option<String>,
    source_heading_path: Option<String>,
    source_start_line: Option<i64>,
    source_end_line: Option<i64>,
    source_quote: Option<String>,
    source_message_id: Option<String>,
    source_scope: Option<String>,
    status: Option<String>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadingReminderInput {
    id: String,
    title: String,
    description: Option<String>,
    due_at_utc: i64,
    created_timezone: String,
    status: Option<String>,
    source_artifact_id: Option<String>,
    source_file_path: Option<String>,
    source_message_id: Option<String>,
    notification_id: Option<i64>,
    error_code: Option<String>,
    created_at: i64,
    updated_at: i64,
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
    #[serde(default)]
    artifacts: usize,
    #[serde(default, rename = "readingReminders")]
    reading_reminders: usize,
    #[serde(default, rename = "readingMarks")]
    reading_marks: usize,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoveKnowledgeDocumentResult {
    pub deleted: bool,
    pub document_id: Option<String>,
    pub chunks_deleted: usize,
    pub embedding_jobs_deleted: usize,
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

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingMarkOutput {
    id: String,
    document_id: String,
    document_path: String,
    #[serde(rename = "type")]
    mark_type: String,
    anchor: ReadingMarkAnchorOutput,
    color: String,
    note: Option<String>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingMarkAnchorOutput {
    range: ReadingMarkRangeOutput,
    start_offset: i64,
    end_offset: i64,
    quote: String,
    context_before: String,
    context_after: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingMarkRangeOutput {
    start_block_id: String,
    start_offset: i64,
    end_block_id: String,
    end_offset: i64,
}

fn validate_reading_mark(mark: &ReadingMarkInput) -> Result<(), String> {
    if mark.id.trim().is_empty()
        || mark.document_id.trim().is_empty()
        || mark.document_path.trim().is_empty()
    {
        return Err("批注身份和文档路径不能为空".into());
    }
    if !matches!(mark.mark_type.as_str(), "highlight" | "annotation") {
        return Err("不支持的批注类型".into());
    }
    if !matches!(mark.color.as_str(), "yellow" | "green" | "blue" | "pink") {
        return Err("不支持的批注颜色".into());
    }
    if mark.anchor.quote.is_empty()
        || mark.anchor.start_offset < 0
        || mark.anchor.end_offset <= mark.anchor.start_offset
    {
        return Err("批注锚点 offset 不合法".into());
    }
    if mark.anchor.range.start_offset < 0 || mark.anchor.range.end_offset < 0 {
        return Err("批注块内 offset 不合法".into());
    }
    Ok(())
}

async fn read_reading_mark(
    pool: &SqlitePool,
    id: &str,
) -> Result<Option<ReadingMarkOutput>, String> {
    let row = sqlx::query("SELECT * FROM reading_marks WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|error| error.to_string())?;
    Ok(row.map(|row| ReadingMarkOutput {
        id: row.get("id"),
        document_id: row.get("document_id"),
        document_path: row.get("document_path"),
        mark_type: row.get("type"),
        anchor: ReadingMarkAnchorOutput {
            range: ReadingMarkRangeOutput {
                start_block_id: row.get("start_block_id"),
                start_offset: row.get("start_block_offset"),
                end_block_id: row.get("end_block_id"),
                end_offset: row.get("end_block_offset"),
            },
            start_offset: row.get("start_offset"),
            end_offset: row.get("end_offset"),
            quote: row.get("quote"),
            context_before: row.get("context_before"),
            context_after: row.get("context_after"),
        },
        color: row.get("color"),
        note: row.get("note"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }))
}

async fn upsert_reading_mark_row(
    pool: &SqlitePool,
    mark: ReadingMarkInput,
) -> Result<ReadingMarkOutput, String> {
    validate_reading_mark(&mark)?;
    sqlx::query(
        "INSERT INTO reading_marks (id, document_id, document_path, type, start_block_id, start_block_offset, end_block_id, end_block_offset, start_offset, end_offset, quote, context_before, context_after, color, note, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch() * 1000) \
         ON CONFLICT(id) DO UPDATE SET document_id = excluded.document_id, document_path = excluded.document_path, type = excluded.type, \
         start_block_id = excluded.start_block_id, start_block_offset = excluded.start_block_offset, end_block_id = excluded.end_block_id, end_block_offset = excluded.end_block_offset, \
         start_offset = excluded.start_offset, end_offset = excluded.end_offset, quote = excluded.quote, context_before = excluded.context_before, context_after = excluded.context_after, color = excluded.color, note = excluded.note, updated_at = unixepoch() * 1000",
    )
    .bind(&mark.id)
    .bind(&mark.document_id)
    .bind(&mark.document_path)
    .bind(&mark.mark_type)
    .bind(&mark.anchor.range.start_block_id)
    .bind(mark.anchor.range.start_offset)
    .bind(&mark.anchor.range.end_block_id)
    .bind(mark.anchor.range.end_offset)
    .bind(mark.anchor.start_offset)
    .bind(mark.anchor.end_offset)
    .bind(&mark.anchor.quote)
    .bind(&mark.anchor.context_before)
    .bind(&mark.anchor.context_after)
    .bind(&mark.color)
    .bind(&mark.note)
    .bind(mark.created_at)
    .execute(pool)
    .await
    .map_err(|error| error.to_string())?;
    read_reading_mark(pool, &mark.id)
        .await?
        .ok_or_else(|| "批注写入后无法读取".into())
}

#[tauri::command]
pub async fn upsert_reading_mark(
    app: AppHandle,
    mark: ReadingMarkInput,
) -> Result<ReadingMarkOutput, String> {
    let pool = open_write_pool(database_path(&app)?).await?;
    upsert_reading_mark_row(&pool, mark).await
}

#[tauri::command]
pub async fn get_reading_mark(app: AppHandle, id: String) -> Result<ReadingMarkOutput, String> {
    let pool = open_write_pool(database_path(&app)?).await?;
    read_reading_mark(&pool, &id)
        .await?
        .ok_or_else(|| "找不到批注".into())
}

#[tauri::command]
pub async fn load_reading_marks(
    app: AppHandle,
    document_id: String,
) -> Result<Vec<ReadingMarkOutput>, String> {
    if document_id.trim().is_empty() {
        return Err("文档身份不能为空".into());
    }
    let pool = open_write_pool(database_path(&app)?).await?;
    let rows =
        sqlx::query("SELECT id FROM reading_marks WHERE document_id = ? ORDER BY created_at ASC")
            .bind(document_id)
            .fetch_all(&pool)
            .await
            .map_err(|error| error.to_string())?;
    let mut marks = Vec::with_capacity(rows.len());
    for row in rows {
        let id: String = row.get("id");
        if let Some(mark) = read_reading_mark(&pool, &id).await? {
            marks.push(mark);
        }
    }
    Ok(marks)
}

async fn load_reading_marks_page_rows(
    pool: &SqlitePool,
    limit: i64,
    offset: i64,
) -> Result<Vec<ReadingMarkOutput>, String> {
    let safe_limit = limit.clamp(1, 500);
    let safe_offset = offset.max(0);
    let rows = sqlx::query(
        "SELECT id FROM reading_marks ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?",
    )
    .bind(safe_limit)
    .bind(safe_offset)
    .fetch_all(pool)
    .await
    .map_err(|error| error.to_string())?;
    let mut marks = Vec::with_capacity(rows.len());
    for row in rows {
        let id: String = row.get("id");
        if let Some(mark) = read_reading_mark(pool, &id).await? {
            marks.push(mark);
        }
    }
    Ok(marks)
}

#[tauri::command]
pub async fn load_reading_marks_page(
    app: AppHandle,
    limit: i64,
    offset: i64,
) -> Result<Vec<ReadingMarkOutput>, String> {
    let pool = open_write_pool(database_path(&app)?).await?;
    load_reading_marks_page_rows(&pool, limit, offset).await
}

#[tauri::command]
pub async fn delete_reading_mark(app: AppHandle, id: String) -> Result<(), String> {
    if id.trim().is_empty() {
        return Err("批注 ID 不能为空".into());
    }
    let pool = open_write_pool(database_path(&app)?).await?;
    sqlx::query("DELETE FROM reading_marks WHERE id = ?")
        .bind(id)
        .execute(&pool)
        .await
        .map_err(|error| error.to_string())?;
    Ok(())
}

async fn import_backup_rows(
    transaction: &mut Transaction<'_, Sqlite>,
    payload: BackupPayloadInput,
) -> Result<BackupImportSummary, sqlx::Error> {
    let session_count = payload.sessions.len();
    let memory_count = payload.memories.len();
    let artifact_count = payload.artifacts.len();
    let reading_reminder_count = payload.reading_reminders.len();
    let reading_mark_count = payload.reading_marks.len();
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

    for artifact in &payload.artifacts {
        sqlx::query(
            "INSERT OR REPLACE INTO reading_artifacts (id, type, title, content, structured_content, \
             source_file_path, source_file_name, source_content_hash, source_heading_path, \
             source_start_line, source_end_line, source_quote, source_message_id, source_scope, \
             status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&artifact.id)
        .bind(&artifact.artifact_type)
        .bind(&artifact.title)
        .bind(&artifact.content)
        .bind(&artifact.structured_content)
        .bind(&artifact.source_file_path)
        .bind(&artifact.source_file_name)
        .bind(&artifact.source_content_hash)
        .bind(&artifact.source_heading_path)
        .bind(artifact.source_start_line)
        .bind(artifact.source_end_line)
        .bind(&artifact.source_quote)
        .bind(&artifact.source_message_id)
        .bind(&artifact.source_scope)
        .bind(artifact.status.as_deref().unwrap_or("active"))
        .bind(artifact.created_at)
        .bind(artifact.updated_at)
        .execute(&mut **transaction)
        .await?;
    }

    for reminder in &payload.reading_reminders {
        sqlx::query(
            "INSERT OR REPLACE INTO reading_reminders (id, title, description, due_at_utc, created_timezone, \
             status, source_artifact_id, source_file_path, source_message_id, notification_id, error_code, \
             created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&reminder.id)
        .bind(&reminder.title)
        .bind(&reminder.description)
        .bind(reminder.due_at_utc)
        .bind(&reminder.created_timezone)
        .bind(reminder.status.as_deref().unwrap_or("pending"))
        .bind(&reminder.source_artifact_id)
        .bind(&reminder.source_file_path)
        .bind(&reminder.source_message_id)
        .bind(reminder.notification_id)
        .bind(&reminder.error_code)
        .bind(reminder.created_at)
        .bind(reminder.updated_at)
        .execute(&mut **transaction)
        .await?;
    }

    for mark in &payload.reading_marks {
        validate_reading_mark(mark).map_err(sqlx::Error::Protocol)?;
        sqlx::query(
            "INSERT OR REPLACE INTO reading_marks (id, document_id, document_path, type, start_block_id, start_block_offset, end_block_id, end_block_offset, start_offset, end_offset, quote, context_before, context_after, color, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&mark.id)
        .bind(&mark.document_id)
        .bind(&mark.document_path)
        .bind(&mark.mark_type)
        .bind(&mark.anchor.range.start_block_id)
        .bind(mark.anchor.range.start_offset)
        .bind(&mark.anchor.range.end_block_id)
        .bind(mark.anchor.range.end_offset)
        .bind(mark.anchor.start_offset)
        .bind(mark.anchor.end_offset)
        .bind(&mark.anchor.quote)
        .bind(&mark.anchor.context_before)
        .bind(&mark.anchor.context_after)
        .bind(&mark.color)
        .bind(&mark.note)
        .bind(mark.created_at)
        .bind(mark.updated_at)
        .execute(&mut **transaction)
        .await?;
    }

    Ok(BackupImportSummary {
        sessions: session_count,
        messages: message_count,
        memories: memory_count,
        artifacts: artifact_count,
        reading_reminders: reading_reminder_count,
        reading_marks: reading_mark_count,
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

async fn remove_knowledge_document(
    transaction: &mut Transaction<'_, Sqlite>,
    file_path: &str,
) -> Result<RemoveKnowledgeDocumentResult, sqlx::Error> {
    let doc = sqlx::query("SELECT id FROM documents WHERE file_path = ?")
        .bind(file_path)
        .fetch_optional(&mut **transaction)
        .await?;
    let Some(doc_row) = doc else {
        return Ok(RemoveKnowledgeDocumentResult {
            deleted: false,
            document_id: None,
            chunks_deleted: 0,
            embedding_jobs_deleted: 0,
        });
    };
    let document_id: String = doc_row.try_get("id")?;

    let ej_result = sqlx::query("DELETE FROM embedding_jobs WHERE file_path = ?")
        .bind(file_path)
        .execute(&mut **transaction)
        .await?;
    let embedding_jobs_deleted = ej_result.rows_affected() as usize;

    let doc_result = sqlx::query("DELETE FROM documents WHERE id = ?")
        .bind(&document_id)
        .execute(&mut **transaction)
        .await?;
    let chunks_deleted = doc_result.rows_affected() as usize;

    Ok(RemoveKnowledgeDocumentResult {
        deleted: chunks_deleted > 0,
        document_id: Some(document_id),
        chunks_deleted,
        embedding_jobs_deleted,
    })
}

async fn run_remove_knowledge_document(
    pool: &SqlitePool,
    file_path: String,
) -> Result<RemoveKnowledgeDocumentResult, String> {
    let mut transaction = pool.begin().await.map_err(|error| error.to_string())?;
    let result = remove_knowledge_document(&mut transaction, &file_path)
        .await
        .map_err(|error| error.to_string())?;
    transaction
        .commit()
        .await
        .map_err(|error| error.to_string())?;
    Ok(result)
}

#[tauri::command]
pub async fn remove_knowledge_document_by_path(
    app: AppHandle,
    file_path: String,
) -> Result<RemoveKnowledgeDocumentResult, String> {
    let pool = open_write_pool(database_path(&app)?).await?;
    run_remove_knowledge_document(&pool, file_path).await
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
            "CREATE TABLE reading_artifacts (id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, structured_content TEXT, source_file_path TEXT, source_file_name TEXT, source_content_hash TEXT, source_heading_path TEXT, source_start_line INTEGER, source_end_line INTEGER, source_quote TEXT, source_message_id TEXT, source_scope TEXT, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
            "CREATE TABLE reading_reminders (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, due_at_utc INTEGER NOT NULL, created_timezone TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', source_artifact_id TEXT, source_file_path TEXT, source_message_id TEXT, notification_id INTEGER, error_code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
            "CREATE TABLE reading_marks (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, document_path TEXT NOT NULL, type TEXT NOT NULL, start_block_id TEXT NOT NULL, start_block_offset INTEGER NOT NULL, end_block_id TEXT NOT NULL, end_block_offset INTEGER NOT NULL, start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL, quote TEXT NOT NULL, context_before TEXT NOT NULL, context_after TEXT NOT NULL, color TEXT NOT NULL, note TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
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
            artifacts: Vec::new(),
            reading_reminders: Vec::new(),
            reading_marks: Vec::new(),
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

    fn backup_with_artifact() -> BackupPayloadInput {
        let mut payload = backup_with_messages(&["匿名问题", "匿名回答"]);
        payload.artifacts.push(ReadingArtifactInput {
            id: "artifact-1".into(),
            artifact_type: "summary".into(),
            title: "匿名摘要".into(),
            content: "这是匿名摘要正文".into(),
            structured_content: Some(r#"{"points":["要点A"]}"#.into()),
            source_file_path: Some("C:/anonymous/note.md".into()),
            source_file_name: Some("note.md".into()),
            source_content_hash: Some("hash-1".into()),
            source_heading_path: Some(r#"["章节"]"#.into()),
            source_start_line: Some(2),
            source_end_line: Some(4),
            source_quote: Some("引用快照".into()),
            source_message_id: Some("message-1".into()),
            source_scope: Some("document".into()),
            status: Some("active".into()),
            created_at: 1,
            updated_at: 2,
        });
        payload
    }

    #[tokio::test]
    async fn backup_import_persists_reading_artifacts() {
        let pool = test_pool().await;
        let summary = run_import_backup(&pool, backup_with_artifact())
            .await
            .unwrap();
        assert_eq!(summary.artifacts, 1);
        let (title, structured, scope, status): (String, String, String, String) =
            sqlx::query_as("SELECT title, structured_content, source_scope, status FROM reading_artifacts WHERE id = 'artifact-1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(title, "匿名摘要");
        assert!(structured.contains("要点A"));
        assert_eq!(scope, "document");
        assert_eq!(status, "active");
    }

    #[tokio::test]
    async fn backup_import_persists_reading_reminders() {
        let pool = test_pool().await;
        let mut payload = backup_with_messages(&["匿名问题", "匿名回答"]);
        payload.reading_reminders.push(ReadingReminderInput {
            id: "reminder-1".into(),
            title: "复习章节".into(),
            description: Some("回顾重点".into()),
            due_at_utc: 1_800_000_000_000,
            created_timezone: "Asia/Shanghai".into(),
            status: Some("scheduled".into()),
            source_artifact_id: None,
            source_file_path: None,
            source_message_id: Some("message-1".into()),
            notification_id: Some(42),
            error_code: None,
            created_at: 1,
            updated_at: 2,
        });
        let summary = run_import_backup(&pool, payload).await.unwrap();
        assert_eq!(summary.reading_reminders, 1);
        let (title, timezone, status, notification_id): (String, String, String, i64) =
            sqlx::query_as("SELECT title, created_timezone, status, notification_id FROM reading_reminders WHERE id = 'reminder-1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(title, "复习章节");
        assert_eq!(timezone, "Asia/Shanghai");
        assert_eq!(status, "scheduled");
        assert_eq!(notification_id, 42);
    }

    #[tokio::test]
    async fn reading_mark_upsert_and_backup_round_trip() {
        let pool = test_pool().await;
        let mark = ReadingMarkInput {
            id: "mark-1".into(),
            document_id: "path:c:/anonymous/note.md".into(),
            document_path: "C:/anonymous/note.md".into(),
            mark_type: "annotation".into(),
            anchor: ReadingMarkAnchorInput {
                range: ReadingMarkRangeInput {
                    start_block_id: "pb-1".into(),
                    start_offset: 2,
                    end_block_id: "pb-1".into(),
                    end_offset: 8,
                },
                start_offset: 12,
                end_offset: 18,
                quote: "匿名引用".into(),
                context_before: "前文".into(),
                context_after: "后文".into(),
            },
            color: "pink".into(),
            note: Some("我的批注".into()),
            created_at: 1,
            updated_at: 2,
        };
        let inserted = upsert_reading_mark_row(&pool, mark.clone()).await.unwrap();
        assert_eq!(inserted.id, "mark-1");
        assert_eq!(inserted.anchor.quote, "匿名引用");
        let updated = upsert_reading_mark_row(
            &pool,
            ReadingMarkInput {
                note: Some("更新".into()),
                color: "blue".into(),
                ..mark
            },
        )
        .await
        .unwrap();
        assert_eq!(updated.anchor.quote, "匿名引用");
        assert_eq!(updated.color, "blue");
        assert_eq!(updated.created_at, inserted.created_at);
        sqlx::query("DELETE FROM reading_marks WHERE id = 'mark-1'")
            .execute(&pool)
            .await
            .unwrap();
        assert!(read_reading_mark(&pool, "mark-1").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn reading_mark_page_is_stable_and_clamps_boundaries() {
        let pool = test_pool().await;
        for (id, created_at) in [("mark-b", 2), ("mark-a", 1), ("mark-c", 2)] {
            sqlx::query(
                "INSERT INTO reading_marks (id, document_id, document_path, type, start_block_id, start_block_offset, end_block_id, end_block_offset, start_offset, end_offset, quote, context_before, context_after, color, note, created_at, updated_at) VALUES (?, 'path:c:/anonymous/note.md', 'C:/anonymous/note.md', 'highlight', 'b1', 0, 'b1', 1, 0, 1, 'x', '', '', 'yellow', NULL, ?, ?)",
            )
            .bind(id)
            .bind(created_at)
            .bind(created_at)
            .execute(&pool)
            .await
            .unwrap();
        }

        let first = load_reading_marks_page_rows(&pool, 2, -5).await.unwrap();
        let second = load_reading_marks_page_rows(&pool, 2, 2).await.unwrap();
        assert_eq!(
            first
                .iter()
                .map(|mark| mark.id.as_str())
                .collect::<Vec<_>>(),
            ["mark-a", "mark-b"]
        );
        assert_eq!(
            second
                .iter()
                .map(|mark| mark.id.as_str())
                .collect::<Vec<_>>(),
            ["mark-c"]
        );
    }

    #[tokio::test]
    async fn backup_import_rolls_back_artifact_when_chat_write_fails() {
        let pool = test_pool().await;
        sqlx::query(
            "CREATE TRIGGER reject_artifact_failure BEFORE INSERT ON chat_messages \
             WHEN NEW.content = '触发回滚' BEGIN SELECT RAISE(ABORT, 'forced failure'); END",
        )
        .execute(&pool)
        .await
        .unwrap();
        let mut payload = backup_with_messages(&["先写入", "触发回滚"]);
        payload.artifacts.push(ReadingArtifactInput {
            id: "artifact-rollback".into(),
            artifact_type: "note".into(),
            title: "应回滚的笔记".into(),
            content: "不应留存".into(),
            structured_content: None,
            source_file_path: None,
            source_file_name: None,
            source_content_hash: None,
            source_heading_path: None,
            source_start_line: None,
            source_end_line: None,
            source_quote: None,
            source_message_id: None,
            source_scope: None,
            status: None,
            created_at: 1,
            updated_at: 1,
        });
        assert!(run_import_backup(&pool, payload).await.is_err());
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM reading_artifacts")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
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

    #[tokio::test]
    async fn remove_knowledge_document_deletes_document_chunks_embeddings_and_jobs() {
        let pool = test_pool().await;
        run_persist_document(&pool, document_with_chunks(&["内容 A", "内容 B"]))
            .await
            .unwrap();

        // Verify pre-conditions
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM documents")
                .fetch_one(&pool)
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM chunks")
                .fetch_one(&pool)
                .await
                .unwrap(),
            2
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM embedding_jobs")
                .fetch_one(&pool)
                .await
                .unwrap(),
            1
        );

        let result = run_remove_knowledge_document(&pool, "C:/anonymous/document.md".into())
            .await
            .unwrap();
        assert!(result.deleted);
        assert_eq!(result.chunks_deleted, 1);
        assert_eq!(result.embedding_jobs_deleted, 1);

        // Verify everything is deleted
        for table in ["documents", "chunks", "embeddings", "embedding_jobs"] {
            let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(count, 0, "{table} should be empty after remove");
        }
    }

    #[tokio::test]
    async fn remove_knowledge_document_returns_not_deleted_for_missing_path() {
        let pool = test_pool().await;
        let result = run_remove_knowledge_document(&pool, "nonexistent.md".into())
            .await
            .unwrap();
        assert!(!result.deleted);
        assert_eq!(result.document_id, None);
        assert_eq!(result.chunks_deleted, 0);
        assert_eq!(result.embedding_jobs_deleted, 0);
    }

    #[tokio::test]
    async fn remove_knowledge_document_does_not_affect_other_documents() {
        let pool = test_pool().await;
        let doc_a = document_with_chunks(&["A1"]);
        let mut doc_b = document_with_chunks(&["B1"]);
        doc_b.document.id = "document-2".into();
        doc_b.document.file_path = "C:/anonymous/other.md".into();
        doc_b.document.chunks[0].id = "chunk-other".into();

        run_persist_document(&pool, doc_a).await.unwrap();
        run_persist_document(&pool, doc_b).await.unwrap();

        let result = run_remove_knowledge_document(&pool, "C:/anonymous/document.md".into())
            .await
            .unwrap();
        assert!(result.deleted);

        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM documents")
                .fetch_one(&pool)
                .await
                .unwrap(),
            1
        );
        let remaining_path: String = sqlx::query_scalar("SELECT file_path FROM documents")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(remaining_path, "C:/anonymous/other.md");
    }

    #[tokio::test]
    async fn remove_knowledge_document_rolls_back_on_failure() {
        let pool = test_pool().await;
        run_persist_document(&pool, document_with_chunks(&["内容"]))
            .await
            .unwrap();
        sqlx::query(
            "CREATE TRIGGER reject_remove BEFORE DELETE ON documents \
             BEGIN SELECT RAISE(ABORT, 'forced failure'); END",
        )
        .execute(&pool)
        .await
        .unwrap();

        assert!(
            run_remove_knowledge_document(&pool, "C:/anonymous/document.md".into())
                .await
                .is_err()
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM documents")
                .fetch_one(&pool)
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM embedding_jobs")
                .fetch_one(&pool)
                .await
                .unwrap(),
            1
        );
    }
}
