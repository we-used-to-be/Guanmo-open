use super::*;
use serde_json::json;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, LazyLock, Mutex},
    time::Duration,
};
use tauri::{Emitter, Manager};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

#[path = "edits.rs"]
pub mod edits;

#[cfg(test)]
#[path = "runtime_tests.rs"]
mod tests;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Scope {
    path: String,
    directory: bool,
}

struct Active {
    generation: String,
    config: ServerConfig,
    network: network::RunningServer,
}
struct PendingQuery {
    generation: String,
    name: String,
    arguments: Value,
    scopes: Vec<Scope>,
    keys: Vec<String>,
    sender: oneshot::Sender<Result<Value>>,
}
#[derive(Default)]
struct Runtime {
    active: Option<Active>,
    starting: Option<(String, CancellationToken)>,
    queries: HashMap<String, PendingQuery>,
}
static RUNTIME: LazyLock<Mutex<Runtime>> = LazyLock::new(|| Mutex::new(Runtime::default()));
// Same file-byte boundary as the Markdown opening policy; results are separately paginated.
const MAX_DOCUMENT_BYTES: u64 = 1536 * 1024;

fn id() -> String {
    oauth2::CsrfToken::new_random().secret().to_owned()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    running: bool,
    starting: bool,
    generation: Option<String>,
    endpoint: Option<String>,
    config: Option<ServerConfig>,
}

#[tauri::command]
pub fn mcp_server_status() -> Result<Status> {
    let runtime = RUNTIME.lock().map_err(|_| "MCP_SERVER_STATE_ERROR")?;
    Ok(Status {
        running: runtime.active.is_some(),
        starting: runtime.starting.is_some(),
        generation: runtime
            .active
            .as_ref()
            .map(|a| a.generation.clone())
            .or_else(|| runtime.starting.as_ref().map(|(id, _)| id.clone())),
        endpoint: runtime.active.as_ref().map(|a| a.network.endpoint.clone()),
        config: runtime.active.as_ref().map(|a| a.config.clone()),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    paths: Vec<Scope>,
    next_offset: Option<usize>,
}

#[tauri::command]
pub async fn mcp_server_options(app: tauri::AppHandle, offset: Option<usize>) -> Result<Options> {
    let offset = offset.unwrap_or(0);
    if offset > 10000 {
        return Err("MCP_SERVER_ARGUMENTS_INVALID");
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<crate::FsAccessState>();
        crate::wait_for_file_access_restore_state(&state);
        let workspaces: Vec<_> = state
            .workspaces
            .lock()
            .map_err(|_| "MCP_SERVER_STATE_ERROR")?
            .iter()
            .cloned()
            .collect();
        let files: Vec<_> = state
            .selected_files
            .lock()
            .map_err(|_| "MCP_SERVER_STATE_ERROR")?
            .iter()
            .cloned()
            .collect();
        let mut scopes: Vec<_> = workspaces
            .into_iter()
            .filter(|p| p.is_dir())
            .map(|p| Scope {
                path: p.to_string_lossy().into_owned(),
                directory: true,
            })
            .collect();
        scopes.extend(
            files
                .into_iter()
                .filter(|p| p.is_file() && crate::is_markdown_file_path(p))
                .map(|p| Scope {
                    path: p.to_string_lossy().into_owned(),
                    directory: false,
                }),
        );
        scopes.sort_by(|a, b| a.path.cmp(&b.path));
        let next_offset = (scopes.len() > offset + 50).then_some(offset + 50);
        Ok(Options {
            paths: scopes.into_iter().skip(offset).take(50).collect(),
            next_offset,
        })
    })
    .await
    .map_err(|_| "MCP_SERVER_SCOPE_REJECTED")?
}

fn allowed_path(app: &tauri::AppHandle, scopes: &[Scope], path: &str) -> Result<PathBuf> {
    let state = app.state::<crate::FsAccessState>();
    allowed_path_in_state(&state, scopes, path)
}

fn allowed_path_in_state(
    state: &crate::FsAccessState,
    scopes: &[Scope],
    path: &str,
) -> Result<PathBuf> {
    let canonical = crate::ensure_allowed_existing_text_file(
        state,
        Path::new(path),
        crate::FileAction::ReadText,
    )
    .map_err(|_| "MCP_SERVER_SCOPE_REJECTED")?;
    if !crate::is_markdown_file_path(&canonical)
        || !scopes.iter().any(|scope| {
            if scope.directory {
                crate::is_inside(Path::new(&scope.path), &canonical)
            } else {
                Path::new(&scope.path) == canonical
            }
        })
    {
        return Err("MCP_SERVER_SCOPE_REJECTED");
    }
    Ok(canonical)
}

fn validate_config(app: &tauri::AppHandle, config: &mut ServerConfig) -> Result<Vec<Scope>> {
    if config.paths.len() > 32
        || config.artifact_keys.len() > 100
        || (!config.read_documents
            && !config.search_knowledge
            && !config.read_artifacts
            && !config.write_documents)
        || ((config.read_documents || config.search_knowledge || config.write_documents)
            && config.paths.is_empty())
        || (config.read_artifacts && config.artifact_keys.is_empty())
    {
        return Err("MCP_SERVER_ARGUMENTS_INVALID");
    }
    if config.artifact_keys.iter().any(|key| {
        key.len() > 200
            || key.chars().any(char::is_control)
            || !matches!(key.split_once(':'), Some(("ai" | "mark", id)) if !id.is_empty())
    }) {
        return Err("MCP_SERVER_ARGUMENTS_INVALID");
    }
    let state = app.state::<crate::FsAccessState>();
    crate::wait_for_file_access_restore_state(&state);
    let mut scopes = Vec::new();
    for path in &config.paths {
        if path.len() > 4096 || !Path::new(path).is_absolute() {
            return Err("MCP_SERVER_SCOPE_REJECTED");
        }
        let canonical = Path::new(path)
            .canonicalize()
            .map_err(|_| "MCP_SERVER_SCOPE_REJECTED")?;
        let directory = canonical.is_dir();
        if directory {
            if !crate::is_authorized_for_action(&state, &canonical, crate::FileAction::ReadDir)
                .map_err(|_| "MCP_SERVER_SCOPE_REJECTED")?
            {
                return Err("MCP_SERVER_SCOPE_REJECTED");
            }
        } else {
            if !crate::is_markdown_file_path(&canonical) {
                return Err("MCP_SERVER_SCOPE_REJECTED");
            }
            crate::ensure_allowed_existing_text_file(
                &state,
                &canonical,
                crate::FileAction::ReadText,
            )
            .map_err(|_| "MCP_SERVER_SCOPE_REJECTED")?;
        }
        scopes.push(Scope {
            path: canonical.to_string_lossy().into_owned(),
            directory,
        });
    }
    scopes.sort_by(|a, b| a.path.cmp(&b.path));
    scopes.dedup_by(|a, b| a.path == b.path);
    config.paths = scopes.iter().map(|scope| scope.path.clone()).collect();
    config.artifact_keys.sort();
    config.artifact_keys.dedup();
    Ok(scopes)
}

#[derive(Clone)]
struct AppBackend {
    app: tauri::AppHandle,
    config: ServerConfig,
    scopes: Vec<Scope>,
    generation: String,
    cancel: CancellationToken,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadDocument {
    path: String,
    #[serde(default)]
    offset: usize,
    #[serde(default = "default_chars")]
    max_chars: usize,
}
fn default_chars() -> usize {
    8192
}

fn read_document(
    state: &crate::FsAccessState,
    scopes: &[Scope],
    args: ReadDocument,
    cancel: &CancellationToken,
) -> Result<Value> {
    if cancel.is_cancelled() {
        return Err("MCP_SERVER_STOPPED");
    }
    let path = allowed_path_in_state(state, scopes, &args.path)?;
    let content = crate::read_text_file_with_limit(&path, Some(MAX_DOCUMENT_BYTES))
        .map_err(|_| "MCP_SERVER_FILE_READ_FAILED")?;
    if cancel.is_cancelled() {
        return Err("MCP_SERVER_STOPPED");
    }
    let total = content.chars().count();
    let text: String = content
        .chars()
        .skip(args.offset)
        .take(args.max_chars)
        .collect();
    let next = args.offset.saturating_add(text.chars().count());
    Ok(
        json!({"path":path.to_string_lossy(),"content":text,"contentHash":edits::content_hash(&content),"offset":args.offset,"totalChars":total,"nextOffset":(next < total).then_some(next)}),
    )
}

#[async_trait::async_trait]
impl Backend for AppBackend {
    async fn call(&self, name: &str, arguments: Value) -> Result<Value> {
        if self.cancel.is_cancelled() {
            return Err("MCP_SERVER_STOPPED");
        }
        if matches!(
            name,
            "propose_document_edit" | "get_document_edit" | "cancel_document_edit"
        ) {
            return edits::call(self, name, arguments).await;
        }
        if name == "read_document" {
            if !self.config.read_documents {
                return Err("MCP_SERVER_SCOPE_REJECTED");
            }
            let args: ReadDocument =
                serde_json::from_value(arguments).map_err(|_| "MCP_SERVER_ARGUMENTS_INVALID")?;
            if args.max_chars == 0 || args.max_chars > 32768 {
                return Err("MCP_SERVER_ARGUMENTS_INVALID");
            }
            let backend = self.clone();
            return tauri::async_runtime::spawn_blocking(move || {
                let state = backend.app.state::<crate::FsAccessState>();
                read_document(&state, &backend.scopes, args, &backend.cancel)
            })
            .await
            .map_err(|_| "MCP_SERVER_FILE_READ_FAILED")?;
        }
        let permitted = match name {
            "search_knowledge" => self.config.search_knowledge,
            "list_reading_artifacts" | "read_reading_artifact" => self.config.read_artifacts,
            _ => false,
        };
        if !permitted {
            return Err("MCP_SERVER_SCOPE_REJECTED");
        }
        self.query(name, arguments).await
    }
}

impl AppBackend {
    async fn query(&self, name: &str, arguments: Value) -> Result<Value> {
        let request_id = id();
        let (sender, receiver) = oneshot::channel();
        {
            let mut runtime = RUNTIME.lock().map_err(|_| "MCP_SERVER_STATE_ERROR")?;
            if !runtime
                .active
                .as_ref()
                .is_some_and(|a| a.generation == self.generation)
                || runtime.queries.len() >= 8
            {
                return Err("MCP_SERVER_STOPPED");
            }
            runtime.queries.insert(
                request_id.clone(),
                PendingQuery {
                    generation: self.generation.clone(),
                    name: name.into(),
                    arguments: arguments.clone(),
                    scopes: self.scopes.clone(),
                    keys: self.config.artifact_keys.clone(),
                    sender,
                },
            );
        }
        let _pending = PendingGuard {
            request_id: request_id.clone(),
            generation: self.generation.clone(),
        };
        self.app.emit_to("main", "guanmo:mcp-server-query", json!({"requestId":request_id,"generation":self.generation,"toolName":name,"arguments":arguments,"paths":self.scopes,"artifactKeys":self.config.artifact_keys})).map_err(|_| "MCP_SERVER_BRIDGE_UNAVAILABLE")?;
        tokio::select! {
            _ = self.cancel.cancelled() => Err("MCP_SERVER_STOPPED"),
            result = tokio::time::timeout(Duration::from_secs(20), receiver) => result.map_err(|_| "MCP_SERVER_QUERY_TIMEOUT")?.map_err(|_| "MCP_SERVER_BRIDGE_UNAVAILABLE")?,
        }
    }
}

struct PendingGuard {
    request_id: String,
    generation: String,
}
impl Drop for PendingGuard {
    fn drop(&mut self) {
        if let Ok(mut runtime) = RUNTIME.lock() {
            if runtime
                .queries
                .get(&self.request_id)
                .is_some_and(|p| p.generation == self.generation)
            {
                runtime.queries.remove(&self.request_id);
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueryReply {
    request_id: String,
    generation: String,
    result: Option<Value>,
    error: Option<String>,
}

#[tauri::command]
pub async fn mcp_server_reply(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request_id: String,
    generation: String,
    result: Option<Value>,
    error: Option<String>,
) -> Result<()> {
    let reply = QueryReply {
        request_id,
        generation,
        result,
        error,
    };
    if window.label() != "main" {
        return Err("MCP_SERVER_SCOPE_REJECTED");
    }
    let (name, arguments, scopes, keys) = {
        let runtime = RUNTIME.lock().map_err(|_| "MCP_SERVER_STATE_ERROR")?;
        let pending = runtime
            .queries
            .get(&reply.request_id)
            .filter(|p| p.generation == reply.generation)
            .ok_or("MCP_SERVER_REQUEST_MISSING")?;
        (
            pending.name.clone(),
            pending.arguments.clone(),
            pending.scopes.clone(),
            pending.keys.clone(),
        )
    };
    let value = match (reply.result, reply.error) {
        (Some(value), None) => {
            if serde_json::to_vec(&value)
                .map_err(|_| "MCP_SERVER_RESULT_INVALID")?
                .len()
                > 256 * 1024
            {
                return Err("MCP_SERVER_RESULT_LIMIT");
            }
            tauri::async_runtime::spawn_blocking(move || {
                if name == "search_knowledge" {
                    let items = value["items"]
                        .as_array()
                        .filter(|items| items.len() <= 20)
                        .ok_or("MCP_SERVER_RESULT_INVALID")?;
                    for item in items {
                        allowed_path(
                            &app,
                            &scopes,
                            item["path"].as_str().ok_or("MCP_SERVER_RESULT_INVALID")?,
                        )?;
                    }
                } else if name == "list_reading_artifacts" {
                    let items = value["items"]
                        .as_array()
                        .filter(|items| items.len() <= 20)
                        .ok_or("MCP_SERVER_RESULT_INVALID")?;
                    if items.iter().any(|item| {
                        !item["key"]
                            .as_str()
                            .is_some_and(|key| keys.iter().any(|allowed| allowed == key))
                    }) {
                        return Err("MCP_SERVER_SCOPE_REJECTED");
                    }
                } else if name == "read_reading_artifact" {
                    let key = value["key"].as_str().ok_or("MCP_SERVER_RESULT_INVALID")?;
                    if !keys.iter().any(|allowed| allowed == key)
                        || arguments["key"].as_str() != Some(key)
                    {
                        return Err("MCP_SERVER_SCOPE_REJECTED");
                    }
                } else if name == "capture_document_edit" {
                    if value != json!({"captured":true}) {
                        return Err("MCP_SERVER_RESULT_INVALID");
                    }
                } else {
                    return Err("MCP_SERVER_TOOL_UNAVAILABLE");
                }
                Ok(value)
            })
            .await
            .map_err(|_| "MCP_SERVER_RESULT_INVALID")?
        }
        (None, Some(code)) => Err(match code.as_str() {
            "MCP_SERVER_DATABASE_NOT_READY" => "MCP_SERVER_DATABASE_NOT_READY",
            "MCP_SERVER_SCOPE_REJECTED" => "MCP_SERVER_SCOPE_REJECTED",
            "MCP_SERVER_ARGUMENTS_INVALID" => "MCP_SERVER_ARGUMENTS_INVALID",
            "MCP_SERVER_ARTIFACT_MISSING" => "MCP_SERVER_ARTIFACT_MISSING",
            "MCP_SERVER_BUSY" => "MCP_SERVER_BUSY",
            "MCP_SERVER_EDIT_CONFLICT" => "MCP_SERVER_EDIT_CONFLICT",
            _ => "MCP_SERVER_QUERY_FAILED",
        }),
        _ => return Err("MCP_SERVER_RESULT_INVALID"),
    };
    let mut runtime = RUNTIME.lock().map_err(|_| "MCP_SERVER_STATE_ERROR")?;
    if !runtime
        .active
        .as_ref()
        .is_some_and(|a| a.generation == reply.generation)
    {
        return Err("MCP_SERVER_STOPPED");
    }
    let pending = runtime
        .queries
        .remove(&reply.request_id)
        .filter(|p| p.generation == reply.generation)
        .ok_or("MCP_SERVER_REQUEST_MISSING")?;
    pending
        .sender
        .send(value)
        .map_err(|_| "MCP_SERVER_REQUEST_MISSING")
}

#[tauri::command]
pub async fn mcp_server_start(
    app: tauri::AppHandle,
    mut config: ServerConfig,
    request_id: String,
) -> Result<Status> {
    if request_id.is_empty() || request_id.len() > 128 || request_id.chars().any(char::is_control) {
        return Err("MCP_SERVER_ARGUMENTS_INVALID");
    }
    let generation = request_id;
    let cancel = CancellationToken::new();
    {
        let mut runtime = RUNTIME.lock().map_err(|_| "MCP_SERVER_STATE_ERROR")?;
        if runtime.active.is_some() || runtime.starting.is_some() {
            return Err("MCP_SERVER_ALREADY_RUNNING");
        }
        runtime.starting = Some((generation.clone(), cancel.clone()));
    }
    let result = async {
        let source = app.clone();
        let (config, scopes) = tauri::async_runtime::spawn_blocking(move || {
            let scopes = validate_config(&source, &mut config)?;
            Ok::<_, &'static str>((config, scopes))
        }).await.map_err(|_| "MCP_SERVER_SCOPE_REJECTED")??;
        crate::mcp::confirm(&app, format!("启用本机 MCP 服务端？\n\n仅监听127.0.0.1；持有独立随机token的外部客户端可访问以下授权内容。重启后关闭。\n\nMarkdown范围：{}\n允许读取文档：{}；关键词检索：{}\n完整阅读成果授权：{}\n成果keys：{}\n允许提出文档修改：{}（每次修改仍需观墨内核对差异并原生确认）\n\n不继承观墨MCP客户端或内部Agent权限。", config.paths.join("\n"), config.read_documents, config.search_knowledge, config.read_artifacts, config.artifact_keys.join("\n"), config.write_documents), &cancel).await?;
        let backend = Arc::new(AppBackend { app: app.clone(), config: config.clone(), scopes, generation: generation.clone(), cancel: cancel.clone() });
        let network = network::start(&config, backend, cancel.clone()).await?;
        let mut runtime = RUNTIME.lock().map_err(|_| "MCP_SERVER_STATE_ERROR")?;
        if cancel.is_cancelled() || !runtime.starting.as_ref().is_some_and(|(id, _)| id == &generation) { return Err("MCP_SERVER_STOPPED"); }
        runtime.active = Some(Active { generation: generation.clone(), config, network });
        Ok(())
    }.await;
    if let Ok(mut runtime) = RUNTIME.lock() {
        if runtime
            .starting
            .as_ref()
            .is_some_and(|(id, _)| id == &generation)
        {
            runtime.starting = None;
        }
    }
    if result.is_err() {
        cancel.cancel();
    }
    result?;
    mcp_server_status()
}

#[derive(Serialize)]
pub struct ConnectionInfo {
    endpoint: String,
    token: String,
}
#[tauri::command]
pub fn mcp_server_connection_info() -> Result<ConnectionInfo> {
    let runtime = RUNTIME.lock().map_err(|_| "MCP_SERVER_STATE_ERROR")?;
    let active = runtime.active.as_ref().ok_or("MCP_SERVER_STOPPED")?;
    Ok(ConnectionInfo {
        endpoint: active.network.endpoint.clone(),
        token: active.network.token.clone(),
    })
}

pub fn shutdown() {
    edits::stop(None);
    if let Ok(mut runtime) = RUNTIME.lock() {
        if let Some((_, cancel)) = runtime.starting.take() {
            cancel.cancel();
        }
        if let Some(active) = runtime.active.take() {
            active.network.cancel.cancel();
        }
        for (_, pending) in runtime.queries.drain() {
            let _ = pending.sender.send(Err("MCP_SERVER_STOPPED"));
        }
    }
}

#[tauri::command]
pub async fn mcp_server_stop(generation: Option<String>) -> Result<()> {
    let active = {
        let mut runtime = RUNTIME.lock().map_err(|_| "MCP_SERVER_STATE_ERROR")?;
        let matches = |id: &str| generation.as_ref().is_none_or(|expected| expected == id);
        if runtime.starting.as_ref().is_some_and(|(id, _)| matches(id)) {
            if let Some((_, cancel)) = runtime.starting.take() {
                cancel.cancel();
            }
        }
        let pending_ids: Vec<_> = runtime
            .queries
            .iter()
            .filter(|(_, p)| matches(&p.generation))
            .map(|(id, _)| id.clone())
            .collect();
        for id in pending_ids {
            if let Some(pending) = runtime.queries.remove(&id) {
                let _ = pending.sender.send(Err("MCP_SERVER_STOPPED"));
            }
        }
        if runtime
            .active
            .as_ref()
            .is_some_and(|a| matches(&a.generation))
        {
            runtime.active.take()
        } else {
            None
        }
    };
    edits::stop(generation.as_deref());
    if let Some(mut active) = active {
        active.network.cancel.cancel();
        if tokio::time::timeout(Duration::from_secs(2), &mut active.network.task)
            .await
            .is_err()
        {
            active.network.task.abort();
            let _ = (&mut active.network.task).await;
        }
    }
    Ok(())
}
