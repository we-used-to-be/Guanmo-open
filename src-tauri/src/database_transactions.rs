use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    Row, Sqlite, SqlitePool, Transaction,
};
use std::{collections::HashMap, path::PathBuf};
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
    #[serde(default, rename = "artifactCategories")]
    artifact_categories: Vec<ArtifactCategoryInput>,
    #[serde(default, rename = "artifactOrganization")]
    artifact_organization: Vec<ArtifactOrganizationInput>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ArtifactCategoryInput {
    id: String,
    name: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactOrganizationInput {
    artifact_key: String,
    favorite: bool,
    category_ids: Vec<String>,
}

fn validate_category(category: &ArtifactCategoryInput) -> Result<(), String> {
    if category.id.trim().is_empty()
        || category.name.trim().is_empty()
        || category.name.trim().chars().count() > 40
    {
        return Err("分类名称须为 1–40 个字符".into());
    }
    Ok(())
}

async fn write_artifact_organization(
    transaction: &mut Transaction<'_, Sqlite>,
    key: &str,
    favorite: Option<bool>,
    category_ids: Option<&[String]>,
) -> Result<(), String> {
    let (table, id) = match key.split_once(':') {
        Some(("mark", id)) if !id.is_empty() => ("reading_marks", id),
        Some(("ai", id)) if !id.is_empty() => ("reading_artifacts", id),
        _ => return Err("无效的阅读成果标识".into()),
    };
    let exists: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table} WHERE id = ?"))
        .bind(id)
        .fetch_one(&mut **transaction)
        .await
        .map_err(|error| error.to_string())?;
    if exists == 0 {
        return Err("阅读成果已不存在".into());
    }
    if let Some(ids) = category_ids {
        for category_id in ids {
            let exists: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM reading_artifact_categories WHERE id = ?")
                    .bind(category_id)
                    .fetch_one(&mut **transaction)
                    .await
                    .map_err(|error| error.to_string())?;
            if exists == 0 {
                return Err("分类已不存在，请重新选择".into());
            }
        }
    }
    let categories = category_ids
        .map(serde_json::to_string)
        .transpose()
        .map_err(|error| error.to_string())?;
    sqlx::query(
        "INSERT INTO reading_artifact_organization (artifact_key, favorite, category_ids) VALUES (?, COALESCE(?, 0), COALESCE(?, '[]')) \
         ON CONFLICT(artifact_key) DO UPDATE SET favorite = COALESCE(?, favorite), category_ids = COALESCE(?, category_ids)",
    )
    .bind(key)
    .bind(favorite)
    .bind(&categories)
    .bind(favorite)
    .bind(&categories)
    .execute(&mut **transaction)
    .await
    .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn set_reading_artifact_organization(
    app: AppHandle,
    artifact_key: String,
    favorite: Option<bool>,
    category_ids: Option<Vec<String>>,
) -> Result<(), String> {
    let pool = open_write_pool(database_path(&app)?).await?;
    let mut transaction = pool.begin().await.map_err(|error| error.to_string())?;
    write_artifact_organization(
        &mut transaction,
        &artifact_key,
        favorite,
        category_ids.as_deref(),
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn save_reading_artifact_category(
    app: AppHandle,
    category: ArtifactCategoryInput,
) -> Result<(), String> {
    validate_category(&category)?;
    let pool = open_write_pool(database_path(&app)?).await?;
    sqlx::query("INSERT INTO reading_artifact_categories (id, name) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name")
        .bind(&category.id)
        .bind(category.name.trim())
        .execute(&pool)
        .await
        .map_err(|error| error.to_string())?;
    Ok(())
}

async fn remove_artifact_category(pool: &SqlitePool, id: &str) -> Result<(), String> {
    let mut transaction = pool.begin().await.map_err(|error| error.to_string())?;
    sqlx::query("UPDATE reading_artifact_organization SET category_ids = (SELECT json_group_array(value) FROM json_each(reading_artifact_organization.category_ids) WHERE value <> ?)")
        .bind(id)
        .execute(&mut *transaction)
        .await
        .map_err(|error| error.to_string())?;
    sqlx::query("DELETE FROM reading_artifact_categories WHERE id = ?")
        .bind(id)
        .execute(&mut *transaction)
        .await
        .map_err(|error| error.to_string())?;
    transaction
        .commit()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn delete_reading_artifact_category(app: AppHandle, id: String) -> Result<(), String> {
    let pool = open_write_pool(database_path(&app)?).await?;
    remove_artifact_category(&pool, &id).await
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

/// Optional v2 intake. The caller computes SHA-256 over the exact source snapshot;
/// the worker must recheck it before use. The receipt never stores message text.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistMemoryIntakeRequest {
    message: MemoryIntakeMessage,
    scope_key: Option<String>,
    source_fingerprint: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistChatMessageWithMemoryIntakeRequest {
    session: PersistChatSessionInput,
    message: PersistChatMessageInput,
    policy_version: u8,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistChatSessionInput {
    id: String,
    title: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistChatMessageInput {
    id: String,
    session_id: String,
    role: String,
    content: String,
    metadata: Option<String>,
    created_at: i64,
}

async fn run_persist_chat_message_with_memory_intake(
    pool: &SqlitePool,
    request: PersistChatMessageWithMemoryIntakeRequest,
) -> Result<bool, String> {
    let session = &request.session;
    let message = &request.message;
    if request.policy_version != 3
        || session.id.is_empty()
        || session.id.len() > 300
        || session.title.len() > 300
        || message.id.is_empty()
        || message.id.len() > 300
        || message.session_id != session.id
        || message.role != "user"
        || message.created_at <= 0
        || message.content.len() > 1_500_000
        || message
            .metadata
            .as_ref()
            .is_some_and(|value| value.len() > 64_000)
    {
        return Err("invalid_memory_v3_intake".into());
    }

    let visible_text = message
        .metadata
        .as_deref()
        .and_then(|metadata| serde_json::from_str::<serde_json::Value>(metadata).ok())
        .and_then(|metadata| {
            metadata
                .get("displayContent")
                .and_then(|value| value.as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| message.content.clone());
    let source_fingerprint = Sha256::digest(
        serde_json::to_vec(&(&visible_text, message.created_at))
            .map_err(|error| error.to_string())?,
    );
    let source_fingerprint: String = source_fingerprint
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let mut tx = pool.begin().await.map_err(|error| error.to_string())?;
    let now = chrono_timestamp_millis();
    sqlx::query("INSERT INTO chat_sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at")
        .bind(&session.id).bind(&session.title).bind(now / 1000).bind(now / 1000)
        .execute(&mut *tx).await.map_err(|error| error.to_string())?;

    let receipt_key = format!("memory-extraction:v3:intake:{}", message.id);
    let previous: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = ?")
        .bind(&receipt_key)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|error| error.to_string())?;
    sqlx::query("INSERT OR IGNORE INTO chat_messages (id, session_id, role, parent_id, content, metadata, created_at) VALUES (?, ?, 'user', NULL, ?, ?, ?)")
        .bind(&message.id).bind(&session.id).bind(&message.content).bind(&message.metadata).bind(message.created_at)
        .execute(&mut *tx).await.map_err(|error| error.to_string())?;
    let matches: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM chat_messages WHERE id = ? AND session_id = ? AND role = 'user' AND parent_id IS NULL AND content = ? AND metadata IS ? AND created_at = ?")
        .bind(&message.id).bind(&session.id).bind(&message.content).bind(&message.metadata).bind(message.created_at)
        .fetch_one(&mut *tx).await.map_err(|error| error.to_string())?;
    if matches != 1 {
        return Err("memory_v3_source_changed".into());
    }

    if let Some(value) = previous {
        let old: serde_json::Value =
            serde_json::from_str(&value).map_err(|_| "invalid_memory_v3_receipt")?;
        if old.get("version").and_then(|item| item.as_u64()) != Some(3)
            || old.get("sourceId").and_then(|item| item.as_str()) != Some(message.id.as_str())
            || old.get("sessionId").and_then(|item| item.as_str()) != Some(session.id.as_str())
            || old.get("sourceFingerprint").and_then(|item| item.as_str())
                != Some(source_fingerprint.as_str())
        {
            return Err("memory_v3_receipt_conflict".into());
        }
        tx.commit().await.map_err(|error| error.to_string())?;
        return Ok(false);
    }

    let session_key = format!("memory-extraction:v3:session:{}", session.id);
    let state: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = ?")
        .bind(&session_key)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|error| error.to_string())?;
    let mut state: MemoryIntakeSession = match state {
        Some(value) => serde_json::from_str(&value).map_err(|_| "invalid_memory_v3_session")?,
        None => MemoryIntakeSession {
            version: 3,
            scope_key: None,
            sequence: 0,
            epoch: 0,
        },
    };
    if state.version != 3 || state.scope_key.is_some() {
        return Err("invalid_memory_v3_session".into());
    }
    state.sequence = state
        .sequence
        .checked_add(1)
        .ok_or("memory_v3_sequence_overflow")?;
    let receipt = serde_json::json!({ "version": 3, "sourceId": message.id, "sessionId": session.id,
        "scopeKey": null, "sequence": state.sequence, "epoch": state.epoch, "sourceFingerprint": source_fingerprint,
        "status": "pending", "createdAt": now });
    let state_json = serde_json::to_string(&state).map_err(|error| error.to_string())?;
    sqlx::query("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch()) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
        .bind(session_key).bind(state_json).execute(&mut *tx).await.map_err(|error| error.to_string())?;
    sqlx::query("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch())")
        .bind(receipt_key)
        .bind(receipt.to_string())
        .execute(&mut *tx)
        .await
        .map_err(|error| error.to_string())?;
    tx.commit().await.map_err(|error| error.to_string())?;
    Ok(true)
}

#[tauri::command]
pub async fn persist_chat_message_with_memory_intake(
    app: AppHandle,
    request: PersistChatMessageWithMemoryIntakeRequest,
) -> Result<bool, String> {
    let pool = open_write_pool(database_path(&app)?).await?;
    run_persist_chat_message_with_memory_intake(&pool, request).await
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemoryIntakeMessage {
    id: String,
    session_id: String,
    content: String,
    metadata: Option<String>,
    created_at: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct MemoryIntakeSession {
    version: u8,
    scope_key: Option<String>,
    sequence: u64,
    epoch: u64,
}

async fn run_persist_memory_intake(
    pool: &SqlitePool,
    request: PersistMemoryIntakeRequest,
) -> Result<bool, String> {
    const MAX_PENDING_MEMORY_INTAKE: i64 = 512;
    let msg = &request.message;
    if msg.id.is_empty()
        || msg.id.len() > 300
        || msg.session_id.is_empty()
        || msg.session_id.len() > 300
        || msg.created_at <= 0
        || request
            .scope_key
            .as_ref()
            .is_some_and(|key| key.is_empty() || key.len() > 4096)
        || request.source_fingerprint.len() != 64
        || !request
            .source_fingerprint
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("invalid_memory_intake".into());
    }

    let mut tx = pool.begin().await.map_err(|error| error.to_string())?;
    let receipt_key = format!("memory-extraction:v2:intake:{}", msg.id);
    let previous: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = ?")
        .bind(&receipt_key)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|error| error.to_string())?;
    // Existing sources are never overwritten by this command; changed content must be
    // handled by the ordinary conversation path. A retry must not recreate a deleted source.
    if previous.is_none() {
        sqlx::query("INSERT OR IGNORE INTO chat_messages (id, session_id, role, parent_id, content, metadata, created_at) VALUES (?, ?, 'user', NULL, ?, ?, ?)")
            .bind(&msg.id).bind(&msg.session_id).bind(&msg.content).bind(&msg.metadata).bind(msg.created_at)
            .execute(&mut *tx).await.map_err(|error| error.to_string())?;
    }
    let matches: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM chat_messages WHERE id = ? AND session_id = ? AND role = 'user' AND parent_id IS NULL AND content = ? AND metadata IS ? AND created_at = ?")
        .bind(&msg.id).bind(&msg.session_id).bind(&msg.content).bind(&msg.metadata).bind(msg.created_at)
        .fetch_one(&mut *tx).await.map_err(|error| error.to_string())?;
    if matches != 1 {
        return Err("memory_intake_source_changed".into());
    }

    if let Some(value) = previous {
        let old: serde_json::Value =
            serde_json::from_str(&value).map_err(|_| "invalid_memory_intake_receipt")?;
        if old.get("version").and_then(|value| value.as_u64()) != Some(2)
            || old.get("sourceId").and_then(|value| value.as_str()) != Some(msg.id.as_str())
            || old.get("sessionId").and_then(|value| value.as_str())
                != Some(msg.session_id.as_str())
            || old.get("scopeKey") != Some(&serde_json::json!(request.scope_key))
            || old
                .get("sourceFingerprint")
                .and_then(|value| value.as_str())
                != Some(request.source_fingerprint.as_str())
        {
            return Err("memory_intake_receipt_conflict".into());
        }
        tx.commit().await.map_err(|error| error.to_string())?;
        return Ok(false);
    }

    let pending: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM settings WHERE key LIKE 'memory-extraction:v2:intake:%' \
         AND CASE WHEN json_valid(value) THEN json_extract(value, '$.status') = 'pending' ELSE 0 END",
    )
    .fetch_one(&mut *tx)
    .await
    .map_err(|error| error.to_string())?;
    if pending >= MAX_PENDING_MEMORY_INTAKE {
        return Err("memory_intake_capacity".into());
    }

    let session_key = format!("memory-extraction:v2:session:{}", msg.session_id);
    let state: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = ?")
        .bind(&session_key)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|error| error.to_string())?;
    let mut state = match state {
        Some(value) => serde_json::from_str::<MemoryIntakeSession>(&value)
            .map_err(|_| "invalid_memory_intake_session")?,
        None => MemoryIntakeSession {
            version: 2,
            scope_key: request.scope_key.clone(),
            sequence: 0,
            epoch: 0,
        },
    };
    if state.version != 2 {
        return Err("invalid_memory_intake_session".into());
    }
    if state.scope_key != request.scope_key {
        state.epoch = state
            .epoch
            .checked_add(1)
            .ok_or("memory_intake_epoch_overflow")?;
        state.scope_key = request.scope_key.clone();
    }
    state.sequence = state
        .sequence
        .checked_add(1)
        .ok_or("memory_intake_sequence_overflow")?;
    let receipt = serde_json::json!({ "version": 2, "sourceId": msg.id, "sessionId": msg.session_id,
        "scopeKey": request.scope_key, "sequence": state.sequence, "epoch": state.epoch,
        "sourceFingerprint": request.source_fingerprint, "status": "pending", "createdAt": chrono_timestamp_millis() });
    let state_json = serde_json::to_string(&state).map_err(|error| error.to_string())?;
    sqlx::query("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch()) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
        .bind(&session_key).bind(state_json).execute(&mut *tx).await.map_err(|error| error.to_string())?;
    sqlx::query("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch())")
        .bind(&receipt_key)
        .bind(receipt.to_string())
        .execute(&mut *tx)
        .await
        .map_err(|error| error.to_string())?;
    tx.commit().await.map_err(|error| error.to_string())?;
    Ok(true)
}

#[tauri::command]
pub async fn persist_memory_intake_transaction(
    app: AppHandle,
    request: PersistMemoryIntakeRequest,
) -> Result<bool, String> {
    let pool = open_write_pool(database_path(&app)?).await?;
    run_persist_memory_intake(&pool, request).await
}

// Same non-cryptographic UTF-16 version hash as memoryPolicy.contentHash.
fn memory_content_version_hash(content: &str) -> String {
    let mut hash = 2_166_136_261_u32;
    for unit in content.encode_utf16() {
        hash = (hash ^ u32::from(unit)).wrapping_mul(16_777_619);
    }
    format!("{hash:x}")
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemoryReplacementSnapshot {
    id: String,
    content_hash: String,
    updated_at: i64,
}

fn valid_memory_evidence(value: &serde_json::Value, expected_version: u64) -> bool {
    let Some(session) = value
        .get("sessionId")
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty() && v.encode_utf16().count() <= 300)
    else {
        return false;
    };
    let Some(primary) = value
        .get("sourceId")
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty() && v.encode_utf16().count() <= 300)
    else {
        return false;
    };
    if value.get("version").and_then(|v| v.as_u64()) != Some(expected_version)
        || value.get("policyVersion").and_then(|v| v.as_u64()) != Some(expected_version)
        || !matches!(
            value.get("kind").and_then(|v| v.as_str()),
            Some("semantic" | "episodic")
        )
        || !value
            .get("windowId")
            .and_then(|v| v.as_str())
            .is_some_and(|v| !v.is_empty() && v.encode_utf16().count() <= 300)
        || !value
            .get("excerpt")
            .and_then(|v| v.as_str())
            .is_some_and(|v| v.encode_utf16().count() <= 1200)
        || ["recordedAt", "occurredAt"].iter().any(|key| {
            value.get(key).is_some_and(|v| {
                !v.as_f64()
                    .is_some_and(|n| n.is_finite() && n > 0.0 && n <= 8.64e15)
            })
        })
    {
        return false;
    }
    let Some(sources) = value
        .get("sources")
        .and_then(|v| v.as_array())
        .filter(|v| !v.is_empty() && v.len() <= 12)
    else {
        return false;
    };
    let mut ids = std::collections::HashSet::new();
    let mut users = std::collections::HashSet::new();
    let mut previous = 0_u64;
    let mut primary_sequence = None;
    for source in sources {
        let Some(id) = source
            .get("id")
            .and_then(|v| v.as_str())
            .filter(|v| !v.is_empty() && v.encode_utf16().count() <= 300)
        else {
            return false;
        };
        let Some(role) = source.get("role").and_then(|v| v.as_str()) else {
            return false;
        };
        let Some(sequence) = source.get("sequence").and_then(|v| v.as_u64()) else {
            return false;
        };
        let Some(created_at) = source.get("createdAt").and_then(|v| v.as_u64()) else {
            return false;
        };
        let Some(hash) = source.get("textHash").and_then(|v| v.as_str()) else {
            return false;
        };
        if !ids.insert(id)
            || source.get("sessionId").and_then(|v| v.as_str()) != Some(session)
            || sequence <= previous
            || created_at == 0
            || created_at > 8_640_000_000_000_000
            || hash.len() != 64
            || !hash
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return false;
        }
        match role {
            "user" if source.get("parentId").is_some_and(|v| v.is_null()) => {
                users.insert(id);
            }
            "assistant"
                if source
                    .get("parentId")
                    .and_then(|v| v.as_str())
                    .is_some_and(|parent| users.contains(parent)) => {}
            _ => return false,
        }
        if let Some(segment) = source.get("segment") {
            let Some(index) = segment.get("index").and_then(|v| v.as_u64()) else {
                return false;
            };
            let Some(total) = segment.get("total").and_then(|v| v.as_u64()) else {
                return false;
            };
            if !(2..=128).contains(&total) || index >= total {
                return false;
            }
        }
        if id == primary {
            if role != "user" {
                return false;
            }
            primary_sequence = Some(sequence);
        }
        previous = sequence;
    }
    let review = value.get("reviewReason");
    let quote = value.get("evidenceQuote");
    let valid_review = match (review, quote) {
        (None, None) => true,
        (Some(reason), Some(quote)) if expected_version == 3 => {
            reason.as_str() == Some("semantic")
                && quote.as_str().is_some_and(|text| {
                    !text.trim().is_empty() && text.encode_utf16().count() <= 1200
                })
        }
        _ => false,
    };
    let valid_conflicts = match value.get("conflicts") {
        None => true,
        Some(conflicts)
            if expected_version == 3
                && review.and_then(|item| item.as_str()) == Some("semantic") =>
        {
            conflicts.as_array().is_some_and(|items| {
                let mut seen = std::collections::HashSet::new();
                !items.is_empty()
                    && items.len() <= 8
                    && items.iter().all(|item| {
                        item.get("id").and_then(|v| v.as_str()).is_some_and(|id| {
                            !id.is_empty() && id.encode_utf16().count() <= 300 && seen.insert(id)
                        }) && item
                            .get("contentHash")
                            .and_then(|v| v.as_str())
                            .is_some_and(|hash| {
                                !hash.is_empty()
                                    && hash.len() <= 8
                                    && hash.bytes().all(|byte| {
                                        byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
                                    })
                            })
                            && item
                                .get("updatedAt")
                                .and_then(|v| v.as_i64())
                                .is_some_and(|time| time > 0)
                    })
            })
        }
        _ => false,
    };
    primary_sequence == Some(previous)
        && valid_review
        && valid_conflicts
        && (expected_version != 3
            || matches!(
                value.get("sensitivity").and_then(|v| v.as_str()),
                Some("normal" | "sensitive")
            ))
}

fn valid_memory_evidence_v2(value: &serde_json::Value) -> bool {
    valid_memory_evidence(value, 2)
}

fn valid_memory_evidence_v3(value: &serde_json::Value) -> bool {
    valid_memory_evidence(value, 3)
        && (value.get("sensitivity").and_then(|item| item.as_str()) == Some("sensitive")
            || value.get("reviewReason").and_then(|item| item.as_str()) == Some("semantic"))
}

fn memory_conflicts_match(
    rows: &[sqlx::sqlite::SqliteRow],
    expected: Option<&serde_json::Value>,
) -> Result<bool, String> {
    let Some(items) = expected.and_then(|value| value.as_array()) else {
        return Ok(rows.is_empty());
    };
    if rows.len() != items.len() || rows.len() > 8 {
        return Ok(false);
    }
    for row in rows {
        let id: String = row.try_get("id").map_err(|error| error.to_string())?;
        let content: String = row.try_get("content").map_err(|error| error.to_string())?;
        let mut updated: i64 = row
            .try_get("updated_at")
            .map_err(|error| error.to_string())?;
        if updated > 0 && updated < 1_000_000_000_000 {
            updated *= 1000;
        }
        let Some(snapshot) = items
            .iter()
            .find(|item| item.get("id").and_then(|v| v.as_str()) == Some(id.as_str()))
        else {
            return Ok(false);
        };
        if snapshot.get("updatedAt").and_then(|v| v.as_i64()) != Some(updated)
            || snapshot.get("contentHash").and_then(|v| v.as_str())
                != Some(memory_content_version_hash(&content).as_str())
        {
            return Ok(false);
        }
    }
    Ok(true)
}

async fn memory_add_related_conflicts(
    conn: &mut sqlx::SqliteConnection,
    conflicts: &mut Vec<sqlx::sqlite::SqliteRow>,
    evidence: &serde_json::Value,
) -> Result<(), String> {
    let Some(items) = evidence.get("conflicts").and_then(|value| value.as_array()) else {
        return Ok(());
    };
    for item in items {
        let Some(id) = item.get("id").and_then(|value| value.as_str()) else {
            continue;
        };
        if conflicts
            .iter()
            .any(|row| row.try_get::<String, _>("id").ok().as_deref() == Some(id))
        {
            continue;
        }
        if let Some(row) = sqlx::query("SELECT id, content, updated_at FROM memories WHERE id = ? AND status = 'active' AND COALESCE(scope_type, 'global') = 'global' AND COALESCE(scope_key, '') = ''")
            .bind(id).fetch_optional(&mut *conn).await.map_err(|error| error.to_string())? { conflicts.push(row); }
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistMemoryV2Request {
    operation_id: String,
    memory: MemoryV2Record,
    source: MemoryV2Guard,
    #[serde(default)]
    merge: Option<MemoryReplacementSnapshot>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemoryV2Record {
    id: String,
    content: String,
    category: String,
    status: String,
    scope_type: String,
    scope_key: Option<String>,
    subject: String,
    fact_key: String,
    fact_value: String,
    confidence: f64,
    evidence: String,
    supersedes_id: Option<String>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemoryV2Guard {
    id: String,
    snapshots: Vec<MemoryV2Snapshot>,
    lease: MemoryV2Lease,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemoryV2Snapshot {
    id: String,
    session_id: String,
    role: String,
    parent_id: Option<String>,
    content: String,
    metadata: Option<String>,
    created_at: i64,
}

#[derive(Clone, Debug, Deserialize)]
struct MemoryV2Lease {
    key: String,
    value: String,
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn normalized_memory_identity(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn memory_operation_id(memory: &MemoryV2Record, evidence: &serde_json::Value) -> Option<String> {
    let session = evidence.get("sessionId")?.as_str()?;
    let primary = evidence.get("sourceId")?.as_str()?;
    let sources = evidence.get("sources")?.as_array()?;
    let version = evidence.get("version")?.as_u64()?;
    if ![2, 3].contains(&version) {
        return None;
    }
    let mut parts = vec![
        version.to_string(),
        memory.scope_type.clone(),
        memory.scope_key.clone().unwrap_or_default(),
        memory.category.clone(),
        session.to_string(),
    ];
    for source in sources {
        parts.push(source.get("id")?.as_str()?.to_string());
        parts.push(source.get("role")?.as_str()?.to_string());
    }
    parts.extend([
        primary.to_string(),
        normalized_memory_identity(&memory.subject),
        normalized_memory_identity(&memory.fact_key),
        normalized_memory_identity(&memory.fact_value),
        "add".to_string(),
    ]);
    let mut canonical = String::new();
    for part in parts {
        canonical.push_str(&part.len().to_string());
        canonical.push(':');
        canonical.push_str(&part);
    }
    let digest = Sha256::digest(canonical.as_bytes());
    Some(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(test)]
fn memory_v2_operation_id(memory: &MemoryV2Record, evidence: &serde_json::Value) -> Option<String> {
    memory_operation_id(memory, evidence)
}

fn memory_snapshot_visible_text(
    snapshot: &MemoryV2Snapshot,
    policy_version: u64,
) -> Option<String> {
    let metadata = snapshot
        .metadata
        .as_deref()
        .map(serde_json::from_str::<serde_json::Value>)
        .transpose()
        .ok()?;
    if metadata.as_ref().is_some_and(|value| {
        !value.is_object()
            || value.get("hidden").is_some_and(|hidden| hidden != false)
            || value
                .get("displayContent")
                .is_some_and(|display| !display.is_string())
    }) {
        return None;
    }
    let context = metadata.as_ref().and_then(|value| value.get("contextMeta"));
    if context.is_some_and(|value| !value.is_object()) {
        return None;
    }
    if policy_version != 3
        && snapshot.role == "assistant"
        && metadata.as_ref().is_some_and(|value| {
            value.get("tags").is_some()
                || value.get("sources").is_some_and(|sources| {
                    !sources.as_array().is_some_and(|items| items.is_empty())
                })
                || context.is_some_and(|context| {
                    ["tagCount", "ragSourceCount"].iter().any(|key| {
                        context
                            .get(*key)
                            .is_some_and(|count| count.as_f64() != Some(0.0))
                    }) || context
                        .get("webSearchUsed")
                        .is_some_and(|used| used != false)
                })
        })
    {
        return None;
    }
    if snapshot.content.contains("【上下文") {
        return None;
    }
    if let Some(display) = metadata
        .as_ref()
        .and_then(|value| value.get("displayContent"))
        .and_then(|value| value.as_str())
    {
        return Some(display.to_string());
    }
    if snapshot.role == "user"
        && metadata.as_ref().is_some_and(|value| {
            value
                .get("tags")
                .and_then(|tags| tags.as_array())
                .is_some_and(|tags| !tags.is_empty())
        })
    {
        return None;
    }
    Some(snapshot.content.clone())
}

fn obvious_sensitive_memory(value: &str) -> bool {
    let lower = value.to_lowercase();
    let compact: String = lower.chars().filter(|c| !c.is_whitespace()).collect();
    if [
        "密码",
        "口令",
        "验证码",
        "密钥",
        "私钥",
        "助记词",
        "身份证",
        "银行卡",
        "信用卡",
        "病历",
        "诊断",
        "过敏",
        "住址",
        "家庭地址",
        "电话号码",
        "手机号",
        "password",
        "secret",
        "api_key",
        "api-key",
        "apikey",
        "token:",
        "token=",
        "sk-",
    ]
    .iter()
    .any(|needle| compact.contains(needle))
    {
        return true;
    }
    let bytes = compact.as_bytes();
    bytes.windows(11).any(|window| {
        window[0] == b'1'
            && (b'3'..=b'9').contains(&window[1])
            && window.iter().all(u8::is_ascii_digit)
    }) || bytes.windows(18).any(|window| {
        window[..17].iter().all(u8::is_ascii_digit)
            && (window[17].is_ascii_digit() || window[17] == b'x')
    })
}

fn obvious_forbidden_memory(value: &str) -> bool {
    let lower = value.to_lowercase();
    let compact: String = lower.chars().filter(|c| !c.is_whitespace()).collect();
    if [
        "密码",
        "口令",
        "验证码",
        "密钥",
        "私钥",
        "助记词",
        "身份证",
        "银行卡",
        "信用卡",
        "账号",
        "账户号码",
        "卡号",
        "住址",
        "家庭地址",
        "详细地址",
        "门牌号",
        "电话号码",
        "手机号",
        "联系方式",
        "电子邮箱",
        "邮箱地址",
        "微信号",
        "qq号",
        "password",
        "secret",
        "api_key",
        "api-key",
        "apikey",
        "access_token",
        "access-token",
        "account number",
        "token:",
        "token=",
        "sk-",
    ]
    .iter()
    .any(|needle| compact.contains(needle))
    {
        return true;
    }
    let bytes = compact.as_bytes();
    bytes.windows(11).any(|window| {
        window[0] == b'1'
            && (b'3'..=b'9').contains(&window[1])
            && window.iter().all(u8::is_ascii_digit)
    }) || bytes.windows(18).any(|window| {
        window[..17].iter().all(u8::is_ascii_digit)
            && (window[17].is_ascii_digit() || window[17] == b'x')
    }) || value.split_whitespace().any(|token| {
        token.contains('@')
            && token
                .split_once('.')
                .is_some_and(|(left, right)| !left.is_empty() && right.len() >= 2)
    })
}

fn reviewable_sensitive_memory(value: &str) -> bool {
    let lower = value.to_lowercase();
    [
        "病历",
        "诊断",
        "过敏",
        "疾病",
        "患有",
        "病情",
        "慢性病",
        "高血压",
        "糖尿病",
        "哮喘",
        "心脏病",
        "用药",
        "治疗",
        "就医",
        "健康状况",
        "财务状况",
        "经济状况",
        "财务",
        "收入",
        "工资",
        "月薪",
        "年薪",
        "负债",
        "债务",
        "欠款",
        "存款",
        "投资",
        "资产",
        "medical",
        "health",
        "financial",
        "income",
        "debt",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

fn has_explicit_memory_acceptance(value: &str) -> bool {
    let lower = value.to_lowercase();
    [
        "同意",
        "接受",
        "就用",
        "就按",
        "选这个",
        "选第",
        "选择",
        "采用",
        "按你说的",
        "按这个",
        "以后就",
        "确实",
        "没错",
        "是的",
        "that's right",
        "i agree",
        "use that",
        "choose that",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

async fn run_persist_memory_policy(
    pool: &SqlitePool,
    request: PersistMemoryV2Request,
    policy_version: u64,
) -> Result<String, String> {
    let memory = &request.memory;
    let evidence: serde_json::Value =
        serde_json::from_str(&memory.evidence).map_err(|_| "invalid_memory_v2_evidence")?;
    if !is_sha256_hex(&request.operation_id)
        || memory_operation_id(memory, &evidence).as_deref() != Some(request.operation_id.as_str())
        || memory.id != format!("mem-v{}-{}", policy_version, request.operation_id)
        || !(6..=80).contains(&memory.content.chars().count())
        || ![
            "preference",
            "project",
            "learning",
            "profile",
            "instruction",
        ]
        .contains(&memory.category.as_str())
        || !["candidate", "active"].contains(&memory.status.as_str())
        || !["global", "project"].contains(&memory.scope_type.as_str())
        || memory.subject.trim().is_empty()
        || memory.subject.len() > 320
        || memory.fact_key.trim().is_empty()
        || memory.fact_key.len() > 320
        || memory.fact_value.trim().is_empty()
        || memory.fact_value.len() > 640
        || !(0.0..=1.0).contains(&memory.confidence)
        || (policy_version == 2
            && !memory
                .content
                .to_lowercase()
                .contains(&memory.fact_value.trim().to_lowercase()))
        || memory.created_at <= 0
        || memory.updated_at <= 0
        || memory.evidence.encode_utf16().count() > 6000
        || [
            memory.content.as_str(),
            memory.subject.as_str(),
            memory.fact_key.as_str(),
            memory.fact_value.as_str(),
        ]
        .iter()
        .any(|value| {
            if policy_version == 3 {
                obvious_forbidden_memory(value)
            } else {
                obvious_sensitive_memory(value)
            }
        })
        || !valid_memory_evidence(&evidence, policy_version)
        || evidence.get("sourceId").and_then(|v| v.as_str()) != Some(request.source.id.as_str())
        || request.source.snapshots.is_empty()
        || request.source.snapshots.len() > 12
    {
        return Err("invalid_memory_v2_request".into());
    }
    let key_prefix = format!("memory-extraction:v{policy_version}:window:");
    if !request
        .source
        .lease
        .key
        .strip_prefix(&key_prefix)
        .is_some_and(is_sha256_hex)
    {
        return Err("invalid_memory_v2_lease".into());
    }
    let lease: serde_json::Value =
        serde_json::from_str(&request.source.lease.value).map_err(|_| "invalid_memory_v2_lease")?;
    let session = lease
        .get("sessionId")
        .and_then(|v| v.as_str())
        .ok_or("invalid_memory_v2_lease")?;
    let owner = lease
        .get("owner")
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty())
        .ok_or("invalid_memory_v2_lease")?;
    let _ = owner;
    let lease_until = lease
        .get("leaseUntil")
        .and_then(|v| v.as_i64())
        .ok_or("invalid_memory_v2_lease")?;
    let new_ids = lease
        .get("sourceIds")
        .and_then(|v| v.as_array())
        .ok_or("invalid_memory_v2_lease")?;
    let new_values = lease
        .get("receiptValues")
        .and_then(|v| v.as_array())
        .ok_or("invalid_memory_v2_lease")?;
    let prefix_ids = lease
        .get("prefixIds")
        .and_then(|v| v.as_array())
        .ok_or("invalid_memory_v2_lease")?;
    let prefix_values = lease
        .get("prefixReceiptValues")
        .and_then(|v| v.as_array())
        .ok_or("invalid_memory_v2_lease")?;
    let lease_scope = lease.get("scopeKey").and_then(|v| v.as_str());
    if lease.get("version").and_then(|v| v.as_u64()) != Some(policy_version)
        || lease.get("status").and_then(|v| v.as_str()) != Some("running")
        || lease.get("windowId").and_then(|v| v.as_str())
            != evidence.get("windowId").and_then(|v| v.as_str())
        || !lease
            .get("windowId")
            .and_then(|v| v.as_str())
            .is_some_and(|id| id.starts_with(&(request.source.lease.key.clone() + ":")))
        || evidence.get("sessionId").and_then(|v| v.as_str()) != Some(session)
        || new_ids.is_empty()
        || new_ids.len() > if policy_version == 3 { 8 } else { 4 }
        || new_ids.len() != new_values.len()
        || prefix_ids.len() > 2
        || prefix_ids.len() != prefix_values.len()
        || !new_ids
            .iter()
            .any(|id| id.as_str() == Some(request.source.id.as_str()))
        || (memory.scope_type == "project"
            && (memory.scope_key.as_deref().is_none()
                || memory.scope_key.as_deref() != lease_scope))
        || (memory.scope_type == "global"
            && (memory.scope_key.is_some() || memory.category == "project"))
        || (policy_version == 3
            && (memory.scope_type != "global"
                || memory.scope_key.is_some()
                || memory.category == "project"
                || lease.get("scopeKey") != Some(&serde_json::Value::Null)
                || (memory.supersedes_id.is_some() != evidence.get("replacement").is_some())))
    {
        return Err("invalid_memory_v2_lease".into());
    }
    if memory.scope_type == "project"
        && [
            "后续项目",
            "所有项目",
            "其他项目",
            "未来项目",
            "all projects",
            "future projects",
            "other projects",
        ]
        .iter()
        .any(|phrase| memory.content.to_lowercase().contains(phrase))
    {
        return Err("invalid_memory_v2_scope".into());
    }
    let mut unique = std::collections::HashSet::new();
    for snapshot in &request.source.snapshots {
        if !unique.insert(snapshot.id.as_str())
            || snapshot.session_id != session
            || !["user", "assistant"].contains(&snapshot.role.as_str())
            || snapshot.created_at <= 0
            || (snapshot.role == "user" && snapshot.parent_id.is_some())
            || (snapshot.role == "assistant"
                && !request.source.snapshots.iter().any(|parent| {
                    parent.role == "user" && Some(&parent.id) == snapshot.parent_id.as_ref()
                }))
        {
            return Err("invalid_memory_v2_sources".into());
        }
    }
    let evidence_sources = evidence
        .get("sources")
        .and_then(|v| v.as_array())
        .ok_or("invalid_memory_v2_evidence")?;
    let mut source_sensitive = false;
    for item in evidence_sources {
        if item.get("role").and_then(|v| v.as_str()) == Some("user")
            && !new_ids
                .iter()
                .chain(prefix_ids.iter())
                .any(|id| id.as_str() == item.get("id").and_then(|v| v.as_str()))
        {
            return Err("invalid_memory_v2_sources".into());
        }
        let snapshot = request.source.snapshots.iter().find(|snapshot| {
            item.get("id").and_then(|v| v.as_str()) == Some(snapshot.id.as_str())
                && item.get("sessionId").and_then(|v| v.as_str())
                    == Some(snapshot.session_id.as_str())
                && item.get("role").and_then(|v| v.as_str()) == Some(snapshot.role.as_str())
                && item.get("parentId") == Some(&serde_json::json!(snapshot.parent_id))
                && item.get("createdAt").and_then(|v| v.as_i64()) == Some(snapshot.created_at)
        });
        let Some(snapshot) = snapshot else {
            return Err("invalid_memory_v2_sources".into());
        };
        let visible = memory_snapshot_visible_text(snapshot, policy_version)
            .ok_or("invalid_memory_v2_sources")?;
        if policy_version == 3 && snapshot.role == "user" && obvious_forbidden_memory(&visible) {
            return Err("invalid_memory_v3_source".into());
        }
        if policy_version == 3 && snapshot.role == "user" && reviewable_sensitive_memory(&visible) {
            source_sensitive = true;
        }
        if item.get("segment").is_none() {
            let actual_hash = Sha256::digest(visible.as_bytes());
            let actual_hash: String = actual_hash
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect();
            if item.get("textHash").and_then(|value| value.as_str()) != Some(actual_hash.as_str()) {
                return Err("invalid_memory_v2_sources".into());
            }
        }
    }
    let evidence_sensitive = policy_version == 3
        && evidence.get("sensitivity").and_then(|v| v.as_str()) == Some("sensitive");
    let content_sensitive = policy_version == 3
        && (source_sensitive
            || [
                memory.content.as_str(),
                memory.subject.as_str(),
                memory.fact_key.as_str(),
                memory.fact_value.as_str(),
            ]
            .iter()
            .any(|value| reviewable_sensitive_memory(value)));
    if policy_version == 3 && content_sensitive && !evidence_sensitive {
        return Err("invalid_memory_v3_sensitivity".into());
    }
    if policy_version == 3 && evidence_sensitive && memory.status != "candidate" {
        return Err("invalid_memory_v3_sensitivity".into());
    }
    let semantic_review = policy_version == 3
        && evidence
            .get("reviewReason")
            .and_then(|value| value.as_str())
            == Some("semantic");
    if semantic_review {
        let primary = request
            .source
            .snapshots
            .iter()
            .find(|snapshot| snapshot.id == request.source.id && snapshot.role == "user")
            .and_then(|snapshot| memory_snapshot_visible_text(snapshot, policy_version))
            .ok_or("invalid_memory_v3_source")?;
        let quote = evidence
            .get("evidenceQuote")
            .and_then(|value| value.as_str())
            .ok_or("invalid_memory_v3_source")?;
        if memory.status != "candidate" || !primary.contains(quote) {
            return Err("invalid_memory_v3_source".into());
        }
    }
    if policy_version == 3
        && memory.status == "candidate"
        && !evidence_sensitive
        && !semantic_review
    {
        return Err("invalid_memory_v3_sensitivity".into());
    }
    if memory.status == "active" {
        if (policy_version == 2 && evidence_sources.len() != 1)
            || evidence_sources.is_empty()
            || evidence_sensitive
            || evidence_sources
                .iter()
                .any(|source| source.get("segment").is_some())
            || (policy_version == 2 && memory.confidence < 0.85)
            || memory.supersedes_id.is_some()
        {
            return Err("invalid_memory_v2_activation".into());
        }
        let primary = request
            .source
            .snapshots
            .iter()
            .find(|snapshot| snapshot.id == request.source.id && snapshot.role == "user")
            .ok_or("invalid_memory_v2_sources")?;
        let metadata = primary
            .metadata
            .as_deref()
            .map(serde_json::from_str::<serde_json::Value>)
            .transpose()
            .map_err(|_| "invalid_memory_v2_activation")?;
        if metadata.as_ref().is_some_and(|value| {
            !value.is_object()
                || value.get("hidden").is_some_and(|v| v != false)
                || value.get("displayContent").is_some_and(|v| !v.is_string())
        }) {
            return Err("invalid_memory_v2_activation".into());
        }
        let visible = match metadata.as_ref() {
            Some(value)
                if value
                    .get("displayContent")
                    .and_then(|v| v.as_str())
                    .is_some() =>
            {
                value
                    .get("displayContent")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
            }
            Some(value) if value.get("tags").is_some() => {
                return Err("invalid_memory_v2_activation".into())
            }
            _ if primary.content.contains("【上下文") => {
                return Err("invalid_memory_v2_activation".into())
            }
            _ => primary.content.as_str(),
        };
        let primary_contains_value = visible
            .to_lowercase()
            .contains(&memory.fact_value.to_lowercase());
        let accepted_assistant_value = policy_version == 3
            && has_explicit_memory_acceptance(visible)
            && evidence_sources.iter().any(|source| {
                if source.get("role").and_then(|v| v.as_str()) != Some("assistant") {
                    return false;
                }
                let source_id = source
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                request
                    .source
                    .snapshots
                    .iter()
                    .find(|snapshot| snapshot.id == source_id)
                    .and_then(|snapshot| memory_snapshot_visible_text(snapshot, policy_version))
                    .is_some_and(|text| {
                        text.to_lowercase()
                            .contains(&memory.fact_value.to_lowercase())
                    })
            });
        if policy_version == 2 && !primary_contains_value && !accepted_assistant_value {
            return Err("invalid_memory_v2_activation".into());
        }
    }

    let mut tx = pool.begin().await.map_err(|error| error.to_string())?;
    let active_lease: Option<String> =
        sqlx::query_scalar("SELECT value FROM settings WHERE key = ? AND value = ?")
            .bind(&request.source.lease.key)
            .bind(&request.source.lease.value)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|error| error.to_string())?;
    if active_lease.is_none() || lease_until <= chrono_timestamp_millis() {
        return Ok("lost_lease".into());
    }
    for (ids, values, allowed) in [
        (new_ids, new_values, &["pending"][..]),
        (prefix_ids, prefix_values, &["completed", "noop"][..]),
    ] {
        for (id, expected) in ids.iter().zip(values) {
            let id = id.as_str().ok_or("invalid_memory_v2_lease")?;
            let expected = expected.as_str().ok_or("invalid_memory_v2_lease")?;
            let receipt: serde_json::Value =
                serde_json::from_str(expected).map_err(|_| "invalid_memory_v2_lease")?;
            if receipt.get("version").and_then(|v| v.as_u64()) != Some(policy_version)
                || receipt.get("sourceId").and_then(|v| v.as_str()) != Some(id)
                || receipt.get("sessionId").and_then(|v| v.as_str()) != Some(session)
                || receipt.get("scopeKey") != lease.get("scopeKey")
                || receipt.get("epoch") != lease.get("epoch")
                || !receipt
                    .get("status")
                    .and_then(|v| v.as_str())
                    .is_some_and(|status| allowed.contains(&status))
            {
                return Err("invalid_memory_v2_lease".into());
            }
            let matching: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM settings WHERE key = ? AND value = ?")
                    .bind(format!("memory-extraction:v{policy_version}:intake:{id}"))
                    .bind(expected)
                    .fetch_one(&mut *tx)
                    .await
                    .map_err(|error| error.to_string())?;
            if matching != 1 {
                return Ok("lost_lease".into());
            }
        }
    }
    for snapshot in &request.source.snapshots {
        let matching: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM chat_messages WHERE id = ? AND session_id = ? AND role = ? AND parent_id IS ? AND content = ? AND metadata IS ? AND created_at = ?")
            .bind(&snapshot.id).bind(&snapshot.session_id).bind(&snapshot.role).bind(&snapshot.parent_id).bind(&snapshot.content).bind(&snapshot.metadata).bind(snapshot.created_at)
            .fetch_one(&mut *tx).await.map_err(|error| error.to_string())?;
        if matching != 1 {
            return Ok("invalidated".into());
        }
    }
    let operation_key = format!(
        "memory-extraction:v{policy_version}:op:{}",
        request.operation_id
    );
    let prior: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = ?")
        .bind(&operation_key)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|error| error.to_string())?;
    if prior.is_some() {
        return Ok("already_applied".into());
    }
    let existing_id: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM memories WHERE id = ?")
        .bind(&memory.id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|error| error.to_string())?;
    if existing_id != 0 {
        return Ok("conflict".into());
    }
    if let Some(merge) = &request.merge {
        if policy_version != 3 || memory.status != "active" || evidence_sensitive || semantic_review
        {
            return Err("invalid_memory_v3_merge".into());
        }
        let target = sqlx::query("SELECT content, updated_at FROM memories WHERE id = ? AND status = 'active' AND source = 'auto_extracted' AND locked = 0 AND COALESCE(scope_type, 'global') = 'global' AND COALESCE(scope_key, '') = ''")
            .bind(&merge.id).fetch_optional(&mut *tx).await.map_err(|error| error.to_string())?;
        let Some(target) = target else {
            return Ok("conflict".into());
        };
        let content: String = target
            .try_get("content")
            .map_err(|error| error.to_string())?;
        let updated: i64 = target
            .try_get("updated_at")
            .map_err(|error| error.to_string())?;
        let updated = if updated > 0 && updated < 1_000_000_000_000 {
            updated * 1000
        } else {
            updated
        };
        if merge.updated_at != updated
            || merge.content_hash != memory_content_version_hash(&content)
        {
            return Ok("conflict".into());
        }
        let result = sqlx::query("UPDATE memories SET content = ?, content_hash = NULL, embedding = NULL, embedding_model = NULL, evidence = ?, updated_at = ? WHERE id = ? AND status = 'active' AND source = 'auto_extracted' AND locked = 0")
            .bind(&memory.content).bind(&memory.evidence).bind(memory.updated_at).bind(&merge.id)
            .execute(&mut *tx).await.map_err(|error| error.to_string())?;
        if result.rows_affected() != 1 {
            return Ok("conflict".into());
        }
        let receipt = serde_json::json!({"version": policy_version, "memoryId": merge.id, "outcome": "merged"}).to_string();
        sqlx::query("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch())")
            .bind(&operation_key)
            .bind(receipt)
            .execute(&mut *tx)
            .await
            .map_err(|error| error.to_string())?;
        tx.commit().await.map_err(|error| error.to_string())?;
        return Ok("inserted".into());
    }
    let duplicate: Option<String> = sqlx::query_scalar("SELECT id FROM memories WHERE category = ? AND COALESCE(scope_type, 'global') = ? AND COALESCE(scope_key, '') = COALESCE(?, '') AND (lower(trim(subject)) = lower(trim(?)) OR (? = 3 AND lower(trim(subject)) IN ('user', '用户') AND lower(trim(?)) IN ('user', '用户'))) AND lower(trim(fact_key)) = lower(trim(?)) AND lower(trim(fact_value)) = lower(trim(?)) AND (? != 3 OR lower(trim(content)) = lower(trim(?))) AND status IN ('active','candidate','ignored','archived') LIMIT 1")
        .bind(&memory.category).bind(&memory.scope_type).bind(&memory.scope_key).bind(&memory.subject).bind(policy_version as i64).bind(&memory.subject).bind(&memory.fact_key).bind(&memory.fact_value)
        .bind(policy_version as i64).bind(&memory.content)
        .fetch_optional(&mut *tx).await.map_err(|error| error.to_string())?;
    if let Some(duplicate) = duplicate {
        if lease_until <= chrono_timestamp_millis() {
            return Ok("lost_lease".into());
        }
        let receipt =
            serde_json::json!({"version": policy_version, "memoryId": duplicate, "outcome": "duplicate"})
                .to_string();
        sqlx::query("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch())")
            .bind(&operation_key)
            .bind(receipt)
            .execute(&mut *tx)
            .await
            .map_err(|error| error.to_string())?;
        tx.commit().await.map_err(|error| error.to_string())?;
        return Ok("duplicate".into());
    }
    let mut conflicts = sqlx::query("SELECT id, content, updated_at FROM memories WHERE category = ? AND COALESCE(scope_type, 'global') = ? AND COALESCE(scope_key, '') = COALESCE(?, '') AND (lower(trim(subject)) = lower(trim(?)) OR (? = 3 AND lower(trim(subject)) IN ('user', '用户') AND lower(trim(?)) IN ('user', '用户'))) AND lower(trim(fact_key)) = lower(trim(?)) AND status = 'active' LIMIT 9")
        .bind(&memory.category).bind(&memory.scope_type).bind(&memory.scope_key).bind(&memory.subject).bind(policy_version as i64).bind(&memory.subject).bind(&memory.fact_key)
        .fetch_all(&mut *tx).await.map_err(|error| error.to_string())?;
    if policy_version == 3 {
        memory_add_related_conflicts(&mut tx, &mut conflicts, &evidence).await?;
        if !memory_conflicts_match(&conflicts, evidence.get("conflicts"))?
            || (!conflicts.is_empty() && (!semantic_review || memory.status != "candidate"))
        {
            return Ok("conflict".into());
        }
        if let Some(id) = &memory.supersedes_id {
            let replacement = evidence
                .get("replacement")
                .cloned()
                .and_then(|value| serde_json::from_value::<MemoryReplacementSnapshot>(value).ok());
            if memory.status != "candidate"
                || !replacement.is_some_and(|item| {
                    item.id == *id
                        && conflicts.iter().any(|row| {
                            row.try_get::<String, _>("id").ok().as_deref() == Some(id.as_str())
                                && row
                                    .try_get::<String, _>("content")
                                    .ok()
                                    .is_some_and(|content| {
                                        memory_content_version_hash(&content) == item.content_hash
                                    })
                                && row
                                    .try_get::<i64, _>("updated_at")
                                    .ok()
                                    .is_some_and(|time| {
                                        (if time > 0 && time < 1_000_000_000_000 {
                                            time * 1000
                                        } else {
                                            time
                                        }) == item.updated_at
                                    })
                        })
                })
            {
                return Ok("conflict".into());
            }
        }
    } else if conflicts.len() > 1 {
        return Ok("conflict".into());
    }
    if let Some(old) = conflicts.first().filter(|_| policy_version == 2) {
        let id: String = old.try_get("id").map_err(|error| error.to_string())?;
        let content: String = old.try_get("content").map_err(|error| error.to_string())?;
        let mut updated: i64 = old
            .try_get("updated_at")
            .map_err(|error| error.to_string())?;
        if updated > 0 && updated < 1_000_000_000_000 {
            updated *= 1000;
        }
        let replacement = evidence
            .get("replacement")
            .cloned()
            .and_then(|value| serde_json::from_value::<MemoryReplacementSnapshot>(value).ok());
        if memory.status != "candidate"
            || memory.supersedes_id.as_deref() != Some(id.as_str())
            || !replacement.is_some_and(|item| {
                item.id == id
                    && item.updated_at == updated
                    && item.content_hash == memory_content_version_hash(&content)
            })
        {
            return Ok("conflict".into());
        }
    } else if policy_version == 2 && memory.supersedes_id.is_some() {
        return Ok("conflict".into());
    }
    if lease_until <= chrono_timestamp_millis() {
        return Ok("lost_lease".into());
    }
    sqlx::query("INSERT INTO memories (id, content, category, source, locked, status, scope_type, scope_key, subject, fact_key, fact_value, confidence, evidence, supersedes_id, created_at, updated_at) VALUES (?, ?, ?, 'auto_extracted', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(&memory.id).bind(&memory.content).bind(&memory.category).bind(&memory.status).bind(&memory.scope_type).bind(&memory.scope_key)
        .bind(&memory.subject).bind(&memory.fact_key).bind(&memory.fact_value).bind(memory.confidence).bind(&memory.evidence).bind(&memory.supersedes_id)
        .bind(memory.created_at).bind(memory.updated_at).execute(&mut *tx).await.map_err(|error| error.to_string())?;
    let receipt = serde_json::json!({"version": policy_version, "memoryId": memory.id, "outcome": "inserted"}).to_string();
    sqlx::query("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch())")
        .bind(&operation_key)
        .bind(receipt)
        .execute(&mut *tx)
        .await
        .map_err(|error| error.to_string())?;
    tx.commit().await.map_err(|error| error.to_string())?;
    Ok("inserted".into())
}

async fn run_persist_memory_v2(
    pool: &SqlitePool,
    request: PersistMemoryV2Request,
) -> Result<String, String> {
    run_persist_memory_policy(pool, request, 2).await
}

async fn run_persist_memory_v3(
    pool: &SqlitePool,
    request: PersistMemoryV2Request,
) -> Result<String, String> {
    run_persist_memory_policy(pool, request, 3).await
}

#[tauri::command]
pub async fn persist_memory_v2_transaction(
    app: AppHandle,
    request: PersistMemoryV2Request,
) -> Result<String, String> {
    let pool = open_write_pool(database_path(&app)?).await?;
    run_persist_memory_v2(&pool, request).await
}

#[tauri::command]
pub async fn persist_memory_v3_transaction(
    app: AppHandle,
    request: PersistMemoryV2Request,
) -> Result<String, String> {
    let pool = open_write_pool(database_path(&app)?).await?;
    run_persist_memory_v3(&pool, request).await
}

#[cfg(test)]
async fn run_confirm_memory_candidate(pool: &SqlitePool, id: &str) -> Result<bool, String> {
    run_confirm_memory_candidate_with_coexist(pool, id, false).await
}

async fn run_confirm_memory_candidate_with_coexist(
    pool: &SqlitePool,
    id: &str,
    coexist: bool,
) -> Result<bool, String> {
    let mut transaction = pool.begin().await.map_err(|error| error.to_string())?;
    let candidate = sqlx::query(
        "SELECT supersedes_id, evidence, category, subject, fact_key, scope_type, scope_key FROM memories WHERE id = ? AND status = 'candidate'",
    )
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
    let evidence: Option<String> = candidate
        .try_get("evidence")
        .map_err(|error| error.to_string())?;
    let evidence_too_long = evidence
        .as_ref()
        .is_some_and(|text| text.encode_utf16().count() > 6000);
    let evidence = evidence
        .as_deref()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok());
    let version = evidence.as_ref().and_then(|value| value.get("version"));
    let version_number = version.and_then(|value| value.as_i64());
    if (supersedes_id.is_some() && version.is_some() && !matches!(version_number, Some(1..=3)))
        || (id.starts_with("mem-v2-") && version_number != Some(2))
        || (id.starts_with("mem-v3-")
            && (version_number != Some(3)
                || evidence_too_long
                || !evidence.as_ref().is_some_and(valid_memory_evidence_v3)))
        || (version_number == Some(2)
            && (evidence_too_long || !evidence.as_ref().is_some_and(valid_memory_evidence_v2)))
    {
        transaction
            .rollback()
            .await
            .map_err(|error| error.to_string())?;
        return Ok(false);
    }
    if version_number == Some(3)
        && evidence
            .as_ref()
            .and_then(|value| value.get("reviewReason"))
            .and_then(|value| value.as_str())
            == Some("semantic")
    {
        let item = evidence.as_ref().ok_or("invalid_memory_v3_evidence")?;
        let sources = item
            .get("sources")
            .and_then(|value| value.as_array())
            .ok_or("invalid_memory_v3_evidence")?;
        let primary_id = item
            .get("sourceId")
            .and_then(|value| value.as_str())
            .ok_or("invalid_memory_v3_evidence")?;
        let quote = item
            .get("evidenceQuote")
            .and_then(|value| value.as_str())
            .ok_or("invalid_memory_v3_evidence")?;
        let mut current = true;
        for source in sources {
            let source_id = source
                .get("id")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            let row = sqlx::query("SELECT id, session_id, role, parent_id, content, metadata, created_at FROM chat_messages WHERE id = ? AND session_id = ? AND role = ? AND parent_id IS ? AND created_at = ?")
                .bind(source_id)
                .bind(source.get("sessionId").and_then(|value| value.as_str()))
                .bind(source.get("role").and_then(|value| value.as_str()))
                .bind(source.get("parentId").and_then(|value| value.as_str()))
                .bind(source.get("createdAt").and_then(|value| value.as_i64()))
                .fetch_optional(&mut *transaction).await.map_err(|error| error.to_string())?;
            let Some(row) = row else {
                current = false;
                break;
            };
            let snapshot = MemoryV2Snapshot {
                id: row.try_get("id").map_err(|error| error.to_string())?,
                session_id: row
                    .try_get("session_id")
                    .map_err(|error| error.to_string())?,
                role: row.try_get("role").map_err(|error| error.to_string())?,
                parent_id: row
                    .try_get("parent_id")
                    .map_err(|error| error.to_string())?,
                content: row.try_get("content").map_err(|error| error.to_string())?,
                metadata: row.try_get("metadata").map_err(|error| error.to_string())?,
                created_at: row
                    .try_get("created_at")
                    .map_err(|error| error.to_string())?,
            };
            let Some(visible) = memory_snapshot_visible_text(&snapshot, 3) else {
                current = false;
                break;
            };
            let hash: String = Sha256::digest(visible.as_bytes())
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect();
            if source.get("textHash").and_then(|value| value.as_str()) != Some(hash.as_str())
                || (source_id == primary_id && !visible.contains(quote))
                || (snapshot.role == "user" && obvious_forbidden_memory(&visible))
            {
                current = false;
                break;
            }
        }
        let category: String = candidate
            .try_get("category")
            .map_err(|error| error.to_string())?;
        let subject: String = candidate
            .try_get("subject")
            .map_err(|error| error.to_string())?;
        let fact_key: String = candidate
            .try_get("fact_key")
            .map_err(|error| error.to_string())?;
        let scope_type: Option<String> = candidate
            .try_get("scope_type")
            .map_err(|error| error.to_string())?;
        let scope_key: Option<String> = candidate
            .try_get("scope_key")
            .map_err(|error| error.to_string())?;
        let mut conflicts = sqlx::query("SELECT id, content, updated_at FROM memories WHERE status = 'active' AND category = ? AND COALESCE(scope_type, 'global') = COALESCE(?, 'global') AND COALESCE(scope_key, '') = COALESCE(?, '') AND (lower(trim(subject)) = lower(trim(?)) OR (lower(trim(subject)) IN ('user', '用户') AND lower(trim(?)) IN ('user', '用户'))) AND lower(trim(fact_key)) = lower(trim(?)) LIMIT 9")
            .bind(category).bind(scope_type).bind(scope_key).bind(&subject).bind(&subject).bind(fact_key)
            .fetch_all(&mut *transaction).await.map_err(|error| error.to_string())?;
        memory_add_related_conflicts(&mut transaction, &mut conflicts, item).await?;
        if !current
            || !memory_conflicts_match(&conflicts, item.get("conflicts"))?
            || supersedes_id.as_ref().is_some_and(|id| {
                !conflicts
                    .iter()
                    .any(|row| row.try_get::<String, _>("id").ok().as_deref() == Some(id.as_str()))
            })
            || (!conflicts.is_empty() && !coexist && supersedes_id.is_none())
        {
            transaction
                .rollback()
                .await
                .map_err(|error| error.to_string())?;
            return Ok(false);
        }
    }
    if let Some(supersedes_id) = supersedes_id.filter(|_| !coexist || version_number != Some(3)) {
        let replacement = evidence.as_ref().and_then(|value| value.get("replacement"));
        // Legacy text and v1 without a snapshot remain readable. New evidence must
        // never fall through that compatibility path and replace an unchecked row.
        if matches!(version_number, Some(2 | 3)) && replacement.is_none() {
            transaction
                .rollback()
                .await
                .map_err(|error| error.to_string())?;
            return Ok(false);
        }
        if let Some(snapshot) = replacement.filter(|_| matches!(version_number, Some(1..=3))) {
            let snapshot = serde_json::from_value::<MemoryReplacementSnapshot>(snapshot.clone());
            let current = sqlx::query(
                "SELECT content, updated_at FROM memories WHERE id = ? AND status = 'active'",
            )
            .bind(&supersedes_id)
            .fetch_optional(&mut *transaction)
            .await
            .map_err(|error| error.to_string())?;
            let valid = if let (Ok(snapshot), Some(current)) = (snapshot, current) {
                let content: String = current
                    .try_get("content")
                    .map_err(|error| error.to_string())?;
                let updated_at: i64 = current
                    .try_get("updated_at")
                    .map_err(|error| error.to_string())?;
                let updated_at = if updated_at > 0 && updated_at < 1_000_000_000_000 {
                    updated_at * 1000
                } else {
                    updated_at
                };
                snapshot.id == supersedes_id
                    && snapshot.updated_at == updated_at
                    && snapshot.content_hash == memory_content_version_hash(&content)
            } else {
                false
            };
            if !valid {
                transaction
                    .rollback()
                    .await
                    .map_err(|error| error.to_string())?;
                return Ok(false);
            }
        }
        let replaced = sqlx::query(
            "UPDATE memories SET status = 'superseded', updated_at = unixepoch() * 1000 \
             WHERE id = ? AND status = 'active' \
             AND COALESCE(scope_type, 'global') = (SELECT COALESCE(scope_type, 'global') FROM memories WHERE id = ?) \
             AND COALESCE(scope_key, '') = (SELECT COALESCE(scope_key, '') FROM memories WHERE id = ?)",
        )
        .bind(supersedes_id)
        .bind(id)
        .bind(id)
        .execute(&mut *transaction)
        .await
        .map_err(|error| error.to_string())?;
        if replaced.rows_affected() != 1 {
            transaction
                .rollback()
                .await
                .map_err(|error| error.to_string())?;
            return Ok(false);
        }
    }
    let result = sqlx::query(
        "UPDATE memories SET status = 'active', source = 'user_explicit', supersedes_id = CASE WHEN ? THEN NULL ELSE supersedes_id END, \
         updated_at = unixepoch() * 1000 WHERE id = ? AND status = 'candidate'",
    )
    .bind(coexist && version_number == Some(3))
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
    coexist: Option<bool>,
) -> Result<bool, String> {
    let pool = open_write_pool(database_path(&app)?).await?;
    run_confirm_memory_candidate_with_coexist(&pool, &id, coexist.unwrap_or(false)).await
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

    let mut category_ids = HashMap::new();
    for category in &payload.artifact_categories {
        validate_category(category).map_err(sqlx::Error::Protocol)?;
        // Name takes precedence during backup merging; retain the local category identity.
        let existing_id: Option<String> =
            sqlx::query_scalar("SELECT id FROM reading_artifact_categories WHERE name = ?")
                .bind(category.name.trim())
                .fetch_optional(&mut **transaction)
                .await?;
        let id = if let Some(id) = existing_id {
            id
        } else {
            // An existing ID keeps its local name, so earlier mappings cannot be renamed.
            sqlx::query("INSERT INTO reading_artifact_categories (id, name) VALUES (?, ?) ON CONFLICT(id) DO NOTHING")
                .bind(&category.id)
                .bind(category.name.trim())
                .execute(&mut **transaction)
                .await?;
            category.id.clone()
        };
        category_ids.insert(category.id.clone(), id);
    }
    for organization in &payload.artifact_organization {
        let mut mapped_ids = Vec::new();
        for id in &organization.category_ids {
            let mapped = category_ids.get(id).unwrap_or(id);
            if !mapped_ids.contains(mapped) {
                mapped_ids.push(mapped.clone());
            }
        }
        write_artifact_organization(
            transaction,
            &organization.artifact_key,
            Some(organization.favorite),
            Some(&mapped_ids),
        )
        .await
        .map_err(sqlx::Error::Protocol)?;
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

    #[test]
    fn memory_v3_visible_reply_accepts_tool_metadata() {
        let snapshot = MemoryV2Snapshot {
            id: "a1".into(),
            session_id: "s".into(),
            role: "assistant".into(),
            parent_id: Some("u1".into()),
            content: "原始正文".into(),
            metadata: Some(
                serde_json::json!({"displayContent":"可见回复", "sources":[{"text":"工具原文"}],
                "contextMeta":{"webSearchUsed":true,"ragSourceCount":1}})
                .to_string(),
            ),
            created_at: 1,
        };
        assert_eq!(
            memory_snapshot_visible_text(&snapshot, 3).as_deref(),
            Some("可见回复")
        );
        assert_eq!(memory_snapshot_visible_text(&snapshot, 2), None);
    }

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
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT (unixepoch()))",
            "CREATE TABLE memories (id TEXT PRIMARY KEY, content TEXT NOT NULL, category TEXT NOT NULL, source TEXT NOT NULL, locked INTEGER NOT NULL, status TEXT NOT NULL, scope_type TEXT NOT NULL, scope_key TEXT, subject TEXT, fact_key TEXT, fact_value TEXT, confidence REAL NOT NULL, evidence TEXT, supersedes_id TEXT, embedding TEXT, embedding_model TEXT, content_hash TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
            "CREATE TABLE reading_artifacts (id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, structured_content TEXT, source_file_path TEXT, source_file_name TEXT, source_content_hash TEXT, source_heading_path TEXT, source_start_line INTEGER, source_end_line INTEGER, source_quote TEXT, source_message_id TEXT, source_scope TEXT, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
            "CREATE TABLE reading_reminders (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, due_at_utc INTEGER NOT NULL, created_timezone TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', source_artifact_id TEXT, source_file_path TEXT, source_message_id TEXT, notification_id INTEGER, error_code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
            "CREATE TABLE reading_marks (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, document_path TEXT NOT NULL, type TEXT NOT NULL, start_block_id TEXT NOT NULL, start_block_offset INTEGER NOT NULL, end_block_id TEXT NOT NULL, end_block_offset INTEGER NOT NULL, start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL, quote TEXT NOT NULL, context_before TEXT NOT NULL, context_after TEXT NOT NULL, color TEXT NOT NULL, note TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
            "CREATE TABLE reading_artifact_categories (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE)",
            "CREATE TABLE reading_artifact_organization (artifact_key TEXT PRIMARY KEY, favorite INTEGER NOT NULL DEFAULT 0, category_ids TEXT NOT NULL DEFAULT '[]')",
        ] {
            sqlx::query(statement).execute(&pool).await.unwrap();
        }
        pool
    }

    fn intake(id: &str, scope: Option<&str>) -> PersistMemoryIntakeRequest {
        PersistMemoryIntakeRequest {
            message: MemoryIntakeMessage {
                id: id.into(),
                session_id: "s".into(),
                content: "匿名对话内容".into(),
                metadata: None,
                created_at: 1_700_000_000_000,
            },
            scope_key: scope.map(str::to_string),
            source_fingerprint: "a".repeat(64),
        }
    }

    async fn intake_session(pool: &SqlitePool) {
        sqlx::query("INSERT INTO chat_sessions (id, title, created_at, updated_at) VALUES ('s', '匿名', 1, 1)")
            .execute(pool).await.unwrap();
    }

    async fn memory_v2_fixture(pool: &SqlitePool) -> PersistMemoryV2Request {
        intake_session(pool).await;
        let created = 1_700_000_000_000_i64;
        let text = "我喜欢技术回答先给结论";
        sqlx::query("INSERT INTO chat_messages (id,session_id,role,parent_id,content,metadata,created_at) VALUES ('u1','s','user',NULL,?,NULL,?)")
            .bind(text).bind(created).execute(pool).await.unwrap();
        let receipt = serde_json::json!({"version":2,"sourceId":"u1","sessionId":"s","scopeKey":null,"epoch":0,"sequence":1,
            "sourceFingerprint":"a".repeat(64),"status":"pending","createdAt":created}).to_string();
        sqlx::query("INSERT INTO settings (key,value) VALUES ('memory-extraction:v2:intake:u1',?)")
            .bind(&receipt)
            .execute(pool)
            .await
            .unwrap();
        let key = format!("memory-extraction:v2:window:{}", "c".repeat(64));
        let window_id = format!("{key}:1");
        let lease = serde_json::json!({"version":2,"sessionId":"s","scopeKey":null,"epoch":0,"windowId":window_id,
            "status":"running","owner":"worker","leaseUntil":chrono_timestamp_millis()+60_000,
            "sourceIds":["u1"],"receiptValues":[receipt],"prefixIds":[],"prefixReceiptValues":[]}).to_string();
        sqlx::query("INSERT INTO settings (key,value) VALUES (?,?)")
            .bind(&key)
            .bind(&lease)
            .execute(pool)
            .await
            .unwrap();
        let text_hash: String = Sha256::digest(text.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let evidence = serde_json::json!({"version":2,"policyVersion":2,"kind":"semantic","sourceId":"u1","sessionId":"s",
            "windowId":window_id,"excerpt":text,"sources":[{"id":"u1","sessionId":"s","role":"user","parentId":null,
            "sequence":1,"createdAt":created,"textHash":text_hash}]}).to_string();
        let mut request = PersistMemoryV2Request {
            merge: None,
            operation_id: "".into(),
            memory: MemoryV2Record {
                id: String::new(),
                content: "技术回答先给结论".into(),
                category: "preference".into(),
                status: "candidate".into(),
                scope_type: "global".into(),
                scope_key: None,
                subject: "user".into(),
                fact_key: "answer_order".into(),
                fact_value: "结论".into(),
                confidence: 0.95,
                evidence,
                supersedes_id: None,
                created_at: created,
                updated_at: created,
            },
            source: MemoryV2Guard {
                id: "u1".into(),
                snapshots: vec![MemoryV2Snapshot {
                    id: "u1".into(),
                    session_id: "s".into(),
                    role: "user".into(),
                    parent_id: None,
                    content: text.into(),
                    metadata: None,
                    created_at: created,
                }],
                lease: MemoryV2Lease { key, value: lease },
            },
        };
        let evidence: serde_json::Value = serde_json::from_str(&request.memory.evidence).unwrap();
        request.operation_id = memory_v2_operation_id(&request.memory, &evidence).unwrap();
        request.memory.id = format!("mem-v2-{}", request.operation_id);
        request
    }

    fn global_intake_request(
        id: &str,
        created_at: i64,
    ) -> PersistChatMessageWithMemoryIntakeRequest {
        PersistChatMessageWithMemoryIntakeRequest {
            session: PersistChatSessionInput { id: "global-session".into(), title: "匿名".into() },
            message: PersistChatMessageInput {
                id: id.into(), session_id: "global-session".into(), role: "user".into(),
                content: "我喜欢技术回答先给结论".into(),
                metadata: Some(serde_json::json!({"displayContent":"我喜欢技术回答先给结论","tags":[{"type":"document"}]}).to_string()),
                created_at,
            },
            policy_version: 3,
        }
    }

    async fn memory_v3_fixture(
        pool: &SqlitePool,
        source_text: &str,
        content: &str,
        fact_value: &str,
        sensitivity: &str,
        status: &str,
    ) -> PersistMemoryV2Request {
        intake_session(pool).await;
        let created = 1_700_000_000_000_i64;
        sqlx::query("INSERT INTO chat_messages (id,session_id,role,parent_id,content,metadata,created_at) VALUES ('u1','s','user',NULL,?,NULL,?)")
            .bind(source_text).bind(created).execute(pool).await.unwrap();
        let receipt = serde_json::json!({"version":3,"sourceId":"u1","sessionId":"s","scopeKey":null,"epoch":0,
            "sequence":1,"sourceFingerprint":"a".repeat(64),"status":"pending","createdAt":created}).to_string();
        sqlx::query("INSERT INTO settings (key,value) VALUES ('memory-extraction:v3:intake:u1',?)")
            .bind(&receipt)
            .execute(pool)
            .await
            .unwrap();
        let key = format!("memory-extraction:v3:window:{}", "d".repeat(64));
        let window_id = format!("{key}:1");
        let lease = serde_json::json!({"version":3,"sessionId":"s","scopeKey":null,"epoch":0,"windowId":window_id,
            "status":"running","owner":"worker","leaseUntil":chrono_timestamp_millis()+60_000,
            "sourceIds":["u1"],"receiptValues":[receipt],"prefixIds":[],"prefixReceiptValues":[]}).to_string();
        sqlx::query("INSERT INTO settings (key,value) VALUES (?,?)")
            .bind(&key)
            .bind(&lease)
            .execute(pool)
            .await
            .unwrap();
        let text_hash: String = Sha256::digest(source_text.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let evidence = serde_json::json!({"version":3,"policyVersion":3,"sensitivity":sensitivity,"kind":"semantic",
            "sourceId":"u1","sessionId":"s","windowId":window_id,"excerpt":source_text,
            "sources":[{"id":"u1","sessionId":"s","role":"user","parentId":null,"sequence":1,
                "createdAt":created,"textHash":text_hash}]}).to_string();
        let mut request = PersistMemoryV2Request {
            merge: None,
            operation_id: String::new(),
            memory: MemoryV2Record {
                id: String::new(),
                content: content.into(),
                category: "preference".into(),
                status: status.into(),
                scope_type: "global".into(),
                scope_key: None,
                subject: "user".into(),
                fact_key: "test_fact".into(),
                fact_value: fact_value.into(),
                confidence: 0.95,
                evidence,
                supersedes_id: None,
                created_at: created,
                updated_at: created,
            },
            source: MemoryV2Guard {
                id: "u1".into(),
                snapshots: vec![MemoryV2Snapshot {
                    id: "u1".into(),
                    session_id: "s".into(),
                    role: "user".into(),
                    parent_id: None,
                    content: source_text.into(),
                    metadata: None,
                    created_at: created,
                }],
                lease: MemoryV2Lease { key, value: lease },
            },
        };
        let evidence: serde_json::Value = serde_json::from_str(&request.memory.evidence).unwrap();
        request.operation_id = memory_operation_id(&request.memory, &evidence).unwrap();
        request.memory.id = format!("mem-v3-{}", request.operation_id);
        request
    }

    #[tokio::test]
    async fn memory_v3_semantic_review_requires_current_evidence_and_no_conflict() {
        async fn semantic_fixture(pool: &SqlitePool) -> PersistMemoryV2Request {
            let text = "我的职业是独立开发者，我长期从事软件开发。";
            let mut request = memory_v3_fixture(
                pool,
                text,
                "用户是独立开发者，长期从事软件开发",
                "独立开发者，长期从事软件开发",
                "normal",
                "candidate",
            )
            .await;
            let mut evidence: serde_json::Value =
                serde_json::from_str(&request.memory.evidence).unwrap();
            evidence["reviewReason"] = serde_json::json!("semantic");
            evidence["evidenceQuote"] =
                serde_json::json!("我的职业是独立开发者，我长期从事软件开发");
            request.memory.evidence = evidence.to_string();
            request
        }
        let pool = test_pool().await;
        let request = semantic_fixture(&pool).await;
        assert_eq!(
            run_persist_memory_v3(&pool, request.clone()).await.unwrap(),
            "inserted"
        );
        assert!(run_confirm_memory_candidate(&pool, &request.memory.id)
            .await
            .unwrap());

        let stale_pool = test_pool().await;
        let stale = semantic_fixture(&stale_pool).await;
        assert_eq!(
            run_persist_memory_v3(&stale_pool, stale.clone())
                .await
                .unwrap(),
            "inserted"
        );
        sqlx::query("UPDATE chat_messages SET content = '修改后的匿名消息' WHERE id = 'u1'")
            .execute(&stale_pool)
            .await
            .unwrap();
        assert!(!run_confirm_memory_candidate(&stale_pool, &stale.memory.id)
            .await
            .unwrap());

        let conflict_pool = test_pool().await;
        let conflict = semantic_fixture(&conflict_pool).await;
        assert_eq!(
            run_persist_memory_v3(&conflict_pool, conflict.clone())
                .await
                .unwrap(),
            "inserted"
        );
        sqlx::query("INSERT INTO memories (id,content,category,source,locked,status,scope_type,subject,fact_key,confidence,created_at,updated_at) VALUES ('existing','已确认事实','preference','manual_created',1,'active','global','用户','test_fact',1,1,1)")
            .execute(&conflict_pool).await.unwrap();
        assert!(
            !run_confirm_memory_candidate(&conflict_pool, &conflict.memory.id)
                .await
                .unwrap()
        );

        let forged_pool = test_pool().await;
        let mut forged = semantic_fixture(&forged_pool).await;
        let mut evidence: serde_json::Value =
            serde_json::from_str(&forged.memory.evidence).unwrap();
        evidence["evidenceQuote"] = serde_json::json!("伪造的原文");
        forged.memory.evidence = evidence.to_string();
        assert!(run_persist_memory_v3(&forged_pool, forged).await.is_err());

        let active_pool = test_pool().await;
        let mut active = semantic_fixture(&active_pool).await;
        active.memory.status = "active".into();
        assert!(run_persist_memory_v3(&active_pool, active).await.is_err());
    }

    #[tokio::test]
    async fn memory_v3_conflicting_facts_require_explicit_coexistence_and_unchanged_snapshots() {
        async fn setup(pool: &SqlitePool) -> PersistMemoryV2Request {
            let text = "我的业余爱好是画水彩画。";
            let mut request = memory_v3_fixture(
                pool,
                text,
                "用户的业余爱好是画水彩画",
                "画水彩画",
                "normal",
                "candidate",
            )
            .await;
            let old = "用户的业余爱好是收藏邮票";
            sqlx::query("INSERT INTO memories (id,content,category,source,locked,status,scope_type,subject,fact_key,confidence,created_at,updated_at) VALUES ('old',?,'preference','manual_created',1,'active','global','用户','test_fact',1,1700000000000,1700000000000)")
                .bind(old).execute(pool).await.unwrap();
            let mut evidence: serde_json::Value =
                serde_json::from_str(&request.memory.evidence).unwrap();
            evidence["reviewReason"] = serde_json::json!("semantic");
            evidence["evidenceQuote"] = serde_json::json!(text);
            evidence["conflicts"] = serde_json::json!([{ "id": "old", "contentHash": memory_content_version_hash(old), "updatedAt": 1700000000000_i64 }]);
            request.memory.evidence = evidence.to_string();
            request
        }
        let pool = test_pool().await;
        let request = setup(&pool).await;
        assert_eq!(
            run_persist_memory_v3(&pool, request.clone()).await.unwrap(),
            "inserted"
        );
        assert!(!run_confirm_memory_candidate(&pool, &request.memory.id)
            .await
            .unwrap());
        assert!(
            run_confirm_memory_candidate_with_coexist(&pool, &request.memory.id, true)
                .await
                .unwrap()
        );
        let active: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM memories WHERE status = 'active'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(active, 2);
        let old: (String, i64) =
            sqlx::query_as("SELECT content, locked FROM memories WHERE id = 'old'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(old, ("用户的业余爱好是收藏邮票".into(), 1));

        let replacement_pool = test_pool().await;
        let mut replacement = setup(&replacement_pool).await;
        replacement.memory.supersedes_id = Some("old".into());
        let mut evidence: serde_json::Value =
            serde_json::from_str(&replacement.memory.evidence).unwrap();
        evidence["replacement"] = evidence["conflicts"][0].clone();
        replacement.memory.evidence = evidence.to_string();
        assert_eq!(
            run_persist_memory_v3(&replacement_pool, replacement.clone())
                .await
                .unwrap(),
            "inserted"
        );
        assert!(
            run_confirm_memory_candidate(&replacement_pool, &replacement.memory.id)
                .await
                .unwrap()
        );
        let status: String = sqlx::query_scalar("SELECT status FROM memories WHERE id = 'old'")
            .fetch_one(&replacement_pool)
            .await
            .unwrap();
        assert_eq!(status, "superseded");

        let stale_pool = test_pool().await;
        let stale = setup(&stale_pool).await;
        assert_eq!(
            run_persist_memory_v3(&stale_pool, stale.clone())
                .await
                .unwrap(),
            "inserted"
        );
        sqlx::query("UPDATE memories SET content = '已有记忆已变化' WHERE id = 'old'")
            .execute(&stale_pool)
            .await
            .unwrap();
        assert!(
            !run_confirm_memory_candidate_with_coexist(&stale_pool, &stale.memory.id, true)
                .await
                .unwrap()
        );

        let extra_pool = test_pool().await;
        let extra = setup(&extra_pool).await;
        assert_eq!(
            run_persist_memory_v3(&extra_pool, extra.clone())
                .await
                .unwrap(),
            "inserted"
        );
        sqlx::query("INSERT INTO memories (id,content,category,source,locked,status,scope_type,subject,fact_key,confidence,created_at,updated_at) VALUES ('new','新增的已有事实','preference','manual_created',1,'active','global','user','test_fact',1,1,1)")
            .execute(&extra_pool).await.unwrap();
        assert!(
            !run_confirm_memory_candidate_with_coexist(&extra_pool, &extra.memory.id, true)
                .await
                .unwrap()
        );

        let forged_pool = test_pool().await;
        let mut forged = setup(&forged_pool).await;
        let mut evidence: serde_json::Value =
            serde_json::from_str(&forged.memory.evidence).unwrap();
        evidence["conflicts"][0]["contentHash"] = serde_json::json!("bad");
        forged.memory.evidence = evidence.to_string();
        assert_eq!(
            run_persist_memory_v3(&forged_pool, forged).await.unwrap(),
            "conflict"
        );
    }

    #[tokio::test]
    async fn memory_v3_merge_checks_version_and_does_not_overwrite_locked_memory() {
        for (source, locked, changed, expected) in [
            ("auto_extracted", 0, false, "inserted"),
            ("auto_extracted", 1, false, "conflict"),
            ("manual_created", 0, false, "conflict"),
            ("auto_extracted", 0, true, "conflict"),
        ] {
            let pool = test_pool().await;
            let mut request = memory_v3_fixture(
                &pool,
                "我长期从事软件开发。",
                "用户是长期从事软件开发的独立开发者",
                "软件开发",
                "normal",
                "active",
            )
            .await;
            let old = "用户是独立开发者";
            sqlx::query("INSERT INTO memories (id,content,category,source,locked,status,scope_type,subject,fact_key,confidence,created_at,updated_at) VALUES ('old',?,'preference',?,?,'active','global','user','old_fact',1,1700000000000,1700000000000)")
                .bind(if changed { "用户修改了旧事实" } else { old }).bind(source).bind(locked).execute(&pool).await.unwrap();
            request.merge = Some(MemoryReplacementSnapshot {
                id: "old".into(),
                content_hash: memory_content_version_hash(old),
                updated_at: 1700000000000,
            });
            assert_eq!(
                run_persist_memory_v3(&pool, request).await.unwrap(),
                expected
            );
            let actual: String =
                sqlx::query_scalar("SELECT content FROM memories WHERE id = 'old'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(
                actual,
                if expected == "inserted" {
                    "用户是长期从事软件开发的独立开发者"
                } else if changed {
                    "用户修改了旧事实"
                } else {
                    old
                }
            );
        }
    }

    #[tokio::test]
    async fn memory_v3_intake_is_atomic_idempotent_and_has_no_512_source_rejection() {
        let pool = test_pool().await;
        let request = global_intake_request("u1", 1_700_000_000_000);
        assert!(
            run_persist_chat_message_with_memory_intake(&pool, request.clone())
                .await
                .unwrap()
        );
        assert!(!run_persist_chat_message_with_memory_intake(&pool, request)
            .await
            .unwrap());
        for index in 2..=513 {
            let mut next = global_intake_request(&format!("u{index}"), 1_700_000_000_000 + index);
            next.message.content = format!("我喜欢技术回答先给结论 {index}");
            next.message.metadata =
                Some(serde_json::json!({"displayContent":next.message.content}).to_string());
            assert!(run_persist_chat_message_with_memory_intake(&pool, next)
                .await
                .unwrap());
        }
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM settings WHERE key LIKE 'memory-extraction:v3:intake:%'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(count, 513);

        let failing_pool = test_pool().await;
        sqlx::query("CREATE TRIGGER fail_v3_receipt BEFORE INSERT ON settings WHEN NEW.key LIKE 'memory-extraction:v3:intake:%' BEGIN SELECT RAISE(ABORT, 'injected failure'); END")
            .execute(&failing_pool).await.unwrap();
        assert!(run_persist_chat_message_with_memory_intake(
            &failing_pool,
            global_intake_request("rollback", 1_700_000_000_001)
        )
        .await
        .is_err());
        let messages: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM chat_messages WHERE id = 'rollback'")
                .fetch_one(&failing_pool)
                .await
                .unwrap();
        let sessions: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM chat_sessions WHERE id = 'global-session'")
                .fetch_one(&failing_pool)
                .await
                .unwrap();
        assert_eq!((messages, sessions), (0, 0));
    }

    #[tokio::test]
    async fn memory_v3_activates_normal_facts_and_requires_confirmation_for_sensitive_candidates() {
        let normal_pool = test_pool().await;
        let normal = memory_v3_fixture(
            &normal_pool,
            "我喜欢技术回答先给结论",
            "技术回答先给结论",
            "结论",
            "normal",
            "active",
        )
        .await;
        assert_eq!(
            run_persist_memory_v3(&normal_pool, normal.clone())
                .await
                .unwrap(),
            "inserted"
        );

        let sensitive_pool = test_pool().await;
        let sensitive = memory_v3_fixture(
            &sensitive_pool,
            "我长期有高血压，希望饮食清淡",
            "用户长期有高血压",
            "高血压",
            "sensitive",
            "candidate",
        )
        .await;
        assert_eq!(
            run_persist_memory_v3(&sensitive_pool, sensitive.clone())
                .await
                .unwrap(),
            "inserted"
        );
        assert!(
            run_confirm_memory_candidate(&sensitive_pool, &sensitive.memory.id)
                .await
                .unwrap()
        );

        let forged_pool = test_pool().await;
        let forged = memory_v3_fixture(
            &forged_pool,
            "我长期有高血压，希望饮食清淡",
            "用户长期有高血压",
            "高血压",
            "sensitive",
            "active",
        )
        .await;
        assert!(run_persist_memory_v3(&forged_pool, forged).await.is_err());
    }

    #[tokio::test]
    async fn memory_v3_rejects_secret_source_and_skips_existing_active_conflicts() {
        let secret_pool = test_pool().await;
        let secret = memory_v3_fixture(
            &secret_pool,
            "我的密码是ExampleSecret123",
            "技术回答先给结论",
            "结论",
            "normal",
            "active",
        )
        .await;
        assert!(run_persist_memory_v3(&secret_pool, secret).await.is_err());

        let conflict_pool = test_pool().await;
        let request = memory_v3_fixture(
            &conflict_pool,
            "我喜欢技术回答先给结论",
            "技术回答先给结论",
            "结论",
            "normal",
            "active",
        )
        .await;
        sqlx::query("INSERT INTO memories (id,content,category,source,locked,status,scope_type,scope_key,subject,fact_key,fact_value,confidence,created_at,updated_at) VALUES ('manual','技术回答先给推导','preference','manual_created',1,'active','global',NULL,'user','test_fact','推导',1,1,1)")
            .execute(&conflict_pool).await.unwrap();
        assert_eq!(
            run_persist_memory_v3(&conflict_pool, request)
                .await
                .unwrap(),
            "conflict"
        );
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM memories WHERE id LIKE 'mem-v3-%'")
                .fetch_one(&conflict_pool)
                .await
                .unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn memory_v2_atomic_receipt_prevents_resurrection_after_user_deletion() {
        let pool = test_pool().await;
        let request = memory_v2_fixture(&pool).await;
        assert_eq!(
            run_persist_memory_v2(&pool, request.clone()).await.unwrap(),
            "inserted"
        );
        sqlx::query("DELETE FROM memories WHERE id = ?")
            .bind(&request.memory.id)
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(
            run_persist_memory_v2(&pool, request.clone()).await.unwrap(),
            "already_applied"
        );
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM memories WHERE id = ?")
            .bind(&request.memory.id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn memory_v2_atomic_receipt_rolls_back_on_failure() {
        let pool = test_pool().await;
        let request = memory_v2_fixture(&pool).await;
        sqlx::query("CREATE TRIGGER fail_v2_operation BEFORE INSERT ON settings WHEN NEW.key LIKE 'memory-extraction:v2:op:%' BEGIN SELECT RAISE(ABORT, 'injected failure'); END")
            .execute(&pool).await.unwrap();
        assert!(run_persist_memory_v2(&pool, request.clone()).await.is_err());
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM memories WHERE id = ?")
            .bind(&request.memory.id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn memory_v2_rejects_changed_sources_and_lost_lease() {
        let pool = test_pool().await;
        let request = memory_v2_fixture(&pool).await;
        sqlx::query("UPDATE chat_messages SET metadata = '{}' WHERE id = 'u1'")
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(
            run_persist_memory_v2(&pool, request.clone()).await.unwrap(),
            "invalidated"
        );
        sqlx::query("UPDATE settings SET value = '{}' WHERE key = ?")
            .bind(&request.source.lease.key)
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(
            run_persist_memory_v2(&pool, request).await.unwrap(),
            "lost_lease"
        );
    }

    #[tokio::test]
    async fn memory_v2_rejects_tampered_source_hash_and_operation_identity() {
        let pool = test_pool().await;
        let request = memory_v2_fixture(&pool).await;
        let mut tampered_source = request.clone();
        let mut evidence: serde_json::Value =
            serde_json::from_str(&tampered_source.memory.evidence).unwrap();
        evidence["sources"][0]["textHash"] = serde_json::Value::String("a".repeat(64));
        tampered_source.memory.evidence = evidence.to_string();
        assert!(run_persist_memory_v2(&pool, tampered_source).await.is_err());

        let mut forged = request;
        forged.memory.subject = "someone".into();
        assert!(run_persist_memory_v2(&pool, forged).await.is_err());
    }

    #[tokio::test]
    async fn memory_v2_protects_manual_conflicts_and_rejects_forged_operation_ids() {
        let pool = test_pool().await;
        let mut request = memory_v2_fixture(&pool).await;
        sqlx::query("INSERT INTO memories (id,content,category,source,locked,status,scope_type,subject,fact_key,fact_value,confidence,created_at,updated_at) VALUES ('manual','技术回答先给推导','preference','manual_created',1,'active','global','user','answer_order','推导',1,1,1000)")
            .execute(&pool).await.unwrap();
        assert_eq!(
            run_persist_memory_v2(&pool, request.clone()).await.unwrap(),
            "conflict"
        );
        let mut evidence: serde_json::Value =
            serde_json::from_str(&request.memory.evidence).unwrap();
        evidence["replacement"] = serde_json::json!({"id":"manual","contentHash":memory_content_version_hash("技术回答先给推导"),"updatedAt":1_000_000});
        request.memory.evidence = evidence.to_string();
        request.memory.supersedes_id = Some("manual".into());
        assert_eq!(
            run_persist_memory_v2(&pool, request.clone()).await.unwrap(),
            "inserted"
        );
        let status: String = sqlx::query_scalar("SELECT status FROM memories WHERE id = 'manual'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(status, "active");
        let mut duplicate = request.clone();
        duplicate.operation_id = "d".repeat(64);
        duplicate.memory.id = format!("mem-v2-{}", duplicate.operation_id);
        assert!(run_persist_memory_v2(&pool, duplicate).await.is_err());
    }

    #[tokio::test]
    async fn memory_v2_only_activates_direct_supported_sources_and_rejects_secrets() {
        let pool = test_pool().await;
        let mut request = memory_v2_fixture(&pool).await;
        request.memory.status = "active".into();
        assert_eq!(
            run_persist_memory_v2(&pool, request.clone()).await.unwrap(),
            "inserted"
        );
        let mut secret = request.clone();
        secret.operation_id = "d".repeat(64);
        secret.memory.id = format!("mem-v2-{}", secret.operation_id);
        secret.memory.content = "手机号码 13800138000 作为结论".into();
        assert!(run_persist_memory_v2(&pool, secret).await.is_err());
        request.operation_id = "e".repeat(64);
        request.memory.id = format!("mem-v2-{}", request.operation_id);
        request.memory.fact_value = "英语".into();
        request.memory.content = "技术回答先给英语结论".into();
        assert!(run_persist_memory_v2(&pool, request).await.is_err());
    }

    #[tokio::test]
    async fn memory_intake_is_atomic_and_keeps_stable_scope_epochs() {
        let pool = test_pool().await;
        intake_session(&pool).await;
        assert!(run_persist_memory_intake(&pool, intake("u1", Some("P")))
            .await
            .unwrap());
        assert!(!run_persist_memory_intake(&pool, intake("u1", Some("P")))
            .await
            .unwrap());
        assert!(run_persist_memory_intake(&pool, intake("u2", Some("Q")))
            .await
            .unwrap());
        assert!(run_persist_memory_intake(&pool, intake("u3", Some("P")))
            .await
            .unwrap());
        let rows = sqlx::query("SELECT key, value FROM settings WHERE key LIKE 'memory-extraction:v2:intake:%' ORDER BY key")
            .fetch_all(&pool).await.unwrap();
        assert_eq!(rows.len(), 3);
        for (index, row) in rows.iter().enumerate() {
            let value: String = row.try_get("value").unwrap();
            assert!(!value.contains("匿名对话内容"));
            let value: serde_json::Value = serde_json::from_str(&value).unwrap();
            assert_eq!(value["sequence"].as_u64(), Some(index as u64 + 1));
            assert_eq!(value["epoch"].as_u64(), Some(index as u64));
            assert_eq!(value["status"], "pending");
        }
        assert!(run_persist_memory_intake(&pool, intake("u1", Some("Q")))
            .await
            .is_err());
        assert!(run_persist_memory_intake(&pool, intake("u1", Some("P")))
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn memory_intake_never_restores_deleted_or_modified_sources() {
        let pool = test_pool().await;
        intake_session(&pool).await;
        let request = intake("u1", None);
        assert!(run_persist_memory_intake(&pool, request.clone())
            .await
            .unwrap());
        let mut changed_time = request.clone();
        changed_time.message.created_at += 1;
        assert!(run_persist_memory_intake(&pool, changed_time)
            .await
            .is_err());
        sqlx::query("UPDATE chat_messages SET metadata = '{}' WHERE id = 'u1'")
            .execute(&pool)
            .await
            .unwrap();
        assert!(run_persist_memory_intake(&pool, request.clone())
            .await
            .is_err());
        sqlx::query("DELETE FROM chat_messages WHERE id = 'u1'")
            .execute(&pool)
            .await
            .unwrap();
        assert!(run_persist_memory_intake(&pool, request).await.is_err());
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM chat_messages WHERE id = 'u1'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn memory_intake_full_capacity_preserves_saved_source_and_rejects_registration() {
        let pool = test_pool().await;
        intake_session(&pool).await;
        let request = intake("capacity-source", Some("P"));
        sqlx::query("INSERT INTO chat_messages (id, session_id, role, parent_id, content, metadata, created_at) VALUES (?, ?, 'user', NULL, ?, ?, ?)")
            .bind(&request.message.id).bind(&request.message.session_id).bind(&request.message.content)
            .bind(&request.message.metadata).bind(request.message.created_at).execute(&pool).await.unwrap();
        for index in 0..512 {
            let receipt = serde_json::json!({"version":2,"sourceId":format!("old-{index}"),
                "sessionId":"s","scopeKey":null,"epoch":0,"sequence":index + 1,
                "sourceFingerprint":"a".repeat(64),"status":"pending","createdAt":1});
            sqlx::query("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch())")
                .bind(format!("memory-extraction:v2:intake:old-{index}"))
                .bind(receipt.to_string())
                .execute(&pool)
                .await
                .unwrap();
        }
        assert_eq!(
            run_persist_memory_intake(&pool, request).await.unwrap_err(),
            "memory_intake_capacity"
        );
        let source_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM chat_messages WHERE id = 'capacity-source'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(source_count, 1);
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM settings WHERE key = 'memory-extraction:v2:intake:capacity-source' OR key = 'memory-extraction:v2:outbox:capacity-source'")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn memory_intake_caps_pending_receipts_without_committing_a_new_source() {
        let pool = test_pool().await;
        intake_session(&pool).await;
        for index in 0..512 {
            let receipt = serde_json::json!({"version":2,"sourceId":format!("old-{index}"),
                "sessionId":"s","scopeKey":null,"epoch":0,"sequence":index + 1,
                "sourceFingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "status":"pending","createdAt":1});
            sqlx::query("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch())")
                .bind(format!("memory-extraction:v2:intake:old-{index}"))
                .bind(receipt.to_string())
                .execute(&pool)
                .await
                .unwrap();
        }
        assert_eq!(
            run_persist_memory_intake(&pool, intake("u1", None))
                .await
                .unwrap_err(),
            "memory_intake_capacity"
        );
        let source_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM chat_messages WHERE id = 'u1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        let receipt_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM settings WHERE key = 'memory-extraction:v2:intake:u1'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(source_count, 0);
        assert_eq!(receipt_count, 0);
    }

    #[tokio::test]
    async fn memory_intake_rolls_back_message_if_receipt_write_fails() {
        let pool = test_pool().await;
        intake_session(&pool).await;
        // Fail after source insertion, not before the transaction starts.
        sqlx::query("CREATE TRIGGER fail_intake BEFORE INSERT ON settings BEGIN SELECT RAISE(ABORT, 'injected failure'); END")
            .execute(&pool).await.unwrap();
        assert!(run_persist_memory_intake(&pool, intake("u1", None))
            .await
            .is_err());
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM chat_messages WHERE id = 'u1'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
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
            artifact_categories: Vec::new(),
            artifact_organization: Vec::new(),
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
    async fn artifact_organization_partial_updates_category_removal_and_backup() {
        let pool = test_pool().await;
        let mut payload = backup_with_artifact();
        payload.artifact_categories = vec![ArtifactCategoryInput {
            id: "category-1".into(),
            name: "主题".into(),
        }];
        payload.artifact_organization = vec![ArtifactOrganizationInput {
            artifact_key: "ai:artifact-1".into(),
            favorite: true,
            category_ids: vec!["category-1".into()],
        }];
        run_import_backup(&pool, payload).await.unwrap();
        let mut tx = pool.begin().await.unwrap();
        write_artifact_organization(&mut tx, "ai:artifact-1", Some(false), None)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        let row = sqlx::query("SELECT favorite, category_ids FROM reading_artifact_organization")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(row.get::<i64, _>("favorite"), 0);
        assert_eq!(row.get::<String, _>("category_ids"), "[\"category-1\"]");
        let mut tx = pool.begin().await.unwrap();
        write_artifact_organization(&mut tx, "ai:artifact-1", Some(true), None)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        remove_artifact_category(&pool, "category-1").await.unwrap();
        let row = sqlx::query("SELECT favorite, category_ids FROM reading_artifact_organization")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(row.get::<i64, _>("favorite"), 1);
        assert_eq!(row.get::<String, _>("category_ids"), "[]");
        let content: String =
            sqlx::query_scalar("SELECT content FROM reading_artifacts WHERE id = 'artifact-1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(!content.is_empty());
        let mut tx = pool.begin().await.unwrap();
        assert!(
            write_artifact_organization(&mut tx, "ai:missing", Some(true), None)
                .await
                .is_err()
        );
        assert!(write_artifact_organization(
            &mut tx,
            "ai:artifact-1",
            None,
            Some(&["missing".into()])
        )
        .await
        .is_err());
        tx.rollback().await.unwrap();
    }

    #[tokio::test]
    async fn backup_import_merges_category_names_and_remaps_references() {
        for (categories, expected_ids) in [
            (vec![("backup-a", "主题A")], vec!["local-a"]),
            (vec![("local-a", "主题A")], vec!["local-a"]),
            (vec![("local-a", "新名称")], vec!["local-a"]),
            (vec![("local-a", "主题B")], vec!["local-b"]),
            (
                vec![("local-a", "主题B"), ("local-b", "主题A")],
                vec!["local-b", "local-a"],
            ),
            (
                vec![("backup-a", "主题A"), ("backup-b", "主题A")],
                vec!["local-a"],
            ),
            (
                vec![("backup-a", "主题A"), ("local-a", "新名称")],
                vec!["local-a"],
            ),
        ] {
            let pool = test_pool().await;
            for (id, name) in [("local-a", "主题A"), ("local-b", "主题B")] {
                sqlx::query("INSERT INTO reading_artifact_categories (id, name) VALUES (?, ?)")
                    .bind(id)
                    .bind(name)
                    .execute(&pool)
                    .await
                    .unwrap();
            }
            // Repeated imports must remain idempotent and keep local category rows.
            for _ in 0..2 {
                let mut payload = backup_with_artifact();
                payload.artifact_categories = categories
                    .iter()
                    .map(|(id, name)| ArtifactCategoryInput {
                        id: (*id).into(),
                        name: (*name).into(),
                    })
                    .collect();
                payload.artifact_organization = vec![ArtifactOrganizationInput {
                    artifact_key: "ai:artifact-1".into(),
                    favorite: true,
                    category_ids: categories.iter().map(|(id, _)| (*id).into()).collect(),
                }];
                let summary = run_import_backup(&pool, payload).await.unwrap();
                assert_eq!(summary.artifacts, 1);
                let (favorite, ids): (i64, String) = sqlx::query_as(
                    "SELECT favorite, category_ids FROM reading_artifact_organization WHERE artifact_key = 'ai:artifact-1'",
                )
                .fetch_one(&pool)
                .await
                .unwrap();
                assert_eq!(favorite, 1);
                assert_eq!(
                    serde_json::from_str::<Vec<String>>(&ids).unwrap(),
                    expected_ids
                );
                let count: i64 =
                    sqlx::query_scalar("SELECT COUNT(*) FROM reading_artifact_categories")
                        .fetch_one(&pool)
                        .await
                        .unwrap();
                assert_eq!(count, 2);
                let names: Vec<(String, String)> =
                    sqlx::query_as("SELECT id, name FROM reading_artifact_categories ORDER BY id")
                        .fetch_all(&pool)
                        .await
                        .unwrap();
                assert_eq!(
                    names,
                    vec![
                        ("local-a".into(), "主题A".into()),
                        ("local-b".into(), "主题B".into())
                    ]
                );
            }
        }
    }

    #[tokio::test]
    async fn artifact_organization_invalid_backup_rolls_back_sources_and_categories() {
        let pool = test_pool().await;
        let mut payload = backup_with_artifact();
        payload.artifact_categories = vec![ArtifactCategoryInput {
            id: "category-1".into(),
            name: "主题".into(),
        }];
        payload.artifact_organization = vec![ArtifactOrganizationInput {
            artifact_key: "ai:artifact-1".into(),
            favorite: true,
            category_ids: vec!["missing".into()],
        }];
        assert!(run_import_backup(&pool, payload).await.is_err());
        for table in [
            "reading_artifacts",
            "reading_artifact_categories",
            "reading_artifact_organization",
        ] {
            let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(count, 0);
        }
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
    async fn candidate_confirmation_rejects_stale_replacement() {
        let pool = test_pool().await;
        for (id, status, supersedes_id) in [
            ("old", "superseded", None),
            ("current", "active", None),
            ("stale", "candidate", Some("old")),
        ] {
            sqlx::query("INSERT INTO memories (id, content, category, source, locked, status, scope_type, confidence, supersedes_id, created_at, updated_at) VALUES (?, '匿名事实', 'preference', 'auto_extracted', 0, ?, 'global', 1, ?, 1, 1)")
                .bind(id).bind(status).bind(supersedes_id).execute(&pool).await.unwrap();
        }
        assert!(!run_confirm_memory_candidate(&pool, "stale").await.unwrap());
        let active: Vec<String> =
            sqlx::query_scalar("SELECT id FROM memories WHERE status = 'active'")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(active, vec!["current"]);
        let status: String = sqlx::query_scalar("SELECT status FROM memories WHERE id = 'stale'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(status, "candidate");
    }

    #[tokio::test]
    async fn candidate_confirmation_rejects_cross_scope_replacement() {
        let pool = test_pool().await;
        for (id, status, scope_key, supersedes_id) in [
            ("other", "active", "d:/anonymous/b", None),
            ("candidate", "candidate", "d:/anonymous/a", Some("other")),
        ] {
            sqlx::query("INSERT INTO memories (id, content, category, source, locked, status, scope_type, scope_key, confidence, supersedes_id, created_at, updated_at) VALUES (?, '匿名项目事实', 'project', 'auto_extracted', 0, ?, 'project', ?, 1, ?, 1, 1)")
                .bind(id).bind(status).bind(scope_key).bind(supersedes_id).execute(&pool).await.unwrap();
        }
        assert!(!run_confirm_memory_candidate(&pool, "candidate")
            .await
            .unwrap());
        let status: String = sqlx::query_scalar("SELECT status FROM memories WHERE id = 'other'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(status, "active");
    }

    #[tokio::test]
    async fn candidate_confirmation_checks_replacement_content_version() {
        // Fixture computed by memoryPolicy.contentHash, including a UTF-16 surrogate pair.
        assert_eq!(memory_content_version_hash("匿名旧事实😀"), "78cb990a");
        for (current_content, expected) in [("匿名旧事实😀", true), ("用户刚修改的事实", false)]
        {
            let pool = test_pool().await;
            sqlx::query("INSERT INTO memories (id, content, category, source, locked, status, scope_type, confidence, created_at, updated_at) VALUES ('old', ?, 'preference', 'manual_created', 0, 'active', 'global', 1, 1, 1)")
                .bind(current_content).execute(&pool).await.unwrap();
            let evidence = serde_json::json!({
                "version": 1, "replacement": { "id": "old", "contentHash": "78cb990a", "updatedAt": 1000 }
            }).to_string();
            sqlx::query("INSERT INTO memories (id, content, category, source, locked, status, scope_type, confidence, supersedes_id, evidence, created_at, updated_at) VALUES ('candidate', '匿名新事实', 'preference', 'auto_extracted', 0, 'candidate', 'global', 1, 'old', ?, 1, 1)")
                .bind(evidence).execute(&pool).await.unwrap();
            assert_eq!(
                run_confirm_memory_candidate(&pool, "candidate")
                    .await
                    .unwrap(),
                expected
            );
            let old_status: String =
                sqlx::query_scalar("SELECT status FROM memories WHERE id = 'old'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(old_status, if expected { "superseded" } else { "active" });
        }
    }

    #[tokio::test]
    async fn candidate_confirmation_enforces_v2_evidence_and_replacement_snapshot() {
        for (version, has_replacement, current_content, expected) in [
            (2, true, "匿名旧事实😀", true),
            (2, true, "用户刚修改的事实", false),
            (2, false, "匿名旧事实😀", false),
            (3, true, "匿名旧事实😀", false),
        ] {
            let pool = test_pool().await;
            sqlx::query("INSERT INTO memories (id, content, category, source, locked, status, scope_type, confidence, created_at, updated_at) VALUES ('old', ?, 'preference', 'manual_created', 0, 'active', 'global', 1, 1, 1)")
                .bind(current_content).execute(&pool).await.unwrap();
            let mut evidence = serde_json::json!({ "version": version, "policyVersion": 2, "kind": "semantic", "sourceId": "u1",
                "sessionId": "s", "windowId": "window:1", "excerpt": "匿名用户消息", "sources": [{ "id": "u1", "sessionId": "s",
                "role": "user", "parentId": null, "sequence": 1, "createdAt": 1000, "textHash": "a".repeat(64) }] });
            if has_replacement {
                evidence["replacement"] = serde_json::json!({ "id": "old", "contentHash": "78cb990a", "updatedAt": 1000 });
            }
            sqlx::query("INSERT INTO memories (id, content, category, source, locked, status, scope_type, confidence, supersedes_id, evidence, created_at, updated_at) VALUES ('mem-v2-candidate', '匿名新事实', 'preference', 'auto_extracted', 0, 'candidate', 'global', 1, 'old', ?, 1, 1)")
                .bind(evidence.to_string()).execute(&pool).await.unwrap();
            assert_eq!(
                run_confirm_memory_candidate(&pool, "mem-v2-candidate")
                    .await
                    .unwrap(),
                expected
            );
            let old_status: String =
                sqlx::query_scalar("SELECT status FROM memories WHERE id = 'old'")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!(old_status, if expected { "superseded" } else { "active" });
        }
    }

    #[tokio::test]
    async fn candidate_confirmation_rejects_malformed_v2_even_without_replacement() {
        let pool = test_pool().await;
        sqlx::query("INSERT INTO memories (id, content, category, source, locked, status, scope_type, confidence, evidence, created_at, updated_at) VALUES ('mem-v2-bad', '匿名新事实', 'preference', 'auto_extracted', 0, 'candidate', 'global', 1, '{\"version\":2}', 1, 1)")
            .execute(&pool).await.unwrap();
        assert!(!run_confirm_memory_candidate(&pool, "mem-v2-bad")
            .await
            .unwrap());
        let status: String =
            sqlx::query_scalar("SELECT status FROM memories WHERE id = 'mem-v2-bad'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(status, "candidate");
    }

    #[tokio::test]
    async fn candidate_confirmation_keeps_legacy_nonreplacement_json_evidence() {
        let pool = test_pool().await;
        sqlx::query("INSERT INTO memories (id, content, category, source, locked, status, scope_type, confidence, evidence, created_at, updated_at) VALUES ('legacy', '匿名旧事实', 'preference', 'auto_extracted', 0, 'candidate', 'global', 1, '{\"version\":\"user-text\"}', 1, 1)")
            .execute(&pool).await.unwrap();
        assert!(run_confirm_memory_candidate(&pool, "legacy").await.unwrap());
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
