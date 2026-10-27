//! Product OAuth flow and target-bound, DPAPI-protected credentials.
use super::*;
use rmcp::transport::auth::{
    AuthError, AuthorizationManager, AuthorizationMetadata, AuthorizationRequest,
    AuthorizationSession, CredentialStore, StateStore, StoredAuthorizationState, StoredCredentials,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri_plugin_shell::ShellExt;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

const AUTH_TTL: Duration = Duration::from_secs(300);
const CALLBACK_MAX_REQUESTS: usize = 8;
const CALLBACK_MAX_HEADER: usize = 16 * 1024;

type AuthResult<T> = std::result::Result<T, &'static str>;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct OAuthBundle {
    server_id: String,
    resource_url: String,
    issuer: String,
    metadata: AuthorizationMetadata,
    credentials: StoredCredentials,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizationStatus {
    server_id: String,
    status: &'static str,
}

#[derive(Clone, Default)]
struct FlowStateStore(Arc<tokio::sync::RwLock<HashMap<String, StoredAuthorizationState>>>);

#[async_trait::async_trait]
impl StateStore for FlowStateStore {
    async fn save(
        &self,
        state: &str,
        value: StoredAuthorizationState,
    ) -> std::result::Result<(), AuthError> {
        self.0.write().await.insert(state.to_owned(), value);
        Ok(())
    }
    async fn load(
        &self,
        state: &str,
    ) -> std::result::Result<Option<StoredAuthorizationState>, AuthError> {
        Ok(self.0.read().await.get(state).cloned())
    }
    async fn delete(&self, state: &str) -> std::result::Result<(), AuthError> {
        self.0.write().await.remove(state);
        Ok(())
    }
}

#[derive(Clone)]
struct DpapiCredentialStore {
    app: tauri::AppHandle,
    server_id: String,
    resource_url: String,
    issuer: String,
    metadata: AuthorizationMetadata,
    cancel: CancellationToken,
}

#[async_trait::async_trait]
impl CredentialStore for DpapiCredentialStore {
    async fn load(&self) -> std::result::Result<Option<StoredCredentials>, AuthError> {
        let path = config::path(&self.app).map_err(store_error)?;
        let id = self.server_id.clone();
        let resource = self.resource_url.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let _guard = config::CONFIG_LOCK.lock().map_err(|_| "MCP_STATE_ERROR")?;
            config::load_oauth_bytes(&path, &id, &resource)
        })
        .await
        .map_err(|_| store_error("MCP_OAUTH_STORE_READ_FAILED"))?
        .map_err(store_error)?
        .map(|bytes| {
            let bundle: OAuthBundle = serde_json::from_slice(&bytes)
                .map_err(|_| store_error("MCP_OAUTH_STORE_READ_FAILED"))?;
            if bundle.server_id != self.server_id
                || bundle.resource_url != self.resource_url
                || bundle.issuer != self.issuer
                || bundle.metadata.issuer.as_deref() != Some(self.issuer.as_str())
                || bundle.credentials.issuer.as_deref() != Some(self.issuer.as_str())
            {
                return Err(store_error("MCP_OAUTH_TARGET_MISMATCH"));
            }
            Ok(bundle.credentials)
        })
        .transpose()
    }

    async fn save(&self, credentials: StoredCredentials) -> std::result::Result<(), AuthError> {
        if self.cancel.is_cancelled() {
            return Err(store_error("MCP_CANCELLED"));
        }
        if credentials.issuer.as_deref() != Some(self.issuer.as_str())
            || credentials.token_response.is_none()
            || credentials.client_id.is_empty()
        {
            return Err(store_error("MCP_OAUTH_CREDENTIALS_INVALID"));
        }
        let bundle = OAuthBundle {
            server_id: self.server_id.clone(),
            resource_url: self.resource_url.clone(),
            issuer: self.issuer.clone(),
            metadata: self.metadata.clone(),
            credentials,
        };
        let bytes =
            serde_json::to_vec(&bundle).map_err(|_| store_error("MCP_OAUTH_STORE_WRITE_FAILED"))?;
        let path = config::path(&self.app).map_err(store_error)?;
        let id = self.server_id.clone();
        let resource = self.resource_url.clone();
        let cancel = self.cancel.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let _guard = config::CONFIG_LOCK.lock().map_err(|_| "MCP_STATE_ERROR")?;
            config::save_oauth_bytes(&path, &id, &resource, &bytes, &cancel)
        })
        .await
        .map_err(|_| store_error("MCP_OAUTH_STORE_WRITE_FAILED"))?
        .map_err(store_error)
    }

    async fn clear(&self) -> std::result::Result<(), AuthError> {
        let path = config::path(&self.app).map_err(store_error)?;
        let id = self.server_id.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let _guard = config::CONFIG_LOCK.lock().map_err(|_| "MCP_STATE_ERROR")?;
            config::clear_oauth(&path, &id)
        })
        .await
        .map_err(|_| store_error("MCP_OAUTH_STORE_WRITE_FAILED"))?
        .map_err(store_error)
    }
}

fn store_error(code: &'static str) -> AuthError {
    AuthError::CredentialStoreError(code.to_owned())
}

pub(super) async fn manager_for_connection(
    app: &tauri::AppHandle,
    server_id: &str,
    config: &config::ServerConfig,
    cancel: &CancellationToken,
    encrypted_bytes: &[u8],
) -> AuthResult<Arc<AuthorizationManager>> {
    let resource_url = config.http_url().ok_or("MCP_OAUTH_HTTP_REQUIRED")?;
    let bundle: OAuthBundle =
        serde_json::from_slice(encrypted_bytes).map_err(|_| "MCP_OAUTH_STORE_READ_FAILED")?;
    if bundle.server_id != server_id
        || bundle.resource_url != resource_url
        || bundle.issuer.is_empty()
        || bundle.issuer.len() > 2048
    {
        return Err("MCP_OAUTH_TARGET_MISMATCH");
    }
    let client = Arc::new(oauth_http::ControlledOAuthClient::new(
        app.clone(),
        cancel.clone(),
    ));
    let mut manager = oauth_http::quiet(AuthorizationManager::new_with_oauth_http_client(
        &bundle.resource_url,
        client,
    ))
    .await
    .map_err(|_| "MCP_OAUTH_CLIENT_FAILED")?;
    let resolution = oauth_http::quiet(manager.resolve_metadata())
        .await
        .map_err(|_| "MCP_OAUTH_DISCOVERY_FAILED")?;
    if resolution.metadata.issuer != bundle.metadata.issuer
        || resolution.metadata.authorization_endpoint != bundle.metadata.authorization_endpoint
        || resolution.metadata.token_endpoint != bundle.metadata.token_endpoint
    {
        return Err("MCP_OAUTH_METADATA_CHANGED");
    }
    manager.set_metadata(bundle.metadata.clone());
    manager.set_credential_store(DpapiCredentialStore {
        app: app.clone(),
        server_id: server_id.to_owned(),
        resource_url: bundle.resource_url,
        issuer: bundle.issuer,
        metadata: bundle.metadata,
        cancel: cancel.clone(),
    });
    let loaded = oauth_http::quiet(manager.initialize_from_store())
        .await
        .map_err(|_| "MCP_OAUTH_STORE_READ_FAILED")?;
    if !loaded {
        return Err("MCP_OAUTH_AUTHORIZATION_REQUIRED");
    }
    Ok(Arc::new(manager))
}

struct Callback {
    code: String,
    state: String,
    issuer: Option<String>,
    is_error: bool,
}

async fn accept_callback(
    listener: TcpListener,
    route: String,
    state_store: FlowStateStore,
    expected_issuer: String,
    cancel: CancellationToken,
) -> AuthResult<Callback> {
    let deadline = tokio::time::Instant::now() + AUTH_TTL;
    let expected_host = format!(
        "127.0.0.1:{}",
        listener
            .local_addr()
            .map_err(|_| "MCP_OAUTH_CALLBACK_FAILED")?
            .port()
    );
    for _ in 0..CALLBACK_MAX_REQUESTS {
        let accepted = tokio::select! {
            _ = cancel.cancelled() => return Err("MCP_CANCELLED"),
            result = tokio::time::timeout_at(deadline, listener.accept()) => result.map_err(|_| "MCP_OAUTH_CALLBACK_TIMEOUT")?.map_err(|_| "MCP_OAUTH_CALLBACK_FAILED")?,
        };
        let (mut stream, peer) = accepted;
        if !peer.ip().is_loopback() {
            write_callback(&mut stream, 400).await;
            continue;
        }
        let callback = tokio::select! {
            _ = cancel.cancelled() => return Err("MCP_CANCELLED"),
            result = tokio::time::timeout_at(deadline, read_callback(&mut stream, &route, &expected_host)) => result.map_err(|_| "MCP_OAUTH_CALLBACK_TIMEOUT")?,
        };
        match callback {
            Ok(callback) => {
                let state = match state_store.load(&callback.state).await {
                    Ok(Some(state)) => state,
                    _ => {
                        write_callback(&mut stream, 400).await;
                        return Err("MCP_OAUTH_CALLBACK_INVALID");
                    }
                };
                let age = oauth_epoch().saturating_sub(state.created_at);
                if age > AUTH_TTL.as_secs()
                    || state.csrf_token != callback.state
                    || state.expected_issuer.as_deref().unwrap_or(&expected_issuer)
                        != expected_issuer
                    || callback.issuer.as_deref() != Some(expected_issuer.as_str())
                {
                    write_callback(&mut stream, 400).await;
                    return Err("MCP_OAUTH_CALLBACK_INVALID");
                }
                if callback.is_error {
                    let _ = state_store.delete(&callback.state).await;
                    write_callback(&mut stream, 200).await;
                    return Err("MCP_OAUTH_PROVIDER_ERROR");
                }
                write_callback(&mut stream, 200).await;
                return Ok(callback);
            }
            Err(_) => write_callback(&mut stream, 400).await,
        }
    }
    Err("MCP_OAUTH_CALLBACK_LIMIT")
}

async fn read_callback(
    stream: &mut TcpStream,
    route: &str,
    expected_host: &str,
) -> AuthResult<Callback> {
    let mut bytes = vec![0; CALLBACK_MAX_HEADER + 1];
    let mut used = 0;
    while used < CALLBACK_MAX_HEADER {
        let count = stream
            .read(&mut bytes[used..])
            .await
            .map_err(|_| "MCP_OAUTH_CALLBACK_INVALID")?;
        if count == 0 {
            return Err("MCP_OAUTH_CALLBACK_INVALID");
        }
        used += count;
        if bytes[..used].windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
    }
    if used > CALLBACK_MAX_HEADER {
        return Err("MCP_OAUTH_CALLBACK_INVALID");
    }
    let text = std::str::from_utf8(&bytes[..used]).map_err(|_| "MCP_OAUTH_CALLBACK_INVALID")?;
    let (head, rest) = text
        .split_once("\r\n\r\n")
        .ok_or("MCP_OAUTH_CALLBACK_INVALID")?;
    if !rest.is_empty() {
        return Err("MCP_OAUTH_CALLBACK_INVALID");
    }
    let mut lines = head.split("\r\n");
    let request = lines.next().ok_or("MCP_OAUTH_CALLBACK_INVALID")?;
    let request_parts: Vec<_> = request.split(' ').collect();
    if request_parts.len() != 3 || request_parts[0] != "GET" || request_parts[2] != "HTTP/1.1" {
        return Err("MCP_OAUTH_CALLBACK_INVALID");
    }
    let request_target = request_parts[1];
    if !request_target.starts_with(&format!("{route}?")) {
        return Err("MCP_OAUTH_CALLBACK_INVALID");
    }
    let mut host = None;
    for line in lines {
        let (name, value) = line.split_once(':').ok_or("MCP_OAUTH_CALLBACK_INVALID")?;
        if name.eq_ignore_ascii_case("host") {
            if host.replace(value.trim()).is_some() {
                return Err("MCP_OAUTH_CALLBACK_INVALID");
            }
        } else if name.eq_ignore_ascii_case("content-length")
            || name.eq_ignore_ascii_case("transfer-encoding")
        {
            return Err("MCP_OAUTH_CALLBACK_INVALID");
        }
    }
    if host != Some(expected_host) {
        return Err("MCP_OAUTH_CALLBACK_INVALID");
    }
    let mut values = HashMap::new();
    for (key, value) in url::form_urlencoded::parse(request_target[route.len() + 1..].as_bytes()) {
        if !matches!(
            key.as_ref(),
            "code" | "state" | "iss" | "error" | "error_description" | "error_uri"
        ) || values
            .insert(key.into_owned(), value.into_owned())
            .is_some()
        {
            return Err("MCP_OAUTH_CALLBACK_INVALID");
        }
    }
    let state = values.remove("state").ok_or("MCP_OAUTH_CALLBACK_INVALID")?;
    if state.is_empty() || state.len() > 512 {
        return Err("MCP_OAUTH_CALLBACK_INVALID");
    }
    let issuer = values.remove("iss");
    if values.contains_key("error") {
        if values.contains_key("code") {
            return Err("MCP_OAUTH_CALLBACK_INVALID");
        }
        return Ok(Callback {
            code: String::new(),
            state,
            issuer,
            is_error: true,
        });
    }
    let code = values.remove("code").ok_or("MCP_OAUTH_CALLBACK_INVALID")?;
    if code.is_empty() || code.len() > 4096 {
        return Err("MCP_OAUTH_CALLBACK_INVALID");
    }
    Ok(Callback {
        code,
        state,
        issuer,
        is_error: false,
    })
}

// The callback response never reflects request data or provider error strings.
async fn write_callback(stream: &mut TcpStream, status: u16) {
    let (reason, body) = if status == 200 {
        ("OK", "授权流程已返回观墨。可以关闭此页面。")
    } else {
        ("Bad Request", "授权回调无效，请回到观墨重试。")
    };
    let response = format!("HTTP/1.1 {status} {reason}\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}", body.len());
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

#[tauri::command]
pub async fn mcp_authorize(
    app: tauri::AppHandle,
    server_id: String,
    request_id: String,
) -> AuthResult<AuthorizationStatus> {
    if request_id.is_empty() || request_id.len() > 128 {
        return Err("MCP_REQUEST_ID_INVALID");
    }
    let app_cfg = app.clone();
    let id = server_id.clone();
    let req = request_id.clone();
    let (target, cancel) = tauri::async_runtime::spawn_blocking(move || {
        let _config = config::CONFIG_LOCK.lock().map_err(|_| "MCP_STATE_ERROR")?;
        let path = config::path(&app_cfg)?;
        let target = config::authorization_target(&path, &id)?;
        let mut runtime = RUNTIME.lock().map_err(|_| "MCP_STATE_ERROR")?;
        if runtime.authorizations.values().any(|op| op.server_id == id) {
            return Err("MCP_OAUTH_BUSY");
        }
        if runtime
            .authorizations
            .values()
            .any(|op| op.request_id == req)
        {
            return Err("MCP_REQUEST_ID_USED");
        }
        let cancel = CancellationToken::new();
        runtime.authorization_errors.remove(&id);
        runtime.authorizations.insert(
            id.clone(),
            AuthorizationOperation {
                server_id: id,
                request_id: req,
                cancel: cancel.clone(),
            },
        );
        Ok::<_, &'static str>((target, cancel))
    })
    .await
    .map_err(|_| "MCP_OAUTH_START_FAILED")??;
    let app_task = app.clone();
    let id_task = server_id.clone();
    let req_task = request_id.clone();
    tauri::async_runtime::spawn(async move {
        let result = run_flow(
            app_task.clone(),
            id_task.clone(),
            target,
            req_task.clone(),
            cancel.clone(),
        )
        .await;
        if result.is_err() {
            cancel.cancel();
        }
        if let Ok(mut runtime) = RUNTIME.lock() {
            if runtime
                .authorizations
                .get(&id_task)
                .is_some_and(|op| op.request_id == req_task)
            {
                runtime.authorizations.remove(&id_task);
                match result {
                    Err("MCP_CANCELLED") | Ok(()) => {
                        runtime.authorization_errors.remove(&id_task);
                    }
                    Err(error) => {
                        runtime.authorization_errors.insert(id_task, error);
                    }
                }
            }
        }
    });
    Ok(AuthorizationStatus {
        server_id,
        status: "pending",
    })
}

async fn run_flow(
    app: tauri::AppHandle,
    server_id: String,
    target: String,
    request_id: String,
    cancel: CancellationToken,
) -> AuthResult<()> {
    tokio::time::timeout(
        AUTH_TTL,
        run_flow_inner(app, server_id, target, request_id, cancel),
    )
    .await
    .map_err(|_| "MCP_OAUTH_TIMEOUT")?
}

async fn run_flow_inner(
    app: tauri::AppHandle,
    server_id: String,
    target: String,
    request_id: String,
    cancel: CancellationToken,
) -> AuthResult<()> {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|_| "MCP_OAUTH_CALLBACK_BIND_FAILED")?;
    let address = listener
        .local_addr()
        .map_err(|_| "MCP_OAUTH_CALLBACK_BIND_FAILED")?;
    let route = format!(
        "/oauth/callback/{}",
        oauth2::CsrfToken::new_random().secret()
    );
    let redirect_uri = format!("http://127.0.0.1:{}{}", address.port(), route);
    let client = Arc::new(oauth_http::ControlledOAuthClient::new(
        app.clone(),
        cancel.clone(),
    ));
    let mut manager = oauth_http::quiet(AuthorizationManager::new_with_oauth_http_client(
        &target, client,
    ))
    .await
    .map_err(|_| "MCP_OAUTH_DISCOVERY_FAILED")?;
    manager.set_allow_missing_issuer(false);
    let resolution = oauth_http::quiet(manager.resolve_metadata())
        .await
        .map_err(|_| "MCP_OAUTH_DISCOVERY_FAILED")?;
    let metadata = resolution.metadata;
    let issuer = metadata
        .issuer
        .clone()
        .filter(|value| !value.is_empty())
        .ok_or("MCP_OAUTH_ISSUER_REQUIRED")?;
    manager.set_metadata(metadata.clone());
    let state_store = FlowStateStore::default();
    manager.set_state_store(state_store.clone());
    manager.set_credential_store(DpapiCredentialStore {
        app: app.clone(),
        server_id: server_id.clone(),
        resource_url: target.clone(),
        issuer: issuer.clone(),
        metadata: metadata.clone(),
        cancel: cancel.clone(),
    });
    let request = AuthorizationRequest::new(&redirect_uri).with_client_name("观墨 MCP Client");
    let session = oauth_http::quiet(AuthorizationSession::new(manager, request))
        .await
        .map_err(|_| "MCP_OAUTH_REGISTRATION_FAILED")?;
    let auth_url = url::Url::parse(session.get_authorization_url())
        .map_err(|_| "MCP_OAUTH_AUTH_URL_INVALID")?;
    let local_http = auth_url.host_str().is_some_and(|host| {
        host.eq_ignore_ascii_case("localhost")
            || host
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    });
    if !(auth_url.scheme() == "https" || (auth_url.scheme() == "http" && local_http))
        || auth_url.host_str().is_none()
        || !auth_url.username().is_empty()
        || auth_url.password().is_some()
    {
        return Err("MCP_OAUTH_AUTH_URL_INVALID");
    }
    confirm(&app, format!("将在系统浏览器打开 MCP OAuth 授权页面。\n\n授权服务器：{}\n资源服务：{}\n回调仅监听本机随机端口。", auth_url.host_str().unwrap_or(""), target), &cancel).await?;
    #[allow(deprecated)]
    app.shell()
        .open(auth_url.as_str(), None)
        .map_err(|_| "MCP_OAUTH_BROWSER_OPEN_FAILED")?;
    let callback = accept_callback(listener, route, state_store, issuer.clone(), cancel).await?;
    oauth_http::quiet(session.handle_callback_with_issuer(
        &callback.code,
        &callback.state,
        callback.issuer.as_deref(),
    ))
    .await
    .map_err(|_| "MCP_OAUTH_EXCHANGE_FAILED")?;
    let _ = request_id;
    Ok(())
}

#[tauri::command]
pub fn mcp_cancel_authorize(server_id: String) -> AuthResult<()> {
    let runtime = RUNTIME.lock().map_err(|_| "MCP_STATE_ERROR")?;
    let operation = runtime
        .authorizations
        .get(&server_id)
        .ok_or("MCP_OAUTH_REQUEST_MISSING")?;
    operation.cancel.cancel();
    Ok(())
}

#[tauri::command]
pub async fn mcp_revoke_authorization(app: tauri::AppHandle, server_id: String) -> AuthResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let _config = config::CONFIG_LOCK.lock().map_err(|_| "MCP_STATE_ERROR")?;
        config::clear_oauth(&config::path(&app)?, &server_id)
    })
    .await
    .map_err(|_| "MCP_CONFIG_WRITE_FAILED")?
}

pub(super) fn oauth_epoch() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
#[path = "oauth_tests.rs"]
mod tests;
