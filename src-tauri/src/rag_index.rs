use futures_util::TryStreamExt;
use serde::{Deserialize, Serialize};
use sqlx::{
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    QueryBuilder, Row, Sqlite, SqlitePool,
};
use std::{
    cmp::Ordering,
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{Arc, Mutex, RwLock},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, State};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum IndexStatus {
    #[default]
    Idle,
    Initializing,
    Ready,
    Failed,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RagIndexStateResponse {
    status: IndexStatus,
    document_count: usize,
    chunk_count: usize,
    valid_vector_count: usize,
    skipped_vector_count: usize,
    error: Option<String>,
}

#[derive(Clone, Debug)]
enum PendingChange {
    Refresh,
    Remove,
}

#[derive(Default)]
struct IndexControl {
    status: IndexStatus,
    index: Option<Arc<RwLock<RagIndex>>>,
    skipped_vectors: usize,
    error: Option<String>,
    pending_changes: HashMap<String, PendingChange>,
}

#[derive(Default)]
pub struct RagIndexService {
    control: Mutex<IndexControl>,
    notify: tokio::sync::Notify,
    initialization_cancellation: Mutex<Option<CancellationToken>>,
}

#[derive(Clone, Debug)]
struct DocumentRecord {
    id: String,
    file_path: String,
    title: String,
    last_modified: i64,
}

#[derive(Clone, Debug)]
struct ChunkRecord {
    id: String,
    document_id: String,
    content: String,
    content_hash: Option<String>,
    index: i64,
    start_line: i64,
    end_line: i64,
    title_path: Vec<String>,
    heading: Option<String>,
    source_type: String,
    embedding: Option<Vec<f32>>,
}

#[derive(Default)]
struct RagIndex {
    documents: HashMap<String, DocumentRecord>,
    chunks: Vec<ChunkRecord>,
    vector_dimension: Option<usize>,
}

#[derive(Clone, Debug)]
struct RawDocument {
    id: String,
    file_path: String,
    title: String,
    last_modified: i64,
}

#[derive(Clone, Debug)]
struct RawChunk {
    id: String,
    document_id: String,
    content: String,
    content_hash: Option<String>,
    index: i64,
    start_line: i64,
    end_line: i64,
    title_path: Option<String>,
    heading: Option<String>,
    source_type: String,
    embedding: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RagSearchRequest {
    query_text: String,
    query_vector: Option<Vec<f32>>,
    top_k: usize,
    threshold: f32,
    #[serde(default)]
    file_paths: Vec<String>,
    #[serde(default = "default_true")]
    keyword_search_enabled: bool,
    current_file_path: Option<String>,
    #[serde(default)]
    prefer_current_file: bool,
    #[serde(default)]
    prefer_recent_documents: bool,
    #[serde(default)]
    keyword_only_fallback: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RagSearchHit {
    chunk: RagSearchChunk,
    document: RagSearchDocument,
    score: f32,
    retrieval_mode: &'static str,
    keyword_score: Option<f32>,
    vector_score: Option<f32>,
    neighbor_chunks: Vec<RagSearchChunk>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RagSearchChunk {
    id: String,
    document_id: String,
    content: String,
    content_hash: Option<String>,
    index: i64,
    start_line: i64,
    end_line: i64,
    title_path: Vec<String>,
    heading: Option<String>,
    source_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    context_role: Option<&'static str>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RagSearchDocument {
    id: String,
    file_path: String,
    title: String,
    last_modified: i64,
}

#[derive(Clone, Debug)]
struct RankedHit {
    chunk_index: usize,
    score: f32,
    keyword_score: Option<f32>,
    vector_score: Option<f32>,
    retrieval_mode: &'static str,
}

fn normalize_path(path: &str) -> String {
    let mut value = path.trim().replace('\\', "/").to_lowercase();
    if let Some(rest) = value.strip_prefix("//?/unc/") {
        value = format!("//{rest}");
    } else if let Some(rest) = value.strip_prefix("//?/") {
        value = rest.to_string();
    }
    while value.contains("//") && !value.starts_with("//") {
        value = value.replace("//", "/");
    }
    value
}

fn database_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|path| path.join("guanmo.db"))
        .map_err(|error| error.to_string())
}

async fn open_readonly_pool(path: PathBuf) -> Result<SqlitePool, String> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .create_if_missing(false);
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(|error| error.to_string())
}

#[cfg(test)]
async fn load_raw_index(
    pool: &SqlitePool,
    include_embeddings: bool,
) -> Result<(Vec<RawDocument>, Vec<RawChunk>), String> {
    let document_rows = sqlx::query("SELECT id, file_path, title, last_modified FROM documents")
        .fetch_all(pool)
        .await
        .map_err(|error| error.to_string())?;
    let chunk_query = if include_embeddings {
        "SELECT c.id, c.document_id, c.content, c.content_hash, c.chunk_index, c.start_line, \
         c.end_line, c.title_path, c.heading, c.source_type, CAST(e.embedding AS TEXT) AS embedding \
         FROM chunks c LEFT JOIN embeddings e ON e.chunk_id = c.id ORDER BY c.document_id, c.chunk_index"
    } else {
        "SELECT c.id, c.document_id, c.content, c.content_hash, c.chunk_index, c.start_line, \
         c.end_line, c.title_path, c.heading, c.source_type, NULL AS embedding \
         FROM chunks c ORDER BY c.document_id, c.chunk_index"
    };
    let chunk_rows = sqlx::query(chunk_query)
        .fetch_all(pool)
        .await
        .map_err(|error| error.to_string())?;
    let documents = document_rows
        .into_iter()
        .map(|row| RawDocument {
            id: row.get("id"),
            file_path: row.get("file_path"),
            title: row.get("title"),
            last_modified: row.get("last_modified"),
        })
        .collect();
    let chunks = chunk_rows
        .into_iter()
        .map(|row| RawChunk {
            id: row.get("id"),
            document_id: row.get("document_id"),
            content: row.get("content"),
            content_hash: row.get("content_hash"),
            index: row.get("chunk_index"),
            start_line: row.get("start_line"),
            end_line: row.get("end_line"),
            title_path: row.get("title_path"),
            heading: row.get("heading"),
            source_type: row.get("source_type"),
            embedding: row.get("embedding"),
        })
        .collect();
    Ok((documents, chunks))
}

fn memory_allows_index(
    snapshot: &crate::perf_monitor::SystemMemorySnapshot,
    budget_mb: u64,
) -> bool {
    snapshot
        .available_physical_mb
        .min(snapshot.available_commit_mb)
        >= 512_u64.saturating_add(budget_mb)
}

fn check_initialization_resources(cancellation: &CancellationToken) -> Result<(), String> {
    if cancellation.is_cancelled() {
        return Err("RAG index initialization cancelled".into());
    }
    if !memory_allows_index(&crate::perf_monitor::get_system_memory_snapshot()?, 0) {
        return Err("RAG index memory pressure".into());
    }
    Ok(())
}

const INDEX_BATCH_SIZE: i64 = 64;

// One JSON batch coexists with the final index. Always join the blocking worker
// before returning, including pressure/cancellation, so no detached build survives.
async fn load_batched_index<F>(
    pool: &SqlitePool,
    path: Option<&str>,
    check: F,
) -> Result<(RagIndex, usize), String>
where
    F: Fn() -> Result<(), String> + Send + Sync + Clone + 'static,
{
    check()?;
    let mut index = RagIndex::default();
    let mut rows =
        sqlx::query("SELECT id, file_path, title, last_modified FROM documents").fetch(pool);
    while let Some(row) = rows.try_next().await.map_err(|error| error.to_string())? {
        check()?;
        let file_path: String = row.get("file_path");
        if path.is_some_and(|path| normalize_path(path) != normalize_path(&file_path)) {
            continue;
        }
        let id: String = row.get("id");
        index.documents.insert(
            id.clone(),
            DocumentRecord {
                id,
                file_path,
                title: row.get("title"),
                last_modified: row.get("last_modified"),
            },
        );
    }
    drop(rows);
    let document_id = if path.is_some() {
        index.documents.keys().next().cloned()
    } else {
        None
    };
    if path.is_some() && document_id.is_none() {
        return Ok((index, 0));
    }
    let mut cursor = None;
    let mut skipped = 0;
    let mut dimensions = HashMap::<usize, usize>::new();
    loop {
        check()?;
        let mut sql = QueryBuilder::<Sqlite>::new(
            "SELECT c.rowid AS cursor, c.id, c.document_id, c.content, c.content_hash, c.chunk_index, \
             c.start_line, c.end_line, c.title_path, c.heading, c.source_type, CAST(e.embedding AS TEXT) AS embedding \
             FROM chunks c LEFT JOIN embeddings e ON e.chunk_id = c.id WHERE 1=1"
        );
        if let Some(cursor) = cursor {
            sql.push(" AND c.rowid > ").push_bind(cursor);
        }
        if let Some(id) = &document_id {
            sql.push(" AND c.document_id = ").push_bind(id);
        }
        sql.push(" ORDER BY c.rowid LIMIT ")
            .push_bind(INDEX_BATCH_SIZE);
        let rows = sql
            .build()
            .fetch_all(pool)
            .await
            .map_err(|error| error.to_string())?;
        if rows.is_empty() {
            break;
        }
        cursor = rows.last().map(|row| row.get::<i64, _>("cursor"));
        check()?;
        let chunks: Vec<_> = rows.iter().map(|row| raw_chunk_row(row, true)).collect();
        drop(rows);
        let worker_check = check.clone();
        (index, skipped, dimensions) = tauri::async_runtime::spawn_blocking(move || {
            for raw in chunks {
                worker_check()?;
                let has_embedding = raw.embedding.is_some();
                let embedding = parse_embedding(raw.embedding);
                if let Some(vector) = &embedding {
                    *dimensions.entry(vector.len()).or_default() += 1;
                } else if has_embedding {
                    skipped += 1;
                }
                index.chunks.push(ChunkRecord {
                    id: raw.id,
                    document_id: raw.document_id,
                    content: raw.content,
                    content_hash: raw.content_hash,
                    index: raw.index,
                    start_line: raw.start_line,
                    end_line: raw.end_line,
                    title_path: parse_title_path(raw.title_path),
                    heading: raw.heading,
                    source_type: raw.source_type,
                    embedding,
                });
            }
            Ok::<_, String>((index, skipped, dimensions))
        })
        .await
        .map_err(|error| error.to_string())??;
    }
    let worker_check = check.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let dimension = dimensions
            .into_iter()
            .max_by_key(|(_, count)| *count)
            .map(|(dimension, _)| dimension);
        for chunk in &mut index.chunks {
            worker_check()?;
            if chunk
                .embedding
                .as_ref()
                .is_some_and(|vector| Some(vector.len()) != dimension)
            {
                chunk.embedding = None;
                skipped += 1;
            }
        }
        index.vector_dimension = dimension;
        worker_check()?;
        Ok((index, skipped))
    })
    .await
    .map_err(|error| error.to_string())?
}

async fn admit_initialization(pool: &SqlitePool) -> Result<(), String> {
    let snapshot = crate::perf_monitor::get_system_memory_snapshot()?;
    if !memory_allows_index(&snapshot, 128) {
        return Err("RAG index memory budget unavailable".into());
    }
    let row = sqlx::query(
        "SELECT (SELECT COALESCE(SUM(length(CAST(content AS BLOB))), 0) FROM chunks) \
         + (SELECT COALESCE(SUM(length(CAST(embedding AS BLOB))), 0) FROM embeddings) AS bytes, \
         (SELECT COUNT(*) FROM chunks) AS chunks, (SELECT COUNT(*) FROM documents) AS documents",
    )
    .fetch_one(pool)
    .await
    .map_err(|error| error.to_string())?;
    let bytes = row.get::<i64, _>("bytes").max(0) as u64;
    let budget = bytes
        .saturating_mul(6)
        .saturating_add((row.get::<i64, _>("chunks").max(0) as u64).saturating_mul(2048))
        .saturating_add((row.get::<i64, _>("documents").max(0) as u64).saturating_mul(1024))
        .div_ceil(1024 * 1024)
        .max(128);
    if memory_allows_index(&crate::perf_monitor::get_system_memory_snapshot()?, budget) {
        Ok(())
    } else {
        Err("RAG index memory budget unavailable".into())
    }
}

async fn load_raw_document(
    pool: &SqlitePool,
    file_path: &str,
) -> Result<Option<(RawDocument, Vec<RawChunk>)>, String> {
    let rows = sqlx::query("SELECT id, file_path, title, last_modified FROM documents")
        .fetch_all(pool)
        .await
        .map_err(|error| error.to_string())?;
    let target = normalize_path(file_path);
    let Some(row) = rows
        .into_iter()
        .find(|row| normalize_path(row.get::<String, _>("file_path").as_str()) == target)
    else {
        return Ok(None);
    };
    let document = RawDocument {
        id: row.get("id"),
        file_path: row.get("file_path"),
        title: row.get("title"),
        last_modified: row.get("last_modified"),
    };
    let chunk_rows = sqlx::query(
        "SELECT c.id, c.document_id, c.content, c.content_hash, c.chunk_index, c.start_line, \
         c.end_line, c.title_path, c.heading, c.source_type, CAST(e.embedding AS TEXT) AS embedding \
         FROM chunks c LEFT JOIN embeddings e ON e.chunk_id = c.id \
         WHERE c.document_id = ? ORDER BY c.chunk_index"
    ).bind(&document.id).fetch_all(pool).await.map_err(|error| error.to_string())?;
    let chunks = chunk_rows
        .into_iter()
        .map(|row| RawChunk {
            id: row.get("id"),
            document_id: row.get("document_id"),
            content: row.get("content"),
            content_hash: row.get("content_hash"),
            index: row.get("chunk_index"),
            start_line: row.get("start_line"),
            end_line: row.get("end_line"),
            title_path: row.get("title_path"),
            heading: row.get("heading"),
            source_type: row.get("source_type"),
            embedding: row.get("embedding"),
        })
        .collect();
    Ok(Some((document, chunks)))
}

fn parse_embedding(value: Option<String>) -> Option<Vec<f32>> {
    let vector: Vec<f32> = serde_json::from_str(value?.as_str()).ok()?;
    (!vector.is_empty() && vector.iter().all(|item| item.is_finite())).then_some(vector)
}

fn parse_title_path(value: Option<String>) -> Vec<String> {
    value
        .and_then(|text| serde_json::from_str::<Vec<String>>(&text).ok())
        .unwrap_or_default()
}

fn build_index(documents: Vec<RawDocument>, chunks: Vec<RawChunk>) -> (RagIndex, usize) {
    let parsed: Vec<Option<Vec<f32>>> = chunks
        .iter()
        .map(|chunk| parse_embedding(chunk.embedding.clone()))
        .collect();
    let mut dimensions = HashMap::<usize, usize>::new();
    for vector in parsed.iter().flatten() {
        *dimensions.entry(vector.len()).or_default() += 1;
    }
    let dimension = dimensions
        .into_iter()
        .max_by_key(|(_, count)| *count)
        .map(|(dimension, _)| dimension);
    let mut skipped = 0;
    let chunks = chunks
        .into_iter()
        .zip(parsed)
        .map(|(chunk, vector)| {
            let embedding = match (vector, dimension) {
                (Some(vector), Some(expected)) if vector.len() == expected => Some(vector),
                (Some(_), _) => {
                    skipped += 1;
                    None
                }
                (None, _) => {
                    if chunk.embedding.is_some() {
                        skipped += 1;
                    }
                    None
                }
            };
            ChunkRecord {
                id: chunk.id,
                document_id: chunk.document_id,
                content: chunk.content,
                content_hash: chunk.content_hash,
                index: chunk.index,
                start_line: chunk.start_line,
                end_line: chunk.end_line,
                title_path: parse_title_path(chunk.title_path),
                heading: chunk.heading,
                source_type: chunk.source_type,
                embedding,
            }
        })
        .collect();
    let documents = documents
        .into_iter()
        .map(|doc| {
            (
                doc.id.clone(),
                DocumentRecord {
                    id: doc.id,
                    file_path: doc.file_path,
                    title: doc.title,
                    last_modified: doc.last_modified,
                },
            )
        })
        .collect();
    (
        RagIndex {
            documents,
            chunks,
            vector_dimension: dimension,
        },
        skipped,
    )
}

fn state_response(control: &IndexControl) -> RagIndexStateResponse {
    let (document_count, chunk_count, valid_vector_count) = control
        .index
        .as_ref()
        .and_then(|index| index.read().ok())
        .map(|index| {
            (
                index.documents.len(),
                index.chunks.len(),
                index
                    .chunks
                    .iter()
                    .filter(|chunk| chunk.embedding.is_some())
                    .count(),
            )
        })
        .unwrap_or_default();
    RagIndexStateResponse {
        status: control.status,
        document_count,
        chunk_count,
        valid_vector_count,
        skipped_vector_count: control.skipped_vectors,
        error: control.error.clone(),
    }
}

async fn apply_pending_changes<F>(
    service: &RagIndexService,
    pool: &SqlitePool,
    check: F,
) -> Result<(), String>
where
    F: Fn() -> Result<(), String> + Send + Sync + Clone + 'static,
{
    loop {
        check()?;
        let changes = {
            let mut control = service
                .control
                .lock()
                .map_err(|_| "RAG index state poisoned".to_string())?;
            if control.pending_changes.is_empty() {
                control.status = IndexStatus::Ready;
                return Ok(());
            }
            std::mem::take(&mut control.pending_changes)
        };
        for (path, change) in changes {
            match change {
                PendingChange::Refresh => {
                    let (fresh, _) = load_batched_index(pool, Some(&path), check.clone()).await?;
                    check()?;
                    remove_ready_index(service, &path)?;
                    let index = service
                        .control
                        .lock()
                        .map_err(|_| "RAG index state poisoned".to_string())?
                        .index
                        .clone()
                        .ok_or_else(|| "RAG index unavailable".to_string())?;
                    let mut index = index
                        .write()
                        .map_err(|_| "RAG index poisoned".to_string())?;
                    let dimension = index.vector_dimension;
                    index.documents.extend(fresh.documents);
                    index
                        .chunks
                        .extend(fresh.chunks.into_iter().map(|mut chunk| {
                            if chunk
                                .embedding
                                .as_ref()
                                .is_some_and(|vector| Some(vector.len()) != dimension)
                            {
                                chunk.embedding = None;
                            }
                            chunk
                        }));
                }
                PendingChange::Remove => remove_ready_index(service, &path)?,
            }
        }
    }
}

async fn initialize_internal(
    app: &AppHandle,
    service: &RagIndexService,
) -> Result<RagIndexStateResponse, String> {
    let mut waited = false;
    loop {
        let cancellation = {
            let mut control = service
                .control
                .lock()
                .map_err(|_| "RAG index state poisoned".to_string())?;
            match control.status {
                IndexStatus::Ready => return Ok(state_response(&control)),
                IndexStatus::Initializing => None,
                IndexStatus::Idle | IndexStatus::Failed => {
                    if waited {
                        return Err(control
                            .error
                            .clone()
                            .unwrap_or_else(|| "RAG index initialization stopped".into()));
                    }
                    let token = CancellationToken::new();
                    *service
                        .initialization_cancellation
                        .lock()
                        .map_err(|_| "RAG index initialization state poisoned".to_string())? =
                        Some(token.clone());
                    control.status = IndexStatus::Initializing;
                    control.error = None;
                    Some(token)
                }
            }
        };
        let Some(cancellation) = cancellation else {
            waited = true;
            tokio::select! {
                _ = service.notify.notified() => {},
                _ = tokio::time::sleep(std::time::Duration::from_millis(50)) => {},
            }
            continue;
        };

        let result: Result<RagIndexStateResponse, String> = async {
            if cancellation.is_cancelled() {
                return Err("RAG index initialization cancelled".to_string());
            }
            let pool = open_readonly_pool(database_path(app)?).await?;
            admit_initialization(&pool).await?;
            let token = cancellation.clone();
            let (index, skipped) =
                load_batched_index(&pool, None, move || check_initialization_resources(&token))
                    .await?;
            check_initialization_resources(&cancellation)?;
            {
                let mut control = service
                    .control
                    .lock()
                    .map_err(|_| "RAG index state poisoned".to_string())?;
                control.index = Some(Arc::new(RwLock::new(index)));
                control.skipped_vectors = skipped;
            }
            let token = cancellation.clone();
            apply_pending_changes(service, &pool, move || {
                check_initialization_resources(&token)
            })
            .await?;
            let control = service
                .control
                .lock()
                .map_err(|_| "RAG index state poisoned".to_string())?;
            Ok(state_response(&control))
        }
        .await;

        if let Ok(mut control) = service.control.lock() {
            if let Err(error) = &result {
                control.status = if cancellation.is_cancelled() {
                    IndexStatus::Idle
                } else {
                    IndexStatus::Failed
                };
                control.index = None;
                // The next initialization reloads authoritative SQLite data.
                control.pending_changes.clear();
                control.error = (!cancellation.is_cancelled()).then(|| error.clone());
            }
            if let Ok(mut active) = service.initialization_cancellation.lock() {
                *active = None;
            }
        }
        service.notify.notify_waiters();
        return result;
    }
}

#[tauri::command]
pub fn get_rag_index_state(
    state: State<'_, RagIndexService>,
) -> Result<RagIndexStateResponse, String> {
    let control = state
        .control
        .lock()
        .map_err(|_| "RAG index state poisoned".to_string())?;
    Ok(state_response(&control))
}

#[tauri::command]
pub async fn initialize_rag_index(
    app: AppHandle,
    state: State<'_, RagIndexService>,
) -> Result<RagIndexStateResponse, String> {
    initialize_internal(&app, state.inner()).await
}

#[tauri::command]
pub fn cancel_rag_index_initialization(state: State<'_, RagIndexService>) -> Result<bool, String> {
    cancel_active_initialization(state.inner())
}

fn cancel_active_initialization(state: &RagIndexService) -> Result<bool, String> {
    let active = state
        .initialization_cancellation
        .lock()
        .map_err(|_| "RAG index initialization state poisoned".to_string())?;
    let Some(cancellation) = active.as_ref() else {
        return Ok(false);
    };
    cancellation.cancel();
    Ok(true)
}

async fn refresh_ready_index(
    pool: &SqlitePool,
    service: &RagIndexService,
    path: &str,
) -> Result<(), String> {
    let raw = load_raw_document(pool, path).await?;
    let control = service
        .control
        .lock()
        .map_err(|_| "RAG index state poisoned".to_string())?;
    let Some(index) = control.index.clone() else {
        return Ok(());
    };
    drop(control);
    let mut index = index
        .write()
        .map_err(|_| "RAG index poisoned".to_string())?;
    let normalized = normalize_path(path);
    index
        .documents
        .retain(|_, doc| normalize_path(&doc.file_path) != normalized);
    let document_ids: HashSet<String> = index.documents.keys().cloned().collect();
    index
        .chunks
        .retain(|chunk| document_ids.contains(&chunk.document_id));
    if let Some((document, chunks)) = raw {
        let (fresh, _) = build_index(vec![document], chunks);
        index.documents.extend(fresh.documents);
        let vector_dimension = index.vector_dimension;
        index
            .chunks
            .extend(fresh.chunks.into_iter().map(|mut chunk| {
                if chunk
                    .embedding
                    .as_ref()
                    .is_some_and(|vector| Some(vector.len()) != vector_dimension)
                {
                    chunk.embedding = None;
                }
                chunk
            }));
    }
    Ok(())
}

fn remove_ready_index(service: &RagIndexService, path: &str) -> Result<(), String> {
    let control = service
        .control
        .lock()
        .map_err(|_| "RAG index state poisoned".to_string())?;
    let Some(index) = control.index.clone() else {
        return Ok(());
    };
    drop(control);
    let normalized = normalize_path(path);
    let mut index = index
        .write()
        .map_err(|_| "RAG index poisoned".to_string())?;
    let removed_ids: HashSet<String> = index
        .documents
        .values()
        .filter(|doc| normalize_path(&doc.file_path) == normalized)
        .map(|doc| doc.id.clone())
        .collect();
    index.documents.retain(|id, _| !removed_ids.contains(id));
    index
        .chunks
        .retain(|chunk| !removed_ids.contains(&chunk.document_id));
    Ok(())
}

#[tauri::command]
pub async fn refresh_rag_index_document(
    app: AppHandle,
    path: String,
    state: State<'_, RagIndexService>,
) -> Result<(), String> {
    {
        let mut control = state
            .control
            .lock()
            .map_err(|_| "RAG index state poisoned".to_string())?;
        if control.status != IndexStatus::Ready {
            if control.status == IndexStatus::Initializing {
                control
                    .pending_changes
                    .insert(normalize_path(&path), PendingChange::Refresh);
            }
            return Ok(());
        }
    }
    let pool = open_readonly_pool(database_path(&app)?).await?;
    refresh_ready_index(&pool, state.inner(), &path).await
}

#[tauri::command]
pub fn remove_rag_index_document(
    path: String,
    state: State<'_, RagIndexService>,
) -> Result<(), String> {
    {
        let mut control = state
            .control
            .lock()
            .map_err(|_| "RAG index state poisoned".to_string())?;
        if control.status != IndexStatus::Ready {
            if control.status == IndexStatus::Initializing {
                control
                    .pending_changes
                    .insert(normalize_path(&path), PendingChange::Remove);
            }
            return Ok(());
        }
    }
    remove_ready_index(state.inner(), &path)
}

fn cosine_similarity(left: &[f32], right: &[f32]) -> f32 {
    if left.len() != right.len() || left.is_empty() {
        return 0.0;
    }
    let (mut dot, mut left_norm, mut right_norm) = (0.0, 0.0, 0.0);
    for (a, b) in left.iter().zip(right) {
        dot += a * b;
        left_norm += a * a;
        right_norm += b * b;
    }
    let denominator = left_norm.sqrt() * right_norm.sqrt();
    if denominator == 0.0 {
        0.0
    } else {
        dot / denominator
    }
}

fn tokenize(text: &str) -> Vec<String> {
    let normalized = text.to_lowercase();
    let mut terms = HashSet::new();
    let mut token = String::new();
    let mut token_is_cjk = false;
    let flush = |token: &mut String, is_cjk: bool, terms: &mut HashSet<String>| {
        let chars: Vec<char> = token.chars().collect();
        if chars.len() >= 2 {
            terms.insert(token.clone());
            if is_cjk && chars.len() > 3 {
                for pair in chars.windows(2) {
                    terms.insert(pair.iter().collect());
                }
            }
        }
        token.clear();
    };
    for ch in normalized.chars().chain(std::iter::once(' ')) {
        let is_cjk = ('\u{4e00}'..='\u{9fff}').contains(&ch);
        let is_ascii_term = ch.is_ascii_alphanumeric() || "_+#./-".contains(ch);
        if !is_cjk && !is_ascii_term {
            flush(&mut token, token_is_cjk, &mut terms);
        } else if token.is_empty() || token_is_cjk == is_cjk {
            token.push(ch);
            token_is_cjk = is_cjk;
        } else {
            flush(&mut token, token_is_cjk, &mut terms);
            token.push(ch);
            token_is_cjk = is_cjk;
        }
    }
    terms.into_iter().collect()
}

fn fts_query(text: &str) -> Option<String> {
    let mut terms = tokenize(text);
    if terms.iter().any(|term| {
        term.chars().count() == 2
            && (!term
                .chars()
                .all(|ch| ('\u{4e00}'..='\u{9fff}').contains(&ch))
                || !terms
                    .iter()
                    .any(|longer| longer.chars().count() > 3 && longer.contains(term)))
    }) {
        return None;
    }
    let long_chinese: Vec<_> = terms
        .iter()
        .filter(|term| {
            term.chars().count() > 3
                && term
                    .chars()
                    .all(|ch| ('\u{4e00}'..='\u{9fff}').contains(&ch))
        })
        .cloned()
        .collect();
    for term in long_chinese {
        let chars: Vec<_> = term.chars().collect();
        terms.extend(chars.windows(3).map(|part| part.iter().collect::<String>()));
    }
    terms.retain(|term| term.chars().count() >= 3);
    terms.sort_by(|left, right| {
        right
            .chars()
            .count()
            .cmp(&left.chars().count())
            .then(left.cmp(right))
    });
    terms.dedup();
    (!terms.is_empty()).then(|| {
        terms
            .into_iter()
            .take(16)
            .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(" OR ")
    })
}

fn scoped_document_ids(index: &RagIndex, request: &RagSearchRequest) -> Option<Vec<String>> {
    if request.file_paths.is_empty() {
        return None;
    }
    let scope: HashSet<_> = request
        .file_paths
        .iter()
        .map(|path| normalize_path(path))
        .collect();
    Some(
        index
            .documents
            .values()
            .filter(|doc| scope.contains(&normalize_path(&doc.file_path)))
            .map(|doc| doc.id.clone())
            .collect(),
    )
}

async fn fts_keyword_scores(
    pool: &SqlitePool,
    document_ids: Option<Vec<String>>,
    request: &RagSearchRequest,
) -> Option<HashMap<String, f32>> {
    if !request.keyword_search_enabled {
        return None;
    }
    let query = fts_query(&request.query_text)?;
    if document_ids.as_ref().is_some_and(Vec::is_empty) {
        return Some(HashMap::new());
    }
    let mut sql = QueryBuilder::<Sqlite>::new(
        "SELECT c.id, bm25(chunks_fts, 1.0, 2.0, 1.5) AS rank \
         FROM chunks_fts JOIN chunks c ON c.rowid = chunks_fts.rowid \
         WHERE chunks_fts MATCH ",
    );
    sql.push_bind(query);
    if let Some(document_ids) = document_ids {
        sql.push(" AND c.document_id IN (");
        let mut separated = sql.separated(", ");
        for id in document_ids {
            separated.push_bind(id);
        }
        separated.push_unseparated(")");
    }
    // Keep all matching IDs until content deduplication and document diversification.
    // A global LIMIT here lets one long document crowd out every other document.
    sql.push(" ORDER BY rank");
    let rows = sql.build().fetch_all(pool).await.ok()?;
    let best = rows
        .first()
        .map(|row| -row.get::<f64, _>("rank"))
        .unwrap_or(0.0);
    Some(
        rows.into_iter()
            .map(|row| {
                let rank = -row.get::<f64, _>("rank");
                let score = if best > 0.0 {
                    0.2 + 0.6 * (rank / best).clamp(0.0, 1.0)
                } else {
                    0.5
                };
                (row.get("id"), score as f32)
            })
            .collect(),
    )
}

fn keyword_score(query: &str, terms: &[String], chunk: &ChunkRecord, doc: &DocumentRecord) -> f32 {
    if terms.is_empty() {
        return 0.0;
    }
    let content = chunk.content.to_lowercase();
    let heading = chunk.heading.as_deref().unwrap_or_default().to_lowercase();
    let title_path = chunk.title_path.join(" > ").to_lowercase();
    let file_name = doc
        .file_path
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(&doc.title)
        .to_lowercase();
    let title = doc.title.to_lowercase();
    let mut score = 0.0;
    for term in terms {
        if content.contains(term) {
            score += 1.0;
        }
        if heading.contains(term) {
            score += 1.8;
        }
        if title_path.contains(term) {
            score += 1.5;
        }
        if file_name.contains(term) {
            score += 1.4;
        }
        if title.contains(term) {
            score += 1.2;
        }
    }
    let normalized = query.trim().to_lowercase();
    if normalized.chars().count() >= 3 {
        if content.contains(&normalized) {
            score += 1.2;
        }
        if title_path.contains(&normalized) || file_name.contains(&normalized) {
            score += 1.6;
        }
    }
    (score / terms.len() as f32).min(1.0)
}

fn apply_boost(mut hit: RankedHit, doc: &DocumentRecord, request: &RagSearchRequest) -> RankedHit {
    if request.prefer_current_file
        && request
            .current_file_path
            .as_ref()
            .is_some_and(|path| normalize_path(path) == normalize_path(&doc.file_path))
    {
        hit.score += 0.08;
    }
    if request.prefer_recent_documents {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        let age = (now - doc.last_modified).max(0) as f32;
        let week = (7 * 24 * 60 * 60 * 1000) as f32;
        if age < week {
            hit.score += 0.04 * (1.0 - age / week);
        }
    }
    hit.score = hit.score.min(1.0);
    hit
}

fn sort_and_diversify(index: &RagIndex, hits: Vec<RankedHit>, top_k: usize) -> Vec<RankedHit> {
    let mut best = HashMap::<String, RankedHit>::new();
    for hit in hits {
        let chunk = &index.chunks[hit.chunk_index];
        let key = chunk
            .content_hash
            .clone()
            .unwrap_or_else(|| chunk.content.to_lowercase());
        if best
            .get(&key)
            .is_none_or(|current| hit.score > current.score)
        {
            best.insert(key, hit);
        }
    }
    let mut sorted: Vec<_> = best.into_values().collect();
    sorted.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(Ordering::Equal));
    let mut groups = Vec::<Vec<RankedHit>>::new();
    let mut group_indexes = HashMap::<String, usize>::new();
    for hit in sorted {
        let path =
            normalize_path(&index.documents[&index.chunks[hit.chunk_index].document_id].file_path);
        let group_index = *group_indexes.entry(path).or_insert_with(|| {
            groups.push(Vec::new());
            groups.len() - 1
        });
        groups[group_index].push(hit);
    }
    let mut output = Vec::new();
    while output.len() < top_k {
        let mut added = false;
        for group in &mut groups {
            if !group.is_empty() {
                output.push(group.remove(0));
                added = true;
            }
            if output.len() >= top_k {
                break;
            }
        }
        if !added {
            break;
        }
    }
    output
}

#[cfg(test)]
fn search_index(index: &RagIndex, request: &RagSearchRequest) -> Vec<RagSearchHit> {
    search_index_with_fts(index, request, None)
}

fn search_index_with_fts(
    index: &RagIndex,
    request: &RagSearchRequest,
    fts_scores: Option<&HashMap<String, f32>>,
) -> Vec<RagSearchHit> {
    let scope: Option<HashSet<String>> = (!request.file_paths.is_empty()).then(|| {
        request
            .file_paths
            .iter()
            .map(|path| normalize_path(path))
            .collect()
    });
    let in_scope = |doc: &DocumentRecord| {
        scope
            .as_ref()
            .is_none_or(|paths| paths.contains(&normalize_path(&doc.file_path)))
    };
    let candidate_limit = request.top_k.saturating_mul(3).max(request.top_k);
    let mut vector_hits = Vec::new();
    if let Some(query) = request
        .query_vector
        .as_ref()
        .filter(|query| Some(query.len()) == index.vector_dimension)
    {
        for (chunk_index, chunk) in index.chunks.iter().enumerate() {
            let Some(vector) = &chunk.embedding else {
                continue;
            };
            let Some(doc) = index.documents.get(&chunk.document_id) else {
                continue;
            };
            if !in_scope(doc) {
                continue;
            }
            let score = cosine_similarity(query, vector);
            if score >= request.threshold {
                vector_hits.push(RankedHit {
                    chunk_index,
                    score,
                    vector_score: Some(score),
                    keyword_score: None,
                    retrieval_mode: "vector",
                });
            }
        }
    }
    let vector_hits = sort_and_diversify(index, vector_hits, candidate_limit);
    let mut keyword_hits = Vec::new();
    if request.keyword_search_enabled {
        let terms = tokenize(&request.query_text);
        for (chunk_index, chunk) in index.chunks.iter().enumerate() {
            let Some(doc) = index.documents.get(&chunk.document_id) else {
                continue;
            };
            if !in_scope(doc) {
                continue;
            }
            let score = if let Some(fts_scores) = fts_scores {
                let fts_score = fts_scores.get(&chunk.id).copied().unwrap_or(0.0);
                let name = doc
                    .file_path
                    .rsplit(['/', '\\'])
                    .next()
                    .unwrap_or(&doc.title)
                    .to_lowercase();
                let title = doc.title.to_lowercase();
                let name_match = terms
                    .iter()
                    .any(|term| name.contains(term) || title.contains(term));
                if name_match {
                    fts_score.max(keyword_score(&request.query_text, &terms, chunk, doc))
                } else if fts_score > 0.0 {
                    fts_score
                } else if terms.iter().any(|term| {
                    term.chars().count() == 2
                        && term
                            .chars()
                            .all(|ch| ('\u{4e00}'..='\u{9fff}').contains(&ch))
                        && (chunk.content.contains(term)
                            || chunk
                                .heading
                                .as_deref()
                                .is_some_and(|heading| heading.contains(term))
                            || chunk.title_path.iter().any(|part| part.contains(term)))
                }) {
                    keyword_score(&request.query_text, &terms, chunk, doc).min(0.4)
                } else {
                    0.0
                }
            } else {
                keyword_score(&request.query_text, &terms, chunk, doc)
            };
            if score > 0.0 {
                keyword_hits.push(RankedHit {
                    chunk_index,
                    score,
                    vector_score: None,
                    keyword_score: Some(score),
                    retrieval_mode: "keyword",
                });
            }
        }
    }
    let keyword_hits = sort_and_diversify(index, keyword_hits, candidate_limit);
    let mut merged = HashMap::<String, RankedHit>::new();
    for hit in vector_hits.into_iter().chain(keyword_hits) {
        let chunk = &index.chunks[hit.chunk_index];
        if let Some(existing) = merged.get(&chunk.id).cloned() {
            let vector_score = existing
                .vector_score
                .unwrap_or(0.0)
                .max(hit.vector_score.unwrap_or(0.0));
            let keyword_score = existing
                .keyword_score
                .unwrap_or(0.0)
                .max(hit.keyword_score.unwrap_or(0.0));
            let both = vector_score > 0.0 && keyword_score > 0.0;
            let score = if both {
                (vector_score * 0.72 + keyword_score * 0.28 + 0.04).min(1.0)
            } else {
                vector_score.max(keyword_score)
            };
            merged.insert(
                chunk.id.clone(),
                RankedHit {
                    chunk_index: existing.chunk_index,
                    score,
                    vector_score: Some(vector_score),
                    keyword_score: Some(keyword_score),
                    retrieval_mode: if both {
                        "hybrid"
                    } else {
                        existing.retrieval_mode
                    },
                },
            );
        } else {
            merged.insert(chunk.id.clone(), hit);
        }
    }
    let boosted_hits = merged
        .into_values()
        .map(|hit| {
            let chunk = &index.chunks[hit.chunk_index];
            let doc = &index.documents[&chunk.document_id];
            apply_boost(hit, doc, request)
        })
        .collect();
    sort_and_diversify(index, boosted_hits, request.top_k)
        .into_iter()
        .map(|hit| {
            let chunk = &index.chunks[hit.chunk_index];
            let doc = &index.documents[&chunk.document_id];
            let neighbor_chunks = index
                .chunks
                .iter()
                .filter(|candidate| {
                    candidate.document_id == chunk.document_id
                        && candidate.title_path == chunk.title_path
                        && candidate.id != chunk.id
                        && (candidate.index - chunk.index).abs() == 1
                })
                .map(|candidate| RagSearchChunk {
                    id: candidate.id.clone(),
                    document_id: candidate.document_id.clone(),
                    content: candidate.content.clone(),
                    content_hash: candidate.content_hash.clone(),
                    index: candidate.index,
                    start_line: candidate.start_line,
                    end_line: candidate.end_line,
                    title_path: candidate.title_path.clone(),
                    heading: candidate.heading.clone(),
                    source_type: candidate.source_type.clone(),
                    context_role: Some("neighbor-context"),
                })
                .collect();
            RagSearchHit {
                chunk: RagSearchChunk {
                    id: chunk.id.clone(),
                    document_id: chunk.document_id.clone(),
                    content: chunk.content.clone(),
                    content_hash: chunk.content_hash.clone(),
                    index: chunk.index,
                    start_line: chunk.start_line,
                    end_line: chunk.end_line,
                    title_path: chunk.title_path.clone(),
                    heading: chunk.heading.clone(),
                    source_type: chunk.source_type.clone(),
                    context_role: None,
                },
                document: RagSearchDocument {
                    id: doc.id.clone(),
                    file_path: doc.file_path.clone(),
                    title: doc.title.clone(),
                    last_modified: doc.last_modified,
                },
                score: hit.score,
                retrieval_mode: hit.retrieval_mode,
                keyword_score: hit.keyword_score,
                vector_score: hit.vector_score,
                neighbor_chunks,
            }
        })
        .collect()
}

// Only this bounded candidate set survives between SQLite rows. Diversification
// happens before truncation so one long document cannot crowd out another.
fn retain_keyword_candidates(hits: &mut Vec<RagSearchHit>, limit: usize) {
    hits.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(Ordering::Equal));
    let mut seen = HashSet::new();
    hits.retain(|hit| {
        seen.insert(
            hit.chunk
                .content_hash
                .clone()
                .unwrap_or_else(|| hit.chunk.content.to_lowercase()),
        )
    });
    let mut groups = Vec::<Vec<RagSearchHit>>::new();
    let mut paths = HashMap::new();
    for hit in std::mem::take(hits) {
        let group = *paths
            .entry(normalize_path(&hit.document.file_path))
            .or_insert_with(|| {
                groups.push(Vec::new());
                groups.len() - 1
            });
        groups[group].push(hit);
    }
    while hits.len() < limit {
        let mut added = false;
        for group in &mut groups {
            if !group.is_empty() {
                hits.push(group.remove(0));
                added = true;
            }
            if hits.len() == limit {
                break;
            }
        }
        if !added {
            break;
        }
    }
}

const KEYWORD_ROW_COLUMNS: &str = "c.id, c.document_id, c.content, c.content_hash, c.chunk_index, \
    c.start_line, c.end_line, c.title_path, c.heading, c.source_type, \
    d.file_path, d.title, d.last_modified";

fn keyword_row_index(row: &sqlx::sqlite::SqliteRow) -> RagIndex {
    build_index(
        vec![RawDocument {
            id: row.get("document_id"),
            file_path: row.get("file_path"),
            title: row.get("title"),
            last_modified: row.get("last_modified"),
        }],
        vec![raw_chunk_row(row, false)],
    )
    .0
}

fn raw_chunk_row(row: &sqlx::sqlite::SqliteRow, embedding: bool) -> RawChunk {
    RawChunk {
        id: row.get("id"),
        document_id: row.get("document_id"),
        content: row.get("content"),
        content_hash: row.get("content_hash"),
        index: row.get("chunk_index"),
        start_line: row.get("start_line"),
        end_line: row.get("end_line"),
        title_path: row.get("title_path"),
        heading: row.get("heading"),
        source_type: row.get("source_type"),
        embedding: if embedding {
            row.get("embedding")
        } else {
            None
        },
    }
}

async fn bounded_keyword_search(
    pool: &SqlitePool,
    request: &RagSearchRequest,
) -> Result<Vec<RagSearchHit>, String> {
    if !request.keyword_search_enabled || request.top_k == 0 {
        return Ok(Vec::new());
    }
    let mut request = request.clone();
    request.query_vector = None;
    let limit = request.top_k.saturating_mul(3);
    let mut hits = Vec::new();
    let mut fts_available = false;
    if let Some(query) = fts_query(&request.query_text) {
        let sql = format!(
            "SELECT {KEYWORD_ROW_COLUMNS}, bm25(chunks_fts, 1.0, 2.0, 1.5) AS rank \
            FROM chunks_fts JOIN chunks c ON c.rowid = chunks_fts.rowid \
            JOIN documents d ON d.id = c.document_id WHERE chunks_fts MATCH ? ORDER BY rank"
        );
        let bound_query = sqlx::query(&sql).bind(query);
        let mut rows = bound_query.fetch(pool);
        let mut best = None;
        loop {
            match rows.try_next().await {
                Ok(Some(row)) => {
                    let index = keyword_row_index(&row);
                    if scoped_document_ids(&index, &request).is_some_and(|ids| ids.is_empty()) {
                        continue;
                    }
                    let rank = -row.get::<f64, _>("rank");
                    let best = *best.get_or_insert(rank);
                    let score = if best > 0.0 {
                        0.2 + 0.6 * (rank / best).clamp(0.0, 1.0)
                    } else {
                        0.5
                    };
                    let scores = HashMap::from([(row.get::<String, _>("id"), score as f32)]);
                    hits.extend(search_index_with_fts(&index, &request, Some(&scores)));
                    retain_keyword_candidates(&mut hits, limit);
                }
                Ok(None) => {
                    fts_available = true;
                    break;
                }
                Err(_) => {
                    hits.clear();
                    break;
                } // Preserve the legacy scan on FTS failure.
            }
        }
    }
    let terms = tokenize(&request.query_text);
    let short_chinese = terms.iter().any(|term| {
        term.chars().count() == 2
            && term
                .chars()
                .all(|ch| ('\u{4e00}'..='\u{9fff}').contains(&ch))
    });
    // Scan a row at a time on short queries/FTS failure. With FTS available,
    // only title/name matches and the legacy two-character alternative are scored.
    let mut sql = QueryBuilder::<Sqlite>::new(format!(
        "SELECT {KEYWORD_ROW_COLUMNS} FROM chunks c JOIN documents d ON d.id = c.document_id"
    ));
    if fts_available && !short_chinese && !terms.is_empty() {
        sql.push(" WHERE (");
        for (i, term) in terms.iter().enumerate() {
            if i > 0 {
                sql.push(" OR ");
            }
            sql.push("instr(lower(d.title), ")
                .push_bind(term)
                .push(") > 0 OR instr(lower(d.file_path), ")
                .push_bind(term)
                .push(") > 0");
        }
        sql.push(")");
    }
    sql.push(" ORDER BY c.rowid");
    let bound_query = sql.build();
    let mut rows = bound_query.fetch(pool);
    let empty_scores = HashMap::new();
    while let Some(row) = rows.try_next().await.map_err(|error| error.to_string())? {
        if fts_available && !short_chinese {
            let title = row.get::<String, _>("title").to_lowercase();
            let path = row.get::<String, _>("file_path");
            let name = path
                .rsplit(['/', '\\'])
                .next()
                .unwrap_or_default()
                .to_lowercase();
            if !terms
                .iter()
                .any(|term| title.contains(term) || name.contains(term))
            {
                continue;
            }
        }
        let index = keyword_row_index(&row);
        hits.extend(search_index_with_fts(
            &index,
            &request,
            fts_available.then_some(&empty_scores),
        ));
        retain_keyword_candidates(&mut hits, limit);
    }
    drop(rows);
    retain_keyword_candidates(&mut hits, request.top_k);
    for hit in &mut hits {
        let sql = format!(
            "SELECT {KEYWORD_ROW_COLUMNS} FROM chunks c JOIN documents d ON d.id = c.document_id \
            WHERE c.document_id = ? AND c.chunk_index IN (?, ?) AND c.id != ?"
        );
        let neighbors = sqlx::query(&sql)
            .bind(&hit.chunk.document_id)
            .bind(hit.chunk.index - 1)
            .bind(hit.chunk.index + 1)
            .bind(&hit.chunk.id)
            .fetch_all(pool)
            .await
            .map_err(|error| error.to_string())?;
        hit.neighbor_chunks = neighbors
            .iter()
            .map(keyword_row_index)
            .flat_map(|index| index.chunks)
            .filter(|chunk| chunk.title_path == hit.chunk.title_path)
            .map(|chunk| RagSearchChunk {
                id: chunk.id,
                document_id: chunk.document_id,
                content: chunk.content,
                content_hash: chunk.content_hash,
                index: chunk.index,
                start_line: chunk.start_line,
                end_line: chunk.end_line,
                title_path: chunk.title_path,
                heading: chunk.heading,
                source_type: chunk.source_type,
                context_role: Some("neighbor-context"),
            })
            .collect();
    }
    Ok(hits)
}

#[tauri::command]
pub async fn search_rag_index(
    app: AppHandle,
    request: RagSearchRequest,
    state: State<'_, RagIndexService>,
) -> Result<Vec<RagSearchHit>, String> {
    if request.keyword_only_fallback
        || crate::perf_monitor::get_system_memory_snapshot()
            .map(|snapshot| !memory_allows_index(&snapshot, 0))
            .unwrap_or(true)
    {
        let pool = open_readonly_pool(database_path(&app)?).await?;
        return bounded_keyword_search(&pool, &request).await;
    }
    if initialize_internal(&app, state.inner()).await.is_err() {
        // Initialization failure must not block an answer. Retry a lightweight
        // keyword-only load; the failed state is retained so a later call can retry.
        let pool = open_readonly_pool(database_path(&app)?).await?;
        return bounded_keyword_search(&pool, &request).await;
    }
    let index = {
        let control = state
            .control
            .lock()
            .map_err(|_| "RAG index state poisoned".to_string())?;
        control
            .index
            .clone()
            .ok_or_else(|| "RAG index unavailable".to_string())?
    };
    let fts_scores = if request.keyword_search_enabled && fts_query(&request.query_text).is_some() {
        let document_ids = {
            let guard = index.read().map_err(|_| "RAG index poisoned".to_string())?;
            scoped_document_ids(&guard, &request)
        };
        let pool = match database_path(&app) {
            Ok(path) => open_readonly_pool(path).await.ok(),
            Err(_) => None,
        };
        if let Some(pool) = pool {
            fts_keyword_scores(&pool, document_ids, &request).await
        } else {
            None
        }
    } else {
        None
    };
    tauri::async_runtime::spawn_blocking(move || {
        let index = index.read().map_err(|_| "RAG index poisoned".to_string())?;
        Ok(search_index_with_fts(&index, &request, fts_scores.as_ref()))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::Executor;
    use std::time::Instant;

    #[test]
    fn index_admission_requires_physical_and_commit_reserve_plus_budget() {
        let mut snapshot = crate::perf_monitor::SystemMemorySnapshot {
            available_physical_mb: 1024,
            total_physical_mb: 8192,
            available_commit_mb: 640,
            commit_limit_mb: 16384,
        };
        assert!(memory_allows_index(&snapshot, 128));
        assert!(!memory_allows_index(&snapshot, 129));
        snapshot.available_commit_mb = 1024;
        snapshot.available_physical_mb = 256;
        assert!(!memory_allows_index(&snapshot, 128));
    }

    #[tokio::test]
    async fn bounded_fallback_keeps_scope_short_terms_fts_failure_and_neighbors() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        pool.execute("CREATE TABLE documents (id TEXT PRIMARY KEY, file_path TEXT, title TEXT, last_modified INTEGER)").await.unwrap();
        pool.execute("CREATE TABLE chunks (id TEXT PRIMARY KEY, document_id TEXT, content TEXT, content_hash TEXT, chunk_index INTEGER, start_line INTEGER, end_line INTEGER, title_path TEXT, heading TEXT, source_type TEXT)").await.unwrap();
        pool.execute("INSERT INTO documents VALUES ('a', 'C:/anonymous-a.md', 'anonymous', 0), ('b', 'C:/anonymous-b.md', 'anonymous', 0)").await.unwrap();
        for i in 0..401 {
            sqlx::query(
                "INSERT INTO chunks VALUES (?, ?, ?, ?, ?, 1, 2, '[\"section\"]', '', 'markdown')",
            )
            .bind(format!("c{i}"))
            .bind(if i < 400 { "a" } else { "b" })
            .bind(format!("target 检索 paragraph {i}"))
            .bind(format!("hash{i}"))
            .bind(i)
            .execute(&pool)
            .await
            .unwrap();
        }
        let mut request = RagSearchRequest {
            query_text: "target".into(),
            query_vector: Some(vec![1.0]),
            top_k: 2,
            threshold: 0.9,
            file_paths: vec![],
            keyword_search_enabled: true,
            current_file_path: None,
            prefer_current_file: false,
            prefer_recent_documents: false,
            keyword_only_fallback: true,
        };
        // No embeddings table: the fallback must never read vectors, even on FTS failure.
        let hits = bounded_keyword_search(&pool, &request).await.unwrap();
        assert_eq!(hits.len(), 2);
        assert!(hits.iter().any(|hit| hit.document.id == "b"));
        assert!(hits.iter().any(|hit| !hit.neighbor_chunks.is_empty()));
        pool.execute("CREATE VIRTUAL TABLE chunks_fts USING fts5(content, heading, title_path, content='chunks', content_rowid='rowid', tokenize='trigram')").await.unwrap();
        pool.execute("INSERT INTO chunks_fts(chunks_fts) VALUES ('rebuild')")
            .await
            .unwrap();
        let hits = bounded_keyword_search(&pool, &request).await.unwrap();
        assert_eq!(hits.len(), 2);
        assert!(hits.iter().any(|hit| hit.document.id == "b"));
        request.top_k = 150;
        assert_eq!(
            bounded_keyword_search(&pool, &request).await.unwrap().len(),
            150
        );
        request.top_k = 2;
        request.file_paths = vec!["c:\\ANONYMOUS-B.md".into()];
        for query in ["target", "检索"] {
            request.query_text = query.into();
            let hits = bounded_keyword_search(&pool, &request).await.unwrap();
            assert_eq!(hits.len(), 1);
            assert_eq!(hits[0].document.id, "b");
            assert_eq!(hits[0].retrieval_mode, "keyword");
        }

        pool.execute("CREATE TABLE embeddings (chunk_id TEXT PRIMARY KEY, embedding TEXT)")
            .await
            .unwrap();
        pool.execute("INSERT INTO embeddings SELECT id, CASE WHEN chunk_index < 64 THEN '[1,0]' ELSE '[1,0,0]' END FROM chunks").await.unwrap();
        let checks = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let worker_checks = checks.clone();
        let stopped = load_batched_index(&pool, None, move || {
            if worker_checks.fetch_add(1, std::sync::atomic::Ordering::SeqCst) > 80 {
                Err("injected memory pressure".into())
            } else {
                Ok(())
            }
        })
        .await;
        assert!(matches!(stopped, Err(error) if error == "injected memory pressure"));
        // All closure/worker references have been released when the await returns.
        assert_eq!(Arc::strong_count(&checks), 1);

        let token = CancellationToken::new();
        let worker_token = token.clone();
        let worker_checks = checks.clone();
        checks.store(0, std::sync::atomic::Ordering::SeqCst);
        let stopped = load_batched_index(&pool, None, move || {
            if worker_checks.fetch_add(1, std::sync::atomic::Ordering::SeqCst) > 80 {
                worker_token.cancel();
            }
            if worker_token.is_cancelled() {
                Err("cancelled".into())
            } else {
                Ok(())
            }
        })
        .await;
        assert!(matches!(stopped, Err(error) if error == "cancelled"));
        assert_eq!(Arc::strong_count(&checks), 1);
        // Recovery reloads from SQLite, selecting the global majority across batches.
        let (index, skipped) = load_batched_index(&pool, None, || Ok(())).await.unwrap();
        assert_eq!(index.chunks.len(), 401);
        assert_eq!(index.vector_dimension, Some(3));
        assert_eq!(skipped, 64);
        let (single, _) = load_batched_index(&pool, Some("c:\\ANONYMOUS-B.md"), || Ok(()))
            .await
            .unwrap();
        assert_eq!(single.documents.len(), 1);
        assert_eq!(single.chunks.len(), 1);
        let service = RagIndexService::default();
        {
            let mut control = service.control.lock().unwrap();
            control.status = IndexStatus::Initializing;
            control.index = Some(Arc::new(RwLock::new(index)));
            control
                .pending_changes
                .insert("C:/anonymous-a.md".into(), PendingChange::Remove);
            control
                .pending_changes
                .insert("C:/anonymous-b.md".into(), PendingChange::Refresh);
        }
        pool.execute(
            "UPDATE chunks SET content = 'updated anonymous content' WHERE document_id = 'b'",
        )
        .await
        .unwrap();
        apply_pending_changes(&service, &pool, || Ok(()))
            .await
            .unwrap();
        let control = service.control.lock().unwrap();
        assert_eq!(control.status, IndexStatus::Ready);
        assert!(control.pending_changes.is_empty());
        let index = control.index.as_ref().unwrap().read().unwrap();
        assert_eq!(index.chunks.len(), 1);
        assert_eq!(index.chunks[0].content, "updated anonymous content");
    }

    #[tokio::test]
    async fn fts_candidates_preserve_cross_document_recall_and_short_english_terms() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        pool.execute("CREATE TABLE chunks (id TEXT PRIMARY KEY, document_id TEXT, content TEXT, heading TEXT, title_path TEXT)")
            .await.unwrap();
        pool.execute("CREATE VIRTUAL TABLE chunks_fts USING fts5(content, heading, title_path, content='chunks', content_rowid='rowid', tokenize='trigram')")
            .await.unwrap();
        let documents = vec!["d1", "d2"]
            .into_iter()
            .map(|id| RawDocument {
                id: id.into(),
                file_path: format!("C:/anonymous-{id}.md"),
                title: "anonymous".into(),
                last_modified: 0,
            })
            .collect();
        let mut chunks = Vec::new();
        for i in 0..101 {
            let id = format!("c{i}");
            let document_id = if i < 100 { "d1" } else { "d2" };
            let content = if i < 100 {
                format!("target target target golang paragraph {i}")
            } else {
                format!(
                    "{}go routines",
                    "target plus other unrelated material ".repeat(20)
                )
            };
            let heading = if i < 100 { "target" } else { "" };
            sqlx::query("INSERT INTO chunks VALUES (?, ?, ?, ?, '')")
                .bind(&id)
                .bind(document_id)
                .bind(&content)
                .bind(heading)
                .execute(&pool)
                .await
                .unwrap();
            chunks.push(RawChunk {
                id: id.clone(),
                document_id: document_id.into(),
                content,
                content_hash: Some(id),
                index: i,
                start_line: 1,
                end_line: 1,
                title_path: None,
                heading: Some(heading.into()),
                source_type: "markdown".into(),
                embedding: None,
            });
        }
        pool.execute("INSERT INTO chunks_fts(chunks_fts) VALUES ('rebuild')")
            .await
            .unwrap();
        let index = build_index(documents, chunks).0;
        let mut request = RagSearchRequest {
            query_text: "target".into(),
            query_vector: None,
            top_k: 2,
            threshold: 0.0,
            file_paths: vec![],
            keyword_search_enabled: true,
            current_file_path: None,
            prefer_current_file: false,
            prefer_recent_documents: false,
            keyword_only_fallback: false,
        };
        let scores = fts_keyword_scores(&pool, None, &request).await.unwrap();
        let hits = search_index_with_fts(&index, &request, Some(&scores));
        assert_eq!(hits.len(), 2);
        assert!(hits.iter().any(|hit| hit.chunk.document_id == "d2"));

        // A two-character English term remains an independent OR alternative.
        request.query_text = "go golang".into();
        let short_scores = fts_keyword_scores(&pool, None, &request).await;
        assert!(short_scores.is_none());
        let short_hits = search_index_with_fts(&index, &request, short_scores.as_ref());
        assert!(short_hits.iter().any(|hit| hit.chunk.document_id == "d2"));
        assert!(fts_query("go").is_none());
        assert!(fts_query("golang").is_some());
        assert!(fts_query("关键词检索").is_some());
    }

    #[tokio::test]
    async fn fts_keyword_query_ranks_and_scopes_chinese_chunks() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        pool.execute("CREATE TABLE chunks (id TEXT PRIMARY KEY, document_id TEXT, content TEXT, heading TEXT, title_path TEXT)")
            .await.unwrap();
        pool.execute("CREATE VIRTUAL TABLE chunks_fts USING fts5(content, heading, title_path, content='chunks', content_rowid='rowid', tokenize='trigram')")
            .await.unwrap();
        pool.execute("INSERT INTO chunks VALUES ('a', 'd1', '关键词检索', '关键词检索', '')")
            .await
            .unwrap();
        pool.execute("INSERT INTO chunks VALUES ('b', 'd2', '关键词检索', '', '')")
            .await
            .unwrap();
        pool.execute("INSERT INTO chunks_fts(chunks_fts) VALUES ('rebuild')")
            .await
            .unwrap();
        let request = RagSearchRequest {
            query_text: "关键词检索".into(),
            query_vector: None,
            top_k: 2,
            threshold: 0.0,
            file_paths: vec![],
            keyword_search_enabled: true,
            current_file_path: None,
            prefer_current_file: false,
            prefer_recent_documents: false,
            keyword_only_fallback: false,
        };
        let scores = fts_keyword_scores(&pool, None, &request).await.unwrap();
        assert!(scores["a"] > scores["b"]);
        let scoped = fts_keyword_scores(&pool, Some(vec!["d2".into()]), &request)
            .await
            .unwrap();
        assert_eq!(scoped.len(), 1);
        assert!(scoped.contains_key("b"));
        assert!(fts_query("检索").is_none());
        assert!(fts_query("AI 关键词检索").is_none());
    }

    #[test]
    fn fts_results_keep_legacy_two_character_chinese_recall() {
        let documents = vec![RawDocument {
            id: "d".into(),
            file_path: "C:/anonymous.md".into(),
            title: "anonymous".into(),
            last_modified: 0,
        }];
        let chunk = |id: &str, content: &str| RawChunk {
            id: id.into(),
            document_id: "d".into(),
            content: content.into(),
            content_hash: Some(id.into()),
            index: if id == "a" { 0 } else { 1 },
            start_line: 1,
            end_line: 1,
            title_path: None,
            heading: None,
            source_type: "markdown".into(),
            embedding: None,
        };
        let index = build_index(
            documents,
            vec![chunk("a", "关键词检索"), chunk("b", "词检方案")],
        )
        .0;
        let request = RagSearchRequest {
            query_text: "关键词检索".into(),
            query_vector: None,
            top_k: 2,
            threshold: 0.0,
            file_paths: vec![],
            keyword_search_enabled: true,
            current_file_path: None,
            prefer_current_file: false,
            prefer_recent_documents: false,
            keyword_only_fallback: false,
        };
        let scores = HashMap::from([("a".into(), 0.8)]);
        let hits = search_index_with_fts(&index, &request, Some(&scores));
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].chunk.id, "a");
        assert_eq!(hits[1].chunk.id, "b");
    }

    #[tokio::test]
    #[ignore = "manual anonymous keyword search baseline"]
    async fn compare_legacy_and_fts_keyword_latency() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        pool.execute("CREATE TABLE chunks (id TEXT PRIMARY KEY, document_id TEXT, content TEXT, heading TEXT, title_path TEXT)")
            .await.unwrap();
        pool.execute("CREATE VIRTUAL TABLE chunks_fts USING fts5(content, heading, title_path, content='chunks', content_rowid='rowid', tokenize='trigram')")
            .await.unwrap();
        let mut transaction = pool.begin().await.unwrap();
        let mut chunks = Vec::new();
        for i in 0..5_000 {
            let id = format!("c{i}");
            let content = if i % 10 == 0 {
                format!("ordinary paragraph with benchmark target {i}")
            } else {
                format!("ordinary paragraph with other material {i}")
            };
            sqlx::query("INSERT INTO chunks VALUES (?, 'd', ?, '', '')")
                .bind(&id)
                .bind(&content)
                .execute(&mut *transaction)
                .await
                .unwrap();
            chunks.push(RawChunk {
                id,
                document_id: "d".into(),
                content,
                content_hash: Some(format!("h{i}")),
                index: i,
                start_line: i,
                end_line: i,
                title_path: None,
                heading: None,
                source_type: "markdown".into(),
                embedding: None,
            });
        }
        transaction.commit().await.unwrap();
        pool.execute("INSERT INTO chunks_fts(chunks_fts) VALUES ('rebuild')")
            .await
            .unwrap();
        let index = build_index(
            vec![RawDocument {
                id: "d".into(),
                file_path: "C:/anonymous.md".into(),
                title: "anonymous".into(),
                last_modified: 0,
            }],
            chunks,
        )
        .0;
        let request = RagSearchRequest {
            query_text: "benchmark target".into(),
            query_vector: None,
            top_k: 10,
            threshold: 0.0,
            file_paths: vec![],
            keyword_search_enabled: true,
            current_file_path: None,
            prefer_current_file: false,
            prefer_recent_documents: false,
            keyword_only_fallback: false,
        };
        let started = Instant::now();
        for _ in 0..20 {
            std::hint::black_box(search_index(&index, &request));
        }
        let legacy_ms = started.elapsed().as_millis();
        let started = Instant::now();
        for _ in 0..20 {
            let scores = fts_keyword_scores(&pool, None, &request).await.unwrap();
            std::hint::black_box(search_index_with_fts(&index, &request, Some(&scores)));
        }
        println!(
            "anonymous 5000 chunks / 20 queries: legacy={legacy_ms}ms fts={}ms",
            started.elapsed().as_millis()
        );
    }

    #[test]
    fn active_initialization_can_be_cancelled_idempotently() {
        let service = RagIndexService::default();
        let token = CancellationToken::new();
        *service.initialization_cancellation.lock().unwrap() = Some(token.clone());
        assert!(cancel_active_initialization(&service).unwrap());
        assert!(token.is_cancelled());
        *service.initialization_cancellation.lock().unwrap() = None;
        assert!(!cancel_active_initialization(&service).unwrap());
    }

    #[test]
    fn invalid_and_mismatched_vectors_are_skipped() {
        let documents = vec![RawDocument {
            id: "d".into(),
            file_path: "C:\\a.md".into(),
            title: "a".into(),
            last_modified: 0,
        }];
        let raw = |id: &str, embedding: &str| RawChunk {
            id: id.into(),
            document_id: "d".into(),
            content: id.into(),
            content_hash: None,
            index: 0,
            start_line: 1,
            end_line: 1,
            title_path: None,
            heading: None,
            source_type: "markdown".into(),
            embedding: Some(embedding.into()),
        };
        let (index, skipped) = build_index(
            documents,
            vec![
                raw("a", "[1,0]"),
                raw("b", "[0,1]"),
                raw("bad", "oops"),
                raw("dimension", "[1,2,3]"),
            ],
        );
        assert_eq!(index.vector_dimension, Some(2));
        assert_eq!(
            index
                .chunks
                .iter()
                .filter(|chunk| chunk.embedding.is_some())
                .count(),
            2
        );
        assert_eq!(skipped, 2);
    }

    #[test]
    fn tokenizer_keeps_ascii_and_chinese_terms_separate() {
        let terms: HashSet<String> = tokenize("Rust索引初始化").into_iter().collect();
        assert!(terms.contains("rust"));
        assert!(terms.contains("索引初始化"));
        assert!(terms.contains("索引"));
        assert!(!terms.contains("rust索引初始化"));
    }

    fn assert_score(actual: f32, expected: f32) {
        assert!(
            (actual - expected).abs() < 0.000_001,
            "expected score {expected}, got {actual}"
        );
    }

    fn boost_test_index() -> RagIndex {
        let documents = vec![RawDocument {
            id: "current".into(),
            file_path: "C:\\current.md".into(),
            title: "anonymous".into(),
            last_modified: 0,
        }];
        let chunks = vec![RawChunk {
            id: "current-1".into(),
            document_id: "current".into(),
            content: "rust".into(),
            content_hash: Some("current-1".into()),
            index: 0,
            start_line: 1,
            end_line: 1,
            title_path: None,
            heading: None,
            source_type: "markdown".into(),
            embedding: Some("[0.6,0.8]".into()),
        }];
        build_index(documents, chunks).0
    }

    fn boost_test_request() -> RagSearchRequest {
        RagSearchRequest {
            query_text: "rust missing".into(),
            query_vector: None,
            top_k: 1,
            threshold: 0.0,
            file_paths: vec![],
            keyword_search_enabled: true,
            current_file_path: Some("c:/current.md".into()),
            prefer_current_file: true,
            prefer_recent_documents: false,
            keyword_only_fallback: false,
        }
    }

    #[test]
    fn search_applies_current_file_boost_once_per_retrieval_mode() {
        let index = boost_test_index();

        let keyword_hits = search_index(&index, &boost_test_request());
        assert_eq!(keyword_hits[0].retrieval_mode, "keyword");
        assert_score(keyword_hits[0].keyword_score.unwrap(), 0.5);
        assert_score(keyword_hits[0].score, 0.58);

        let vector_request = RagSearchRequest {
            query_text: String::new(),
            query_vector: Some(vec![1.0, 0.0]),
            keyword_search_enabled: false,
            ..boost_test_request()
        };
        let vector_hits = search_index(&index, &vector_request);
        assert_eq!(vector_hits[0].retrieval_mode, "vector");
        assert_score(vector_hits[0].vector_score.unwrap(), 0.6);
        assert_score(vector_hits[0].score, 0.68);

        let hybrid_request = RagSearchRequest {
            query_vector: Some(vec![1.0, 0.0]),
            ..boost_test_request()
        };
        let hybrid_hits = search_index(&index, &hybrid_request);
        assert_eq!(hybrid_hits[0].retrieval_mode, "hybrid");
        assert_score(hybrid_hits[0].vector_score.unwrap(), 0.6);
        assert_score(hybrid_hits[0].keyword_score.unwrap(), 0.5);
        assert_score(hybrid_hits[0].score, 0.692);
        assert_eq!(
            hybrid_hits
                .iter()
                .map(|hit| &hit.chunk.id)
                .collect::<Vec<_>>(),
            search_index(&index, &hybrid_request)
                .iter()
                .map(|hit| &hit.chunk.id)
                .collect::<Vec<_>>()
        );
        assert!(keyword_hits
            .iter()
            .chain(vector_hits.iter())
            .chain(hybrid_hits.iter())
            .all(|hit| hit.score <= 1.0));
    }

    #[test]
    #[ignore = "reads the current user's installed Guanmo database"]
    fn local_database_initialization_profile() {
        let Some(app_data) = std::env::var_os("APPDATA") else {
            return;
        };
        let path = PathBuf::from(app_data)
            .join("com.guanmo.app")
            .join("guanmo.db");
        if !path.is_file() {
            return;
        }
        let started = Instant::now();
        let (documents, chunks) = tauri::async_runtime::block_on(async {
            let pool = open_readonly_pool(path).await.expect("open local database");
            load_raw_index(&pool, true)
                .await
                .expect("load local RAG rows")
        });
        let (index, skipped) = build_index(documents, chunks);
        println!(
            "local RAG profile: documents={}, chunks={}, vectors={}, skipped={}, elapsed_ms={}",
            index.documents.len(),
            index.chunks.len(),
            index
                .chunks
                .iter()
                .filter(|chunk| chunk.embedding.is_some())
                .count(),
            skipped,
            started.elapsed().as_millis(),
        );
        assert!(!index.documents.is_empty());
    }

    #[test]
    fn hybrid_search_preserves_scope_and_current_file_boost() {
        let documents = vec![
            RawDocument {
                id: "a".into(),
                file_path: "C:\\a.md".into(),
                title: "a".into(),
                last_modified: 0,
            },
            RawDocument {
                id: "b".into(),
                file_path: "C:\\b.md".into(),
                title: "b".into(),
                last_modified: 0,
            },
        ];
        let title_path = serde_json::to_string(&vec!["topic"]).unwrap();
        let raw = |id: &str, doc: &str, content: &str, embedding: &str| RawChunk {
            id: id.into(),
            document_id: doc.into(),
            content: content.into(),
            content_hash: Some(id.into()),
            index: 0,
            start_line: 1,
            end_line: 1,
            title_path: Some(title_path.clone()),
            heading: None,
            source_type: "markdown".into(),
            embedding: Some(embedding.into()),
        };
        let (index, _) = build_index(
            documents,
            vec![
                raw("a1", "a", "rust index", "[1,0]"),
                raw("b1", "b", "rust index", "[0.9,0.1]"),
            ],
        );
        let request = RagSearchRequest {
            query_text: "rust".into(),
            query_vector: Some(vec![1.0, 0.0]),
            top_k: 2,
            threshold: 0.0,
            file_paths: vec![],
            keyword_search_enabled: true,
            current_file_path: Some("c:/b.md".into()),
            prefer_current_file: true,
            prefer_recent_documents: false,
            keyword_only_fallback: false,
        };
        let hits = search_index(&index, &request);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].retrieval_mode, "hybrid");
        let scoped = RagSearchRequest {
            file_paths: vec!["c:/a.md".into()],
            ..request
        };
        assert_eq!(search_index(&index, &scoped).len(), 1);
    }
}
