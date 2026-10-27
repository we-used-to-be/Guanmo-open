//! Desktop-only MCP client. No startup work or Agent registration.
pub mod config;
pub mod http;
pub mod oauth;
mod oauth_http;
mod transport;

use rmcp::{
    model::{
        CallToolRequestParams, CallToolResponse, GetPromptRequestParams, PaginatedRequestParams,
        ProtocolVersion, ReadResourceRequestParams,
    },
    service::{NotificationContext, RunningService},
    ClientHandler, RoleClient,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, LazyLock, Mutex,
    },
    time::{Duration, Instant},
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tokio_util::sync::CancellationToken;

const TIMEOUT: Duration = Duration::from_secs(30);
const PROPOSAL_TTL: Duration = Duration::from_secs(120);
const MAX_TOOLS: usize = 200;
const MAX_CATALOG_BYTES: usize = 262144;
const MAX_ARGUMENT_BYTES: usize = 8192;
const MAX_RESOURCE_ITEMS: usize = 200;
const MAX_RESOURCE_BYTES: usize = 262144;
const MAX_READ_RESULT_BYTES: usize = 1024 * 1024;
type Result<T> = std::result::Result<T, &'static str>;

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StdioConfig {
    pub server_id: String,
    pub executable: String,
    pub args: Vec<String>,
    pub cwd: String,
}

impl StdioConfig {
    fn validate_shape(&self) -> Result<()> {
        if !valid_id(&self.server_id)
            || self.args.len() > 64
            || self.args.iter().any(|a| a.contains('\0'))
            || self.args.iter().map(String::len).sum::<usize>() > 8192
            || self.executable.len() > 4096
            || self.cwd.len() > 4096
            || !Path::new(&self.executable).is_absolute()
            || !Path::new(&self.cwd).is_absolute()
        {
            return Err("MCP_CONFIG_INVALID");
        }
        // No cmd/bat shims or implicit shell. Users choose an installed executable.
        #[cfg(windows)]
        if !Path::new(&self.executable)
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("exe"))
        {
            return Err("MCP_EXECUTABLE_REQUIRED");
        }
        Ok(())
    }

    fn validate(&self) -> Result<()> {
        self.validate_shape()?;
        if !Path::new(&self.executable).is_file() || !Path::new(&self.cwd).is_dir() {
            return Err("MCP_CONFIG_INVALID");
        }
        Ok(())
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 40
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

fn check_json_budget(value: &Value, depth: usize, nodes: &mut usize) -> Result<()> {
    *nodes += 1;
    if depth > 32 || *nodes > 20000 {
        return Err("MCP_CATALOG_LIMIT");
    }
    match value {
        Value::Array(values) => {
            for value in values {
                check_json_budget(value, depth + 1, nodes)?;
            }
        }
        Value::Object(values) => {
            for value in values.values() {
                check_json_budget(value, depth + 1, nodes)?;
            }
        }
        _ => {}
    }
    Ok(())
}

static SEQUENCE: AtomicU64 = AtomicU64::new(1);
fn new_id(prefix: &str) -> String {
    format!("{prefix}-{}", SEQUENCE.fetch_add(1, Ordering::Relaxed))
}

#[derive(Default)]
struct Runtime {
    configs: HashMap<String, StdioConfig>,
    sessions: HashMap<String, Arc<Session>>,
    proposals: HashMap<String, Proposal>,
    authorizations: HashMap<String, AuthorizationOperation>,
    authorization_errors: HashMap<String, &'static str>,
}

struct AuthorizationOperation {
    server_id: String,
    request_id: String,
    cancel: CancellationToken,
}

static RUNTIME: LazyLock<Mutex<Runtime>> = LazyLock::new(|| Mutex::new(Runtime::default()));
static DIALOG: LazyLock<Arc<tokio::sync::Mutex<()>>> =
    LazyLock::new(|| Arc::new(tokio::sync::Mutex::new(())));

struct Session {
    server_id: String,
    request_id: String,
    target: String,
    id: String,
    cancel: CancellationToken,
    epoch: Arc<AtomicU64>,
    // At most one list/call operation per connection, without an unbounded queue.
    operation: tokio::sync::Mutex<()>,
    client: Mutex<Option<Arc<RunningService<RoleClient, Handler>>>>,
    catalog: Mutex<Option<Catalog>>,
    resource_epoch: Arc<AtomicU64>,
    prompt_epoch: Arc<AtomicU64>,
    resources: Mutex<Option<ResourceCatalog>>,
    prompts: Mutex<Option<PromptCatalog>>,
}

impl Drop for Session {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

struct Handler {
    epoch: Arc<AtomicU64>,
    resource_epoch: Arc<AtomicU64>,
    prompt_epoch: Arc<AtomicU64>,
}
impl ClientHandler for Handler {
    async fn on_tool_list_changed(&self, _: NotificationContext<RoleClient>) {
        self.epoch.fetch_add(1, Ordering::SeqCst);
    }
    async fn on_resource_list_changed(&self, _: NotificationContext<RoleClient>) {
        self.resource_epoch.fetch_add(1, Ordering::SeqCst);
    }
    async fn on_prompt_list_changed(&self, _: NotificationContext<RoleClient>) {
        self.prompt_epoch.fetch_add(1, Ordering::SeqCst);
    }
    // Default capabilities are empty. Sampling, roots and elicitation are refused.
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    server_id: String,
    connection_id: String,
    catalog_revision: String,
    protocol_version: String,
    tools: Vec<Value>,
    #[serde(skip)]
    epoch: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceCatalog {
    connection_id: String,
    catalog_revision: String,
    resources: Vec<Value>,
    #[serde(skip)]
    epoch: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptCatalog {
    connection_id: String,
    catalog_revision: String,
    prompts: Vec<Value>,
    #[serde(skip)]
    epoch: u64,
}

#[derive(Clone)]
struct Proposal {
    session: Arc<Session>,
    revision: String,
    epoch: u64,
    name: String,
    arguments: Value,
    expires: Instant,
    cancel: CancellationToken,
    claimed: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrepareCall {
    connection_id: String,
    catalog_revision: String,
    tool_name: String,
    arguments: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallProposal {
    proposal_id: String,
    server_id: String,
    connection_id: String,
    catalog_revision: String,
    tool_name: String,
    arguments: Value,
    expires_in_seconds: u64,
}

fn session(id: &str) -> Result<Arc<Session>> {
    let runtime = RUNTIME.lock().map_err(|_| "MCP_STATE_ERROR")?;
    let s = runtime
        .sessions
        .get(id)
        .ok_or("MCP_CONNECTION_MISSING")?
        .clone();
    if s.cancel.is_cancelled() {
        return Err("MCP_DISCONNECTED");
    }
    Ok(s)
}

fn client(s: &Session) -> Result<Arc<RunningService<RoleClient, Handler>>> {
    let client = s
        .client
        .lock()
        .map_err(|_| "MCP_STATE_ERROR")?
        .clone()
        .ok_or("MCP_CONNECTING")?;
    if s.cancel.is_cancelled() || client.is_closed() {
        return Err("MCP_DISCONNECTED");
    }
    Ok(client)
}

pub(crate) async fn confirm(
    app: &tauri::AppHandle,
    message: String,
    cancel: &CancellationToken,
) -> Result<()> {
    use tauri::Manager;
    let guard = DIALOG
        .clone()
        .try_lock_owned()
        .map_err(|_| "MCP_CONFIRMATION_BUSY")?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let window = app.get_webview_window("main").ok_or("MCP_WINDOW_MISSING")?;
    app.dialog()
        .message(message)
        .title("观墨 · MCP 授权")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancel)
        .parent(&window)
        .show(move |accepted| {
            drop(guard);
            let _ = tx.send(accepted);
        });
    tokio::select! {
        _ = cancel.cancelled() => Err("MCP_CANCELLED"),
        result = tokio::time::timeout(PROPOSAL_TTL, rx) => {
            match result { Ok(Ok(true)) => Ok(()), _ => Err("MCP_CONFIRMATION_REJECTED") }
        }
    }
}

/// Registration is session-only in phase 2. Phase 3 owns versioned configuration/DPAPI.
#[tauri::command]
pub async fn mcp_register_stdio(app: tauri::AppHandle, config: StdioConfig) -> Result<()> {
    let checked = config.clone();
    tauri::async_runtime::spawn_blocking(move || checked.validate())
        .await
        .map_err(|_| "MCP_CONFIG_INVALID")??;
    confirm(&app, format!("登记本地 MCP 服务 {}（本次运行有效）？\n\n可执行文件：{}\n参数：{}\n工作目录：{}\n\n仅继承 SystemRoot、WINDIR、TEMP、TMP；不传递现有 API 密钥。\n第三方进程拥有当前 Windows 用户权限，观墨文件授权不能沙箱化它。\n参数不得包含凭据；本阶段不支持凭据或自定义环境变量。",
        config.server_id, config.executable, serde_json::to_string(&config.args).map_err(|_| "MCP_CONFIG_INVALID")?, config.cwd), &CancellationToken::new()).await?;
    let mut runtime = RUNTIME.lock().map_err(|_| "MCP_STATE_ERROR")?;
    if runtime
        .sessions
        .values()
        .any(|s| s.server_id == config.server_id)
    {
        return Err("MCP_DISCONNECT_FIRST");
    }
    if !runtime.configs.contains_key(&config.server_id) && runtime.configs.len() >= 8 {
        return Err("MCP_SERVER_LIMIT");
    }
    runtime.configs.insert(config.server_id.clone(), config);
    Ok(())
}

fn reserve(approved: &StdioConfig, request_id: &str) -> Result<Arc<Session>> {
    if !valid_id(request_id) {
        return Err("MCP_REQUEST_ID_INVALID");
    }
    let server_id = approved.server_id.as_str();
    let s = {
        let mut runtime = RUNTIME.lock().map_err(|_| "MCP_STATE_ERROR")?;
        let config = runtime
            .configs
            .get(server_id)
            .ok_or("MCP_SERVER_MISSING")?
            .clone();
        if config != *approved {
            return Err("MCP_CONFIG_CHANGED");
        }
        reserve_session(&mut runtime, server_id, request_id, &approved.executable)?
    };
    Ok(s)
}

fn reserve_session(
    runtime: &mut Runtime,
    server_id: &str,
    request_id: &str,
    target: &str,
) -> Result<Arc<Session>> {
    if !valid_id(request_id) {
        return Err("MCP_REQUEST_ID_INVALID");
    }
    if runtime.sessions.len() >= 8 {
        return Err("MCP_SERVER_LIMIT");
    }
    if runtime.sessions.values().any(|s| s.server_id == server_id) {
        return Err("MCP_ALREADY_CONNECTED");
    }
    if runtime
        .sessions
        .values()
        .any(|s| s.request_id == request_id)
    {
        return Err("MCP_REQUEST_ID_USED");
    }
    let s = Arc::new(Session {
        server_id: server_id.to_owned(),
        request_id: request_id.to_owned(),
        target: target.to_owned(),
        id: new_id("connection"),
        cancel: CancellationToken::new(),
        epoch: Arc::new(AtomicU64::new(1)),
        operation: tokio::sync::Mutex::new(()),
        client: Mutex::new(None),
        catalog: Mutex::new(None),
        resource_epoch: Arc::new(AtomicU64::new(1)),
        prompt_epoch: Arc::new(AtomicU64::new(1)),
        resources: Mutex::new(None),
        prompts: Mutex::new(None),
    });
    runtime.sessions.insert(s.id.clone(), s.clone());
    Ok(s)
}

async fn start(
    s: Arc<Session>,
    config: &StdioConfig,
    env: &std::collections::BTreeMap<String, String>,
) -> Result<Arc<Session>> {
    let result = async {
        if s.cancel.is_cancelled() {
            return Err("MCP_CANCELLED");
        }
        let transport =
            transport::StdioTransport::spawn(config, env).map_err(|_| "MCP_SPAWN_FAILED")?;
        let handler = Handler {
            epoch: s.epoch.clone(),
            resource_epoch: s.resource_epoch.clone(),
            prompt_epoch: s.prompt_epoch.clone(),
        };
        let lifecycle = rmcp::service::ClientLifecycleMode::Auto {
            preferred_versions: vec![ProtocolVersion::V_2026_07_28, ProtocolVersion::V_2025_11_25],
            legacy_version: Some(ProtocolVersion::V_2025_11_25),
        };
        let running = tokio::time::timeout(
            TIMEOUT,
            rmcp::service::serve_client_with_lifecycle_and_ct(
                handler,
                transport,
                lifecycle,
                s.cancel.clone(),
            ),
        )
        .await
        .map_err(|_| "MCP_CONNECT_TIMEOUT")?
        .map_err(|_| "MCP_INITIALIZE_FAILED")?;
        if s.cancel.is_cancelled() {
            return Err("MCP_CANCELLED");
        }
        *s.client.lock().map_err(|_| "MCP_STATE_ERROR")? = Some(Arc::new(running));
        Ok(())
    }
    .await;
    if let Err(error) = result {
        let _ = disconnect(&s.id);
        return Err(error);
    }
    Ok(s)
}

#[tauri::command]
pub async fn mcp_connect(
    app: tauri::AppHandle,
    server_id: String,
    request_id: String,
) -> Result<Catalog> {
    // File/decryption work stays off the UI thread; reserve under the config lock.
    let app_config = app.clone();
    let id = server_id.clone();
    let (s, config, env, oauth_bytes) = tauri::async_runtime::spawn_blocking(move || {
        let _guard = config::CONFIG_LOCK.lock().map_err(|_| "MCP_STATE_ERROR")?;
        config::connection(&config::path(&app_config)?, &id, &request_id)
    })
    .await
    .map_err(|_| "MCP_CONFIG_READ_FAILED")??;
    let consent = confirm(
        &app,
        format!(
            "连接 MCP 服务？\n\n{}",
            config.target_details(&env.keys().cloned().collect::<Vec<_>>().join(", "))?
        ),
        &s.cancel,
    )
    .await;
    if let Err(error) = consent {
        let _ = disconnect(&s.id);
        return Err(error);
    }
    let authorization = if let Some(bytes) = oauth_bytes {
        match oauth::manager_for_connection(&app, &server_id, &config, &s.cancel, &bytes).await {
            Ok(manager) => Some(manager),
            Err(error) => {
                let _ = disconnect(&s.id);
                return Err(error);
            }
        }
    } else {
        None
    };
    let s = match config.start(s.clone(), &env, authorization).await {
        Ok(s) => s,
        Err(error) => {
            let _ = disconnect(&s.id);
            return Err(error);
        }
    };
    match list_catalog(&s).await {
        Ok(catalog) => Ok(catalog),
        Err(error) => {
            let _ = disconnect(&s.id);
            Err(error)
        }
    }
}

async fn list_catalog(s: &Arc<Session>) -> Result<Catalog> {
    let _operation = s.operation.try_lock().map_err(|_| "MCP_BUSY")?;
    // Invalidate outstanding confirmations before beginning any refresh.
    let epoch = s.epoch.fetch_add(1, Ordering::SeqCst) + 1;
    *s.catalog.lock().map_err(|_| "MCP_STATE_ERROR")? = None;
    let peer = client(s)?;
    let mut tools = Vec::new();
    let mut cursor = None;
    let mut cursors = HashSet::new();
    let mut names = HashSet::new();
    let mut nodes = 0;
    let request = async {
        for _ in 0..32 {
            let mut params = PaginatedRequestParams::default();
            params.cursor = cursor.clone();
            let page = peer
                .list_tools(Some(params))
                .await
                .map_err(|_| "MCP_LIST_FAILED")?;
            for tool in page.tools {
                if tools.len() >= MAX_TOOLS
                    || tool.name.is_empty()
                    || tool.name.len() > 128
                    || !tool
                        .name
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
                    || tool
                        .description
                        .as_ref()
                        .is_some_and(|d| d.chars().count() > 8192)
                    || !names.insert(tool.name.to_string())
                {
                    return Err("MCP_CATALOG_INVALID");
                }
                let value = serde_json::to_value(tool).map_err(|_| "MCP_CATALOG_INVALID")?;
                if value["inputSchema"]["type"] != "object" {
                    return Err("MCP_CATALOG_INVALID");
                }
                check_json_budget(&value, 1, &mut nodes)?;
                tools.push(value);
            }
            if serde_json::to_vec(&tools)
                .map_err(|_| "MCP_CATALOG_INVALID")?
                .len()
                > MAX_CATALOG_BYTES
            {
                return Err("MCP_CATALOG_LIMIT");
            }
            match page.next_cursor {
                Some(next) if next.len() <= 4096 && cursors.insert(next.clone()) => {
                    cursor = Some(next)
                }
                Some(_) => return Err("MCP_CURSOR_INVALID"),
                None => return Ok(()),
            }
        }
        Err("MCP_PAGE_LIMIT")
    };
    tokio::select! {
        _ = s.cancel.cancelled() => return Err("MCP_CANCELLED"),
        result = tokio::time::timeout(TIMEOUT, request) => result.map_err(|_| "MCP_LIST_TIMEOUT")??,
    }
    if s.epoch.load(Ordering::SeqCst) != epoch {
        return Err("MCP_CATALOG_CHANGED");
    }
    let protocol_version = peer
        .peer_info()
        .ok_or("MCP_INITIALIZE_FAILED")?
        .protocol_version
        .to_string();
    let catalog = Catalog {
        server_id: s.server_id.clone(),
        connection_id: s.id.clone(),
        catalog_revision: new_id("catalog"),
        protocol_version,
        tools,
        epoch,
    };
    *s.catalog.lock().map_err(|_| "MCP_STATE_ERROR")? = Some(catalog.clone());
    Ok(catalog)
}

#[tauri::command]
pub async fn mcp_list_tools(connection_id: String) -> Result<Catalog> {
    list_catalog(&session(&connection_id)?).await
}

async fn list_remote_resources(s: &Arc<Session>) -> Result<ResourceCatalog> {
    let _operation = s.operation.try_lock().map_err(|_| "MCP_BUSY")?;
    let peer = client(s)?;
    let epoch = s.resource_epoch.load(Ordering::SeqCst);
    let result = async {
        let mut resources = Vec::new();
        let mut cursors = HashSet::new();
        let mut cursor = None;
        let mut nodes = 0;
        for _ in 0..32 {
            let mut params = PaginatedRequestParams::default();
            params.cursor = cursor.clone();
            let page = peer
                .list_resources(Some(params))
                .await
                .map_err(|_| "MCP_RESOURCE_LIST_FAILED")?;
            for resource in page.resources {
                if resources.len() >= MAX_RESOURCE_ITEMS
                    || resource.uri.is_empty()
                    || resource.uri.len() > 4096
                    || resource.name.is_empty()
                    || resource.name.len() > 128
                    || resource
                        .description
                        .as_ref()
                        .is_some_and(|value| value.chars().count() > 8192)
                    || resources
                        .iter()
                        .any(|value: &Value| value["uri"] == resource.uri)
                {
                    return Err("MCP_RESOURCE_CATALOG_INVALID");
                }
                let value =
                    serde_json::to_value(resource).map_err(|_| "MCP_RESOURCE_CATALOG_INVALID")?;
                check_json_budget(&value, 1, &mut nodes)?;
                resources.push(value);
            }
            if serde_json::to_vec(&resources)
                .map_err(|_| "MCP_RESOURCE_CATALOG_INVALID")?
                .len()
                > MAX_RESOURCE_BYTES
            {
                return Err("MCP_RESOURCE_CATALOG_LIMIT");
            }
            cursor = page.next_cursor.map(|value| value.to_string());
            match &cursor {
                Some(value) if !cursors.insert(value.clone()) => return Err("MCP_CURSOR_INVALID"),
                None => break,
                Some(_) if cursors.len() >= 32 => return Err("MCP_PAGE_LIMIT"),
                _ => {}
            }
        }
        if s.cancel.is_cancelled() || s.resource_epoch.load(Ordering::SeqCst) != epoch {
            return Err("MCP_RESOURCE_CATALOG_CHANGED");
        }
        Ok(ResourceCatalog {
            connection_id: s.id.clone(),
            catalog_revision: new_id("resources"),
            resources,
            epoch,
        })
    };
    let catalog = tokio::select! {
        _ = s.cancel.cancelled() => return Err("MCP_CANCELLED"),
        result = tokio::time::timeout(TIMEOUT, result) => result.map_err(|_| "MCP_RESOURCE_LIST_TIMEOUT")??,
    };
    *s.resources.lock().map_err(|_| "MCP_STATE_ERROR")? = Some(catalog.clone());
    Ok(catalog)
}

#[tauri::command]
pub async fn mcp_list_resources(connection_id: String) -> Result<ResourceCatalog> {
    list_remote_resources(&session(&connection_id)?).await
}

async fn list_remote_prompts(s: &Arc<Session>) -> Result<PromptCatalog> {
    let _operation = s.operation.try_lock().map_err(|_| "MCP_BUSY")?;
    let peer = client(s)?;
    let epoch = s.prompt_epoch.load(Ordering::SeqCst);
    let result = async {
        let mut prompts = Vec::new();
        let mut cursors = HashSet::new();
        let mut cursor = None;
        let mut nodes = 0;
        for _ in 0..32 {
            let mut params = PaginatedRequestParams::default();
            params.cursor = cursor.clone();
            let page = peer
                .list_prompts(Some(params))
                .await
                .map_err(|_| "MCP_PROMPT_LIST_FAILED")?;
            for prompt in page.prompts {
                if prompts.len() >= MAX_RESOURCE_ITEMS
                    || prompt.name.is_empty()
                    || prompt.name.len() > 128
                    || prompt
                        .description
                        .as_ref()
                        .is_some_and(|value| value.chars().count() > 8192)
                    || prompts
                        .iter()
                        .any(|value: &Value| value["name"] == prompt.name)
                {
                    return Err("MCP_PROMPT_CATALOG_INVALID");
                }
                let value =
                    serde_json::to_value(prompt).map_err(|_| "MCP_PROMPT_CATALOG_INVALID")?;
                check_json_budget(&value, 1, &mut nodes)?;
                prompts.push(value);
            }
            if serde_json::to_vec(&prompts)
                .map_err(|_| "MCP_PROMPT_CATALOG_INVALID")?
                .len()
                > MAX_RESOURCE_BYTES
            {
                return Err("MCP_PROMPT_CATALOG_LIMIT");
            }
            cursor = page.next_cursor.map(|value| value.to_string());
            match &cursor {
                Some(value) if !cursors.insert(value.clone()) => return Err("MCP_CURSOR_INVALID"),
                None => break,
                Some(_) if cursors.len() >= 32 => return Err("MCP_PAGE_LIMIT"),
                _ => {}
            }
        }
        if s.cancel.is_cancelled() || s.prompt_epoch.load(Ordering::SeqCst) != epoch {
            return Err("MCP_PROMPT_CATALOG_CHANGED");
        }
        Ok(PromptCatalog {
            connection_id: s.id.clone(),
            catalog_revision: new_id("prompts"),
            prompts,
            epoch,
        })
    };
    let catalog = tokio::select! {
        _ = s.cancel.cancelled() => return Err("MCP_CANCELLED"),
        result = tokio::time::timeout(TIMEOUT, result) => result.map_err(|_| "MCP_PROMPT_LIST_TIMEOUT")??,
    };
    *s.prompts.lock().map_err(|_| "MCP_STATE_ERROR")? = Some(catalog.clone());
    Ok(catalog)
}

#[tauri::command]
pub async fn mcp_list_prompts(connection_id: String) -> Result<PromptCatalog> {
    list_remote_prompts(&session(&connection_id)?).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadResource {
    connection_id: String,
    catalog_revision: String,
    uri: String,
}

fn ensure_resource_selected(s: &Session, catalog_revision: &str, uri: &str) -> Result<()> {
    let catalog = s
        .resources
        .lock()
        .map_err(|_| "MCP_STATE_ERROR")?
        .clone()
        .ok_or("MCP_RESOURCE_CATALOG_MISSING")?;
    if catalog.connection_id != s.id
        || catalog.catalog_revision != catalog_revision
        || catalog.epoch != s.resource_epoch.load(Ordering::SeqCst)
        || !catalog
            .resources
            .iter()
            .any(|resource| resource["uri"].as_str() == Some(uri))
    {
        return Err("MCP_RESOURCE_CATALOG_CHANGED");
    }
    if uri.is_empty() || uri.len() > 4096 || uri.chars().any(char::is_control) {
        return Err("MCP_RESOURCE_URI_INVALID");
    }
    Ok(())
}

async fn request_resource(s: &Session, uri: String) -> Result<Value> {
    let peer = client(s)?;
    let result = tokio::select! {
        _ = s.cancel.cancelled() => return Err("MCP_CANCELLED"),
        result = tokio::time::timeout(TIMEOUT, peer.read_resource_once(ReadResourceRequestParams::new(uri))) => result.map_err(|_| "MCP_RESOURCE_READ_TIMEOUT")?.map_err(|_| "MCP_RESOURCE_READ_FAILED")?,
    };
    let value = match result {
        rmcp::model::ReadResourceResponse::Complete(result) => {
            serde_json::to_value(result).map_err(|_| "MCP_RESOURCE_RESULT_INVALID")?
        }
        rmcp::model::ReadResourceResponse::InputRequired(_) => {
            return Err("MCP_INTERACTION_UNSUPPORTED")
        }
        _ => return Err("MCP_RESOURCE_RESULT_INVALID"),
    };
    validate_read_result(
        &value,
        "MCP_RESOURCE_RESULT_INVALID",
        "MCP_RESOURCE_RESULT_LIMIT",
    )?;
    Ok(value)
}

fn validate_read_result(value: &Value, invalid: &'static str, limit: &'static str) -> Result<()> {
    if serde_json::to_vec(value).map_err(|_| invalid)?.len() > MAX_READ_RESULT_BYTES {
        return Err(limit);
    }
    let mut nodes = 0;
    check_json_budget(value, 1, &mut nodes).map_err(|_| invalid)
}

#[tauri::command]
pub async fn mcp_read_resource(app: tauri::AppHandle, request: ReadResource) -> Result<Value> {
    let s = session(&request.connection_id)?;
    let _operation = s.operation.try_lock().map_err(|_| "MCP_BUSY")?;
    ensure_resource_selected(&s, &request.catalog_revision, &request.uri)?;
    confirm(&app, format!("读取所选 MCP 资源？\n\n服务：{}\n目标：{}\n资源 URI：{}\n\n内容来自外部服务，将作为不可信数据展示。不会读取观墨本地文件。", s.server_id, s.target, request.uri), &s.cancel).await?;
    ensure_resource_selected(&s, &request.catalog_revision, &request.uri)?;
    request_resource(&s, request.uri).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GetPrompt {
    connection_id: String,
    catalog_revision: String,
    name: String,
    arguments: Value,
}

fn ensure_prompt_selected(s: &Session, catalog_revision: &str, name: &str) -> Result<()> {
    let catalog = s
        .prompts
        .lock()
        .map_err(|_| "MCP_STATE_ERROR")?
        .clone()
        .ok_or("MCP_PROMPT_CATALOG_MISSING")?;
    if catalog.connection_id != s.id
        || catalog.catalog_revision != catalog_revision
        || catalog.epoch != s.prompt_epoch.load(Ordering::SeqCst)
        || !catalog
            .prompts
            .iter()
            .any(|prompt| prompt["name"].as_str() == Some(name))
    {
        return Err("MCP_PROMPT_CATALOG_CHANGED");
    }
    Ok(())
}

async fn request_prompt(s: &Session, name: String, arguments: Value) -> Result<Value> {
    let args = arguments
        .as_object()
        .cloned()
        .ok_or("MCP_ARGUMENTS_INVALID")?;
    let peer = client(s)?;
    let mut params = GetPromptRequestParams::new(name);
    params.arguments = Some(args);
    let result = tokio::select! {
        _ = s.cancel.cancelled() => return Err("MCP_CANCELLED"),
        result = tokio::time::timeout(TIMEOUT, peer.get_prompt_once(params)) => result.map_err(|_| "MCP_PROMPT_GET_TIMEOUT")?.map_err(|_| "MCP_PROMPT_GET_FAILED")?,
    };
    let value = match result {
        rmcp::model::GetPromptResponse::Complete(result) => {
            serde_json::to_value(result).map_err(|_| "MCP_PROMPT_RESULT_INVALID")?
        }
        rmcp::model::GetPromptResponse::InputRequired(_) => {
            return Err("MCP_INTERACTION_UNSUPPORTED")
        }
        _ => return Err("MCP_PROMPT_RESULT_INVALID"),
    };
    validate_read_result(
        &value,
        "MCP_PROMPT_RESULT_INVALID",
        "MCP_PROMPT_RESULT_LIMIT",
    )?;
    Ok(value)
}

#[tauri::command]
pub async fn mcp_get_prompt(app: tauri::AppHandle, request: GetPrompt) -> Result<Value> {
    if !request.arguments.is_object()
        || serde_json::to_vec(&request.arguments)
            .map_err(|_| "MCP_ARGUMENTS_INVALID")?
            .len()
            > MAX_ARGUMENT_BYTES
    {
        return Err("MCP_ARGUMENTS_INVALID");
    }
    let s = session(&request.connection_id)?;
    let _operation = s.operation.try_lock().map_err(|_| "MCP_BUSY")?;
    ensure_prompt_selected(&s, &request.catalog_revision, &request.name)?;
    confirm(&app, format!("获取所选 MCP Prompt？\n\n服务：{}\n目标：{}\nPrompt：{}\n参数：{}\n\n返回内容是不可信的外部资料，不会自动加入系统提示。", s.server_id, s.target, request.name, serde_json::to_string_pretty(&request.arguments).map_err(|_| "MCP_ARGUMENTS_INVALID")?), &s.cancel).await?;
    ensure_prompt_selected(&s, &request.catalog_revision, &request.name)?;
    request_prompt(&s, request.name, request.arguments).await
}

#[tauri::command]
pub fn mcp_prepare_call(request: PrepareCall) -> Result<CallProposal> {
    if !request.arguments.is_object()
        || serde_json::to_vec(&request.arguments)
            .map_err(|_| "MCP_ARGUMENTS_INVALID")?
            .len()
            > MAX_ARGUMENT_BYTES
    {
        return Err("MCP_ARGUMENTS_INVALID");
    }
    let s = session(&request.connection_id)?;
    let _ = client(&s)?;
    let catalog = s
        .catalog
        .lock()
        .map_err(|_| "MCP_STATE_ERROR")?
        .clone()
        .ok_or("MCP_CATALOG_MISSING")?;
    if catalog.catalog_revision != request.catalog_revision
        || catalog.epoch != s.epoch.load(Ordering::SeqCst)
        || !catalog
            .tools
            .iter()
            .any(|t| t.get("name").and_then(Value::as_str) == Some(&request.tool_name))
    {
        return Err("MCP_CATALOG_CHANGED");
    }
    let id = new_id("proposal");
    let result = CallProposal {
        proposal_id: id.clone(),
        server_id: s.server_id.clone(),
        connection_id: s.id.clone(),
        catalog_revision: request.catalog_revision.clone(),
        tool_name: request.tool_name.clone(),
        arguments: request.arguments.clone(),
        expires_in_seconds: PROPOSAL_TTL.as_secs(),
    };
    let mut runtime = RUNTIME.lock().map_err(|_| "MCP_STATE_ERROR")?;
    runtime.proposals.retain(|_, p| {
        p.expires > Instant::now() && !p.cancel.is_cancelled() && !p.session.cancel.is_cancelled()
    });
    if runtime.proposals.len() >= 32 {
        return Err("MCP_PROPOSAL_LIMIT");
    }
    runtime.proposals.insert(
        id,
        Proposal {
            session: s,
            revision: request.catalog_revision,
            epoch: catalog.epoch,
            name: request.tool_name,
            arguments: request.arguments,
            expires: Instant::now() + PROPOSAL_TTL,
            cancel: CancellationToken::new(),
            claimed: false,
        },
    );
    Ok(result)
}

fn claim(id: &str) -> Result<Proposal> {
    let mut runtime = RUNTIME.lock().map_err(|_| "MCP_STATE_ERROR")?;
    let p = runtime
        .proposals
        .get_mut(id)
        .ok_or("MCP_PROPOSAL_MISSING")?;
    if p.claimed {
        return Err("MCP_PROPOSAL_USED");
    }
    p.claimed = true;
    Ok(p.clone())
}

fn validate_proposal(p: &Proposal) -> Result<()> {
    if p.cancel.is_cancelled() || p.session.cancel.is_cancelled() {
        return Err("MCP_CANCELLED");
    }
    if p.expires <= Instant::now() {
        return Err("MCP_PROPOSAL_EXPIRED");
    }
    let _ = client(&p.session)?;
    let catalog = p.session.catalog.lock().map_err(|_| "MCP_STATE_ERROR")?;
    if p.session.epoch.load(Ordering::SeqCst) != p.epoch
        || catalog.as_ref().map(|c| &c.catalog_revision) != Some(&p.revision)
    {
        return Err("MCP_CATALOG_CHANGED");
    }
    Ok(())
}

async fn execute(p: &Proposal) -> Result<Value> {
    let _operation = p.session.operation.try_lock().map_err(|_| "MCP_BUSY")?;
    validate_proposal(p)?;
    let peer = client(&p.session)?;
    let mut params = CallToolRequestParams::new(p.name.clone());
    params.arguments = p.arguments.as_object().cloned();
    // Never use the SDK's MRTR helper: it can repeat tools/call without a new confirmation.
    let request = peer.call_tool_once(params);
    let result = tokio::select! {
        _ = p.cancel.cancelled() => return Err("MCP_CANCELLED_OUTCOME_UNKNOWN"),
        _ = p.session.cancel.cancelled() => return Err("MCP_DISCONNECTED_OUTCOME_UNKNOWN"),
        result = tokio::time::timeout(TIMEOUT, request) => result.map_err(|_| "MCP_CALL_TIMEOUT_OUTCOME_UNKNOWN")?.map_err(|_| "MCP_CALL_FAILED_OUTCOME_UNKNOWN")?,
    };
    validate_proposal(p)?;
    let CallToolResponse::Complete(result) = result else {
        return Err("MCP_INTERACTION_UNSUPPORTED");
    };
    let value = serde_json::to_value(result).map_err(|_| "MCP_RESULT_INVALID")?;
    if serde_json::to_vec(&value)
        .map_err(|_| "MCP_RESULT_INVALID")?
        .len()
        > 1024 * 1024
    {
        return Err("MCP_RESULT_LIMIT");
    }
    Ok(value)
}

#[tauri::command]
pub async fn mcp_confirm_call(app: tauri::AppHandle, proposal_id: String) -> Result<Value> {
    let p = claim(&proposal_id)?;
    let result = async {
        validate_proposal(&p)?;
        confirm(&app, format!("执行外部 MCP 工具？\n\n服务：{}\n目标：{}\n连接：{}\n目录：{}\n工具：{}\n参数：{}\n\n可能产生外部副作用。工具描述和只读标注不代表安全保证。",
            p.session.server_id, p.session.target, p.session.id, p.revision, p.name, serde_json::to_string_pretty(&p.arguments).map_err(|_| "MCP_ARGUMENTS_INVALID")?), &p.cancel).await?;
        execute(&p).await
    }.await;
    RUNTIME
        .lock()
        .map_err(|_| "MCP_STATE_ERROR")?
        .proposals
        .remove(&proposal_id);
    result
}

#[tauri::command]
pub fn mcp_cancel_call(proposal_id: String) -> Result<()> {
    let mut runtime = RUNTIME.lock().map_err(|_| "MCP_STATE_ERROR")?;
    if let Some(p) = runtime.proposals.remove(&proposal_id) {
        p.cancel.cancel();
    }
    Ok(())
}

fn revoke_server(runtime: &mut Runtime, id: &str) {
    runtime.configs.remove(id);
    runtime.sessions.retain(|_, s| {
        if s.server_id == id {
            s.cancel.cancel();
            false
        } else {
            true
        }
    });
    runtime.proposals.retain(|_, p| {
        if p.session.server_id == id {
            p.cancel.cancel();
            false
        } else {
            true
        }
    });
    runtime.authorizations.retain(|_, operation| {
        if operation.server_id == id {
            operation.cancel.cancel();
            false
        } else {
            true
        }
    });
    runtime.authorization_errors.remove(id);
}

fn disconnect(id: &str) -> Result<()> {
    let mut runtime = RUNTIME.lock().map_err(|_| "MCP_STATE_ERROR")?;
    if let Some(s) = runtime.sessions.remove(id) {
        s.cancel.cancel();
    }
    runtime.proposals.retain(|_, p| {
        if p.session.id == id {
            p.cancel.cancel();
            false
        } else {
            true
        }
    });
    Ok(())
}

#[tauri::command]
pub fn mcp_disconnect(connection_id: String) -> Result<()> {
    disconnect(&connection_id)
}

#[tauri::command]
pub fn mcp_cancel_connect(request_id: String) -> Result<()> {
    let ids: Vec<String> = RUNTIME
        .lock()
        .map_err(|_| "MCP_STATE_ERROR")?
        .sessions
        .values()
        .filter(|s| s.request_id == request_id)
        .map(|s| s.id.clone())
        .collect();
    for id in ids {
        disconnect(&id)?;
    }
    Ok(())
}

pub fn shutdown() {
    if let Ok(mut runtime) = RUNTIME.lock() {
        for p in runtime.proposals.values() {
            p.cancel.cancel();
        }
        for s in runtime.sessions.values() {
            s.cancel.cancel();
        }
        runtime.proposals.clear();
        runtime.sessions.clear();
        for operation in runtime.authorizations.values() {
            operation.cancel.cancel();
        }
        runtime.authorizations.clear();
    }
}

#[cfg(test)]
mod tests;
