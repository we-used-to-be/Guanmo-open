//! Independent, versioned application configuration. Never part of business backups.
use super::*;
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    path::PathBuf,
};
use tauri::Manager;

#[cfg(test)]
#[path = "config_tests.rs"]
pub(super) mod tests;

pub(super) static CONFIG_LOCK: Mutex<()> = Mutex::new(());
const MAX_FILE: u64 = 1024 * 1024;

/// Untagged stdio preserves the original v1 shape byte-for-field.
#[derive(Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(untagged)]
pub enum ServerConfig {
    Stdio(StdioConfig),
    Http(HttpConfig),
}

#[derive(Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HttpConfig {
    transport: HttpTransport,
    server_id: String,
    url: String,
}

#[derive(Clone, PartialEq, Eq, Deserialize, Serialize)]
enum HttpTransport {
    #[serde(rename = "http")]
    Http,
}

impl ServerConfig {
    pub(super) fn http_url(&self) -> Option<&str> {
        match self {
            Self::Http(c) => Some(&c.url),
            Self::Stdio(_) => None,
        }
    }
    fn server_id(&self) -> &str {
        match self {
            Self::Stdio(c) => &c.server_id,
            Self::Http(c) => &c.server_id,
        }
    }

    fn validate_shape(&self) -> Result<()> {
        match self {
            Self::Stdio(c) => c.validate_shape(),
            Self::Http(c) => {
                if !valid_id(&c.server_id) {
                    return Err("MCP_CONFIG_INVALID");
                }
                http::endpoint(&c.url).map(|_| ())
            }
        }
    }

    fn validate(&self) -> Result<()> {
        self.validate_shape()?;
        if let Self::Stdio(c) = self {
            c.validate()?;
        }
        Ok(())
    }

    pub(super) fn target_details(&self, env_names: &str) -> Result<String> {
        Ok(match self {
            Self::Stdio(c) => format!("服务 ID：{}\n\n可执行文件：{}\n参数：{}\n工作目录：{}\n环境变量名：{}\n\n仅继承 SystemRoot、WINDIR、TEMP、TMP，并注入以上显式配置的变量。该进程拥有当前系统用户权限，观墨文件授权不能沙箱化它。", c.server_id, c.executable, serde_json::to_string(&c.args).map_err(|_| "MCP_CONFIG_INVALID")?, c.cwd, env_names),
            Self::Http(c) => format!("服务 ID：{}\n\n端点：{}\n\n连接时将向此精确端点发送 MCP 协议请求，并授权访问端点解析出的本机/私网地址；公网仅允许 HTTPS。若已完成 OAuth，仅将令牌发送至此精确服务；不跟随重定向，DNS 地址变化后需重新连接。工具调用仍逐项确认；断线或未知结果不会自动重试。", c.server_id, c.url),
        })
    }

    pub(super) async fn start(
        &self,
        session: Arc<Session>,
        env: &BTreeMap<String, String>,
        authorization: Option<Arc<rmcp::transport::auth::AuthorizationManager>>,
    ) -> Result<Arc<Session>> {
        match self {
            Self::Stdio(c) if authorization.is_none() => super::start(session, c, env).await,
            Self::Stdio(_) => Err("MCP_CONFIG_INVALID"),
            Self::Http(c) => {
                http::start_http(session, http::endpoint(&c.url)?, authorization).await
            }
        }
    }
}

#[derive(Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SavedServer {
    config: ServerConfig,
    name: String,
    enabled: bool,
    env: BTreeMap<String, Vec<u8>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    oauth: Option<Vec<u8>>,
}

#[derive(PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Store {
    version: u32,
    servers: Vec<SavedServer>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveServer {
    config: ServerConfig,
    name: String,
    /// Omitted keys retain ciphertext; null removes; a string explicitly replaces.
    #[serde(default)]
    env_changes: BTreeMap<String, Option<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerView {
    config: ServerConfig,
    name: String,
    enabled: bool,
    env_names: Vec<String>,
    connection_id: Option<String>,
    status: &'static str,
    authorization_status: &'static str,
    authorization_error: Option<&'static str>,
}

/// Rust-owned location injection for the isolated native host, never an IPC argument.
pub struct ConfigPath(pub PathBuf);

pub(super) fn path(app: &tauri::AppHandle) -> Result<PathBuf> {
    if let Some(path) = app.try_state::<ConfigPath>() {
        return Ok(path.0.clone());
    }
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|_| "MCP_CONFIG_PATH_FAILED")?
        .join("mcp-servers.json"))
}

fn valid_env_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .bytes()
            .enumerate()
            .all(|(i, c)| c == b'_' || c.is_ascii_alphabetic() || (i > 0 && c.is_ascii_digit()))
}

fn validate_store(store: &Store) -> Result<()> {
    if store.version != 1 {
        return Err("MCP_CONFIG_VERSION_UNSUPPORTED");
    }
    let mut ids = HashSet::new();
    for server in &store.servers {
        server.config.validate_shape()?;
        let mut env_names = HashSet::new();
        if !ids.insert(server.config.server_id())
            || (matches!(server.config, ServerConfig::Http(_)) && !server.env.is_empty())
            || (server.oauth.is_some() && !matches!(&server.config, ServerConfig::Http(_)))
            || server
                .oauth
                .as_ref()
                .is_some_and(|oauth| oauth.is_empty() || oauth.len() > 256 * 1024)
            || server.name.trim().is_empty()
            || server.name.len() > 160
            || server.env.len() > 32
            || server.env.iter().any(|(name, value)| {
                !valid_env_name(name)
                    || !env_names.insert(name.to_ascii_uppercase())
                    || value.is_empty()
                    || value.len() > 32768
            })
        {
            return Err("MCP_CONFIG_CORRUPT");
        }
    }
    if store.servers.len() > 8 {
        return Err("MCP_SERVER_LIMIT");
    }
    Ok(())
}

fn read(path: &Path) -> Result<Store> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Store {
                version: 1,
                servers: vec![],
            })
        }
        Err(_) => return Err("MCP_CONFIG_READ_FAILED"),
    };
    let mut bytes = Vec::new();
    file.take(MAX_FILE + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "MCP_CONFIG_READ_FAILED")?;
    if bytes.len() as u64 > MAX_FILE {
        return Err("MCP_CONFIG_LIMIT");
    }
    // Check the version before decoding fields so future formats cannot be overwritten.
    let raw: Value = serde_json::from_slice(&bytes).map_err(|_| "MCP_CONFIG_CORRUPT")?;
    if raw.get("version").and_then(Value::as_u64) != Some(1) {
        return Err("MCP_CONFIG_VERSION_UNSUPPORTED");
    }
    let store: Store = serde_json::from_value(raw).map_err(|_| "MCP_CONFIG_CORRUPT")?;
    validate_store(&store)?;
    Ok(store)
}

fn write(path: &Path, store: &Store) -> Result<()> {
    validate_store(store)?;
    let bytes = serde_json::to_vec(store).map_err(|_| "MCP_CONFIG_INVALID")?;
    if bytes.len() as u64 > MAX_FILE {
        return Err("MCP_CONFIG_LIMIT");
    }
    fs::create_dir_all(path.parent().ok_or("MCP_CONFIG_PATH_FAILED")?)
        .map_err(|_| "MCP_CONFIG_WRITE_FAILED")?;
    let temporary = path.with_extension(format!("{}.{}.tmp", std::process::id(), new_id("write")));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| "MCP_CONFIG_WRITE_FAILED")?;
    let result = (|| {
        file.write_all(&bytes)
            .map_err(|_| "MCP_CONFIG_WRITE_FAILED")?;
        file.sync_all().map_err(|_| "MCP_CONFIG_WRITE_FAILED")?;
        drop(file);
        fs::rename(&temporary, path).map_err(|_| "MCP_CONFIG_WRITE_FAILED")
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

pub(super) fn load_oauth_bytes(
    path: &Path,
    id: &str,
    expected_url: &str,
) -> Result<Option<Vec<u8>>> {
    let store = read(path)?;
    let server = store
        .servers
        .iter()
        .find(|s| s.config.server_id() == id)
        .ok_or("MCP_SERVER_MISSING")?;
    let ServerConfig::Http(http) = &server.config else {
        return Err("MCP_OAUTH_HTTP_REQUIRED");
    };
    if !server.enabled || http.url != expected_url {
        return Err("MCP_CONFIG_CHANGED");
    }
    server
        .oauth
        .as_ref()
        .map(|bytes| {
            crate::secret_protection::unprotect_secret(bytes)
                .map(String::into_bytes)
                .map_err(|_| "MCP_OAUTH_STORE_READ_FAILED")
        })
        .transpose()
}

pub(super) fn save_oauth_bytes(
    path: &Path,
    id: &str,
    expected_url: &str,
    bytes: &[u8],
    cancel: &CancellationToken,
) -> Result<()> {
    if cancel.is_cancelled() || bytes.is_empty() || bytes.len() > 128 * 1024 {
        return Err("MCP_CANCELLED");
    }
    let mut store = read(path)?;
    let server = store
        .servers
        .iter_mut()
        .find(|s| s.config.server_id() == id)
        .ok_or("MCP_SERVER_MISSING")?;
    let ServerConfig::Http(http) = &server.config else {
        return Err("MCP_OAUTH_HTTP_REQUIRED");
    };
    if !server.enabled || http.url != expected_url {
        return Err("MCP_CONFIG_CHANGED");
    }
    let plaintext = std::str::from_utf8(bytes).map_err(|_| "MCP_OAUTH_STORE_WRITE_FAILED")?;
    server.oauth = Some(
        crate::secret_protection::protect_secret(plaintext)
            .map_err(|_| "MCP_SECRET_PROTECT_FAILED")?,
    );
    let runtime = RUNTIME.lock().map_err(|_| "MCP_STATE_ERROR")?;
    if cancel.is_cancelled() {
        return Err("MCP_CANCELLED");
    }
    write(path, &store)?;
    drop(runtime);
    Ok(())
}

pub(super) fn authorization_target(path: &Path, id: &str) -> Result<String> {
    let store = read(path)?;
    let server = store
        .servers
        .iter()
        .find(|s| s.config.server_id() == id)
        .ok_or("MCP_SERVER_MISSING")?;
    if !server.enabled {
        return Err("MCP_SERVER_DISABLED");
    }
    match &server.config {
        ServerConfig::Http(http) => Ok(http.url.clone()),
        ServerConfig::Stdio(_) => Err("MCP_OAUTH_HTTP_REQUIRED"),
    }
}

pub(super) fn clear_oauth(path: &Path, id: &str) -> Result<()> {
    let mut store = read(path)?;
    let server = store
        .servers
        .iter_mut()
        .find(|s| s.config.server_id() == id)
        .ok_or("MCP_SERVER_MISSING")?;
    if !matches!(&server.config, ServerConfig::Http(_)) {
        return Err("MCP_OAUTH_HTTP_REQUIRED");
    }
    server.oauth = None;
    let mut runtime = RUNTIME.lock().map_err(|_| "MCP_STATE_ERROR")?;
    write(path, &store)?;
    revoke_server(&mut runtime, id);
    Ok(())
}

fn views(store: Store) -> Result<Vec<ServerView>> {
    let runtime = RUNTIME.lock().map_err(|_| "MCP_STATE_ERROR")?;
    Ok(store
        .servers
        .into_iter()
        .map(|s| {
            let session = runtime
                .sessions
                .values()
                .find(|c| c.server_id == s.config.server_id() && !c.cancel.is_cancelled());
            let status = match session {
                None => "disconnected",
                Some(c) => match c.client.lock() {
                    Ok(client) => match client.as_ref() {
                        Some(client) if !client.is_closed() => "connected",
                        Some(_) => "disconnected",
                        None => "connecting",
                    },
                    Err(_) => "disconnected",
                },
            };
            ServerView {
                authorization_status: if !matches!(&s.config, ServerConfig::Http(_)) {
                    "notRequired"
                } else if runtime
                    .authorizations
                    .values()
                    .any(|op| op.server_id == s.config.server_id())
                {
                    "authorizing"
                } else if s.oauth.is_some() {
                    "authorized"
                } else {
                    "required"
                },
                authorization_error: runtime
                    .authorization_errors
                    .get(s.config.server_id())
                    .copied(),
                config: s.config,
                name: s.name,
                enabled: s.enabled,
                env_names: s.env.into_keys().collect(),
                connection_id: session.map(|c| c.id.clone()),
                status,
            }
        })
        .collect())
}

fn validate_update(update: &SaveServer) -> Result<()> {
    update.config.validate()?;
    if matches!(update.config, ServerConfig::Http(_)) && !update.env_changes.is_empty() {
        return Err("MCP_CONFIG_INVALID");
    }
    if update.name.trim().is_empty()
        || update.name.len() > 160
        || update.env_changes.len() > 32
        || update.env_changes.iter().any(|(name, value)| {
            !valid_env_name(name)
                || value
                    .as_ref()
                    .is_some_and(|v| v.len() > 8192 || v.contains('\0'))
        })
    {
        return Err("MCP_CONFIG_INVALID");
    }
    // Windows treats environment names case-insensitively; reject ambiguous patches.
    let mut names = HashSet::new();
    if update
        .env_changes
        .keys()
        .any(|n| !names.insert(n.to_ascii_uppercase()))
    {
        return Err("MCP_ENV_DUPLICATE");
    }
    Ok(())
}

fn save(path: &Path, mut update: SaveServer) -> Result<()> {
    validate_update(&update)?;
    if let ServerConfig::Http(c) = &mut update.config {
        c.url = http::endpoint(&c.url)?.to_string();
    }
    let mut store = read(path)?;
    let old = store
        .servers
        .iter()
        .position(|s| s.config.server_id() == update.config.server_id());
    if old.is_some_and(|i| {
        std::mem::discriminant(&store.servers[i].config) != std::mem::discriminant(&update.config)
    }) {
        return Err("MCP_TRANSPORT_CHANGE_UNSUPPORTED");
    }
    let mut server = old
        .map(|i| store.servers[i].clone())
        .unwrap_or(SavedServer {
            config: update.config.clone(),
            name: update.name.clone(),
            enabled: false,
            env: BTreeMap::new(),
            oauth: None,
        });
    if server.config != update.config {
        server.oauth = None;
    }
    server.config = update.config;
    server.name = update.name;
    for (name, value) in update.env_changes {
        server.env.retain(|key, _| !key.eq_ignore_ascii_case(&name));
        if let Some(value) = value {
            server.env.insert(
                name,
                crate::secret_protection::protect_secret(&value)
                    .map_err(|_| "MCP_SECRET_PROTECT_FAILED")?,
            );
        }
    }
    let id = server.config.server_id().to_owned();
    if let Some(i) = old {
        store.servers[i] = server;
    } else {
        store.servers.push(server);
    }
    // Lock runtime across the commit: a successful write and revocation are one boundary.
    let mut runtime = RUNTIME.lock().map_err(|_| "MCP_STATE_ERROR")?;
    write(path, &store)?;
    revoke_server(&mut runtime, &id);
    Ok(())
}

fn change(path: &Path, id: &str, enabled: Option<bool>) -> Result<()> {
    let mut store = read(path)?;
    let i = store
        .servers
        .iter()
        .position(|s| s.config.server_id() == id)
        .ok_or("MCP_SERVER_MISSING")?;
    if let Some(enabled) = enabled {
        store.servers[i].enabled = enabled;
        if !enabled {
            store.servers[i].oauth = None;
        }
    } else {
        store.servers.remove(i);
    }
    let mut runtime = RUNTIME.lock().map_err(|_| "MCP_STATE_ERROR")?;
    write(path, &store)?;
    revoke_server(&mut runtime, id);
    Ok(())
}

/// Called under CONFIG_LOCK; reservation is made before releasing the lock.
pub(super) fn reserve_http(path: &Path, request_id: &str, url: &str) -> Result<Arc<Session>> {
    let store = read(path)?;
    let mut runtime = RUNTIME.lock().map_err(|_| "MCP_STATE_ERROR")?;
    loop {
        let id = new_id("http");
        if !runtime.configs.contains_key(&id)
            && !store.servers.iter().any(|s| s.config.server_id() == id)
        {
            return reserve_session(&mut runtime, &id, request_id, url);
        }
    }
}

/// Called under CONFIG_LOCK; reservation is made before releasing the lock.
pub(super) fn connection(
    path: &Path,
    id: &str,
    request_id: &str,
) -> Result<(
    Arc<Session>,
    ServerConfig,
    BTreeMap<String, String>,
    Option<Vec<u8>>,
)> {
    let store = read(path)?;
    let saved = store
        .servers
        .into_iter()
        .find(|s| s.config.server_id() == id);
    let (config, env, oauth) = if let Some(saved) = saved {
        if !saved.enabled {
            return Err("MCP_SERVER_DISABLED");
        }
        let mut env = BTreeMap::new();
        for (name, value) in saved.env {
            env.insert(
                name,
                crate::secret_protection::unprotect_secret(&value)
                    .map_err(|_| "MCP_SECRET_UNPROTECT_FAILED")?,
            );
        }
        let oauth = saved
            .oauth
            .map(|bytes| {
                crate::secret_protection::unprotect_secret(&bytes)
                    .map(String::into_bytes)
                    .map_err(|_| "MCP_OAUTH_STORE_READ_FAILED")
            })
            .transpose()?;
        (saved.config, env, oauth)
    } else {
        let config = RUNTIME
            .lock()
            .map_err(|_| "MCP_STATE_ERROR")?
            .configs
            .get(id)
            .cloned()
            .ok_or("MCP_SERVER_MISSING")?;
        (ServerConfig::Stdio(config), BTreeMap::new(), None)
    };
    config.validate()?;
    // Persistent entries are authoritative over legacy session registration.
    let session = match &config {
        ServerConfig::Stdio(stdio) => {
            let mut runtime = RUNTIME.lock().map_err(|_| "MCP_STATE_ERROR")?;
            if !runtime.configs.contains_key(id) && runtime.configs.len() >= 8 {
                return Err("MCP_SERVER_LIMIT");
            }
            runtime.configs.insert(id.to_owned(), stdio.clone());
            drop(runtime);
            reserve(stdio, request_id)?
        }
        ServerConfig::Http(http) => {
            let mut runtime = RUNTIME.lock().map_err(|_| "MCP_STATE_ERROR")?;
            reserve_session(&mut runtime, id, request_id, &http.url)?
        }
    };
    Ok((session, config, env, oauth))
}

#[tauri::command]
pub async fn mcp_list_servers(app: tauri::AppHandle) -> Result<Vec<ServerView>> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = CONFIG_LOCK.lock().map_err(|_| "MCP_STATE_ERROR")?;
        views(read(&path(&app)?)?)
    })
    .await
    .map_err(|_| "MCP_CONFIG_READ_FAILED")?
}

#[tauri::command]
pub async fn mcp_save_server(app: tauri::AppHandle, update: SaveServer) -> Result<()> {
    // Validate before asking; never include environment values in the prompt.
    let source = app.clone();
    let (update, path, expected) = tauri::async_runtime::spawn_blocking(move || {
        let mut update = update;
        validate_update(&update)?;
        if let ServerConfig::Http(c) = &mut update.config {
            c.url = http::endpoint(&c.url)?.to_string();
        }
        let _guard = CONFIG_LOCK.lock().map_err(|_| "MCP_STATE_ERROR")?;
        let path = path(&source)?;
        let expected = read(&path)?;
        Ok::<_, &'static str>((update, path, expected))
    })
    .await
    .map_err(|_| "MCP_CONFIG_INVALID")??;
    let details = update.config.target_details(
        &update
            .env_changes
            .keys()
            .cloned()
            .collect::<Vec<_>>()
            .join(", "),
    )?;
    confirm(&app, format!("保存配置（本次不连接）？\n\n{details}\n\n新服务默认禁用；保存和启用不会连接或启动进程。stdio 凭据仅使用加密环境变量，勿填入参数；HTTP 暂不支持鉴权。"), &CancellationToken::new()).await?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = CONFIG_LOCK.lock().map_err(|_| "MCP_STATE_ERROR")?;
        if read(&path)? != expected {
            return Err("MCP_CONFIG_CHANGED");
        }
        save(&path, update)
    })
    .await
    .map_err(|_| "MCP_CONFIG_WRITE_FAILED")?
}

#[tauri::command]
pub async fn mcp_set_server_enabled(
    app: tauri::AppHandle,
    server_id: String,
    enabled: bool,
) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = CONFIG_LOCK.lock().map_err(|_| "MCP_STATE_ERROR")?;
        change(&path(&app)?, &server_id, Some(enabled))
    })
    .await
    .map_err(|_| "MCP_CONFIG_WRITE_FAILED")?
}

#[tauri::command]
pub async fn mcp_delete_server(app: tauri::AppHandle, server_id: String) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = CONFIG_LOCK.lock().map_err(|_| "MCP_STATE_ERROR")?;
        change(&path(&app)?, &server_id, None)
    })
    .await
    .map_err(|_| "MCP_CONFIG_WRITE_FAILED")?
}
