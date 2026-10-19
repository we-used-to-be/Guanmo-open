use futures_util::StreamExt;
use reqwest::{
    header::{HeaderMap, HeaderName, HeaderValue},
    redirect::Policy,
    Client, Method, Response,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
    str::FromStr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{ipc::Channel, AppHandle, Manager, State};
use tokio::{
    net::lookup_host,
    sync::{Mutex as AsyncMutex, Semaphore},
};
use tokio_util::sync::CancellationToken;
use url::{Host, Url};

const API_ORIGIN_GRANTS_FILE: &str = "api-origin-grants.json";
const MAX_REQUEST_BODY_BYTES: usize = 2 * 1024 * 1024;
const MAX_RESPONSE_BODY_BYTES: usize = 16 * 1024 * 1024;
const MAX_TIMEOUT_MS: u64 = 120_000;
const DEFAULT_TIMEOUT_MS: u64 = 60_000;
const MAX_CONCURRENT_REQUESTS: usize = 8;
const STREAM_BATCH_BYTES: usize = 64 * 1024;
const STREAM_ACK_WINDOW: usize = 4;
const UPDATE_RELEASES_URL: &str =
    "https://api.github.com/repos/we-used-to-be/Guanmo-open/releases/";

const BUILTIN_ORIGINS: &[&str] = &[
    "https://api.openai.com:443",
    "https://api.deepseek.com:443",
    "https://open.bigmodel.cn:443",
    "https://api.moonshot.cn:443",
    "https://api.xiaomimimo.com:443",
    "https://api.siliconflow.cn:443",
    "https://api.groq.com:443",
    "https://openrouter.ai:443",
    "http://localhost:11434",
    "https://ark.cn-beijing.volces.com:443",
    "https://coding.dashscope.aliyuncs.com:443",
    "https://maas-coding-api.cn-huabei-1.xf-yun.com:443",
    "https://api.lkeap.cloud.tencent.com:443",
    "https://api.anthropic.com:443",
    "https://api.tavily.com:443",
    "https://google.serper.dev:443",
    "https://api.search.brave.com:443",
    "https://api.github.com:443",
];

pub struct ApiOriginState {
    session: Mutex<HashSet<String>>,
    permanent: Mutex<HashSet<String>>,
    loaded: AtomicBool,
    load_lock: AsyncMutex<()>,
    concurrency: Semaphore,
    cancellations: Mutex<HashMap<String, CancellationToken>>,
    stream_acks: Mutex<HashMap<String, Arc<Semaphore>>>,
    usage: Mutex<crate::api_http_limits::ApiUsage>,
}

impl Default for ApiOriginState {
    fn default() -> Self {
        Self {
            session: Mutex::new(HashSet::new()),
            permanent: Mutex::new(HashSet::new()),
            loaded: AtomicBool::new(false),
            load_lock: AsyncMutex::new(()),
            concurrency: Semaphore::new(MAX_CONCURRENT_REQUESTS),
            cancellations: Mutex::new(HashMap::new()),
            stream_acks: Mutex::new(HashMap::new()),
            usage: Mutex::new(crate::api_http_limits::ApiUsage::default()),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiHttpError {
    code: &'static str,
    message: String,
    origin: Option<String>,
}

impl ApiHttpError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            origin: None,
        }
    }

    fn unauthorized(origin: String) -> Self {
        Self {
            code: "ORIGIN_NOT_AUTHORIZED",
            message: format!("API 地址尚未授权：{origin}"),
            origin: Some(origin),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalHttpRequest {
    request_id: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    method: String,
    #[serde(default)]
    headers: Vec<(String, String)>,
    body: Option<Vec<u8>>,
    timeout_ms: Option<u64>,
    api: Option<BoundApiRequest>,
    #[serde(skip)]
    response_secret: String,
}

fn validate_update_request(request: &ExternalHttpRequest) -> Result<(), ApiHttpError> {
    let allowed_path = request
        .url
        .strip_prefix(UPDATE_RELEASES_URL)
        .is_some_and(|path| {
            path == "latest"
                || path.strip_prefix("tags/v").is_some_and(|tag| {
                    let tag = tag.replace("%2B", "+");
                    !tag.is_empty()
                        && tag.len() <= 128
                        && tag
                            .bytes()
                            .all(|c| c.is_ascii_alphanumeric() || b".-+_".contains(&c))
                })
        });
    if !allowed_path
        || !matches!(request.method.as_str(), "GET" | "get")
        || request.body.is_some()
        || request.headers.iter().any(|(name, _)| {
            !matches!(
                name.to_ascii_lowercase().as_str(),
                "accept" | "user-agent" | "x-github-api-version" | "if-none-match"
            )
        })
    {
        return Err(ApiHttpError::new(
            "OPERATION_NOT_ALLOWED",
            "无鉴权代理仅允许本应用更新查询",
        ));
    }
    Ok(())
}

fn usage_error(code: &'static str) -> ApiHttpError {
    ApiHttpError::new(
        code,
        if code == "RATE_LIMIT_EXCEEDED" {
            "API 请求过于频繁，请稍后重试（每配置120次/分钟，全应用240次/分钟）"
        } else {
            "本次应用会话已达到 API 使用上限（10000次请求或512 MiB响应），请求已停止"
        },
    )
}

fn admit_request(
    state: &ApiOriginState,
    request: &ExternalHttpRequest,
) -> Result<(), ApiHttpError> {
    let origin = normalize_origin(&request.url)?;
    if !is_authorized(state, &origin)? {
        return Err(ApiHttpError::unauthorized(origin));
    }
    if request.body.as_ref().map_or(0, Vec::len) > MAX_REQUEST_BODY_BYTES {
        return Err(ApiHttpError::new(
            "REQUEST_BODY_TOO_LARGE",
            "请求体超过 2 MiB 限制",
        ));
    }
    let configuration = request
        .api
        .as_ref()
        .map(|api| api.config_id.as_str())
        .unwrap_or("update");
    state
        .usage
        .lock()
        .map_err(|_| ApiHttpError::new("USAGE_STATE_UNAVAILABLE", "API 使用计数不可用"))?
        .admit(configuration, Instant::now())
        .map_err(usage_error)
}

fn count_response(state: &ApiOriginState, bytes: usize) -> Result<(), ApiHttpError> {
    state
        .usage
        .lock()
        .map_err(|_| ApiHttpError::new("USAGE_STATE_UNAVAILABLE", "API 使用计数不可用"))?
        .receive(bytes)
        .map_err(usage_error)
}

fn request_timeout(request: &ExternalHttpRequest) -> Duration {
    Duration::from_millis(
        request
            .timeout_ms
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .clamp(1, MAX_TIMEOUT_MS),
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BoundApiRequest {
    config_id: String,
    operation: String,
    query: Option<String>,
    count: Option<u32>,
}

type BoundApiTarget = (String, String, Vec<(String, String)>);

fn bound_target(
    record: &crate::api_credentials::StoredConnection,
    api: &BoundApiRequest,
) -> Result<BoundApiTarget, ApiHttpError> {
    let connection = &record.connection;
    connection
        .clone()
        .normalize()
        .map_err(|_| ApiHttpError::new("INVALID_URL", "API 配置地址无效"))?;
    let (method, suffix) = match (
        connection.kind.as_str(),
        connection.protocol.as_str(),
        api.operation.as_str(),
    ) {
        ("chat", "openai-chat", "chat") => ("POST", "/chat/completions"),
        ("chat", "openai-chat", "models") | ("embedding", "openai-embedding", "models") => {
            ("GET", "/models")
        }
        ("embedding", "openai-embedding", "embedding") => ("POST", "/embeddings"),
        ("search", "tavily" | "serper", "search") => ("POST", ""),
        ("search", "brave" | "custom", "search") => ("GET", ""),
        _ => {
            return Err(ApiHttpError::new(
                "OPERATION_NOT_ALLOWED",
                "API 操作与配置不匹配",
            ))
        }
    };
    let mut url = Url::parse(&format!("{}{suffix}", connection.base_url))
        .map_err(|_| ApiHttpError::new("INVALID_URL", "API 配置地址无效"))?;
    if method == "GET" && api.operation == "search" {
        if api
            .query
            .as_ref()
            .is_none_or(|query| query.trim().is_empty() || query.len() > 8192)
            || api.count.is_some_and(|count| count == 0 || count > 100)
        {
            return Err(ApiHttpError::new(
                "INVALID_REQUEST",
                "搜索参数无效（查询最多8192字节，结果1至100条）",
            ));
        }
        let existing: Vec<(String, String)> = url
            .query_pairs()
            .filter(|(name, _)| name != "q" && name != "count")
            .map(|(name, value)| (name.into_owned(), value.into_owned()))
            .collect();
        url.set_query(None);
        let mut params = url.query_pairs_mut();
        params.extend_pairs(existing);
        params.append_pair("q", api.query.as_deref().unwrap_or(""));
        params.append_pair("count", &api.count.unwrap_or(5).to_string());
    } else if api.query.is_some() || api.count.is_some() {
        return Err(ApiHttpError::new(
            "INVALID_REQUEST",
            "当前操作不接受搜索参数",
        ));
    }
    let mut headers = vec![("content-type".into(), "application/json".into())];
    if !record.key.is_empty() {
        let (name, value) = match connection.protocol.as_str() {
            "serper" => ("x-api-key", record.key.clone()),
            "brave" => ("x-subscription-token", record.key.clone()),
            _ => ("authorization", format!("Bearer {}", record.key)),
        };
        headers.push((name.into(), value));
    }
    Ok((url.to_string(), method.into(), headers))
}

fn prepare_request(
    app: &AppHandle,
    mut request: ExternalHttpRequest,
) -> Result<ExternalHttpRequest, ApiHttpError> {
    if let Some(api) = &request.api {
        if !request.url.is_empty() || !request.method.is_empty() || !request.headers.is_empty() {
            return Err(ApiHttpError::new(
                "INVALID_REQUEST",
                "凭据请求不得覆盖目标或请求头",
            ));
        }
        let record =
            crate::api_credentials::read_connection(app, &api.config_id).map_err(|_| {
                ApiHttpError::new("CREDENTIAL_UNAVAILABLE", "安全配置不可用，请检查设置")
            })?;
        let (url, method, headers) = bound_target(&record, api)?;
        request.url = url;
        request.method = method;
        request.headers = headers;
        request.response_secret = record.key;
        if request.method == "GET" && request.body.is_some() {
            return Err(ApiHttpError::new("INVALID_REQUEST", "当前操作不接受请求体"));
        }
    } else if request.headers.iter().any(|(name, _)| {
        matches!(
            name.to_ascii_lowercase().as_str(),
            "authorization" | "x-api-key" | "x-subscription-token" | "api-key"
        )
    }) {
        return Err(ApiHttpError::new(
            "HEADER_NOT_ALLOWED",
            "鉴权仅允许由安全配置生成",
        ));
    } else {
        validate_update_request(&request)?;
    }
    Ok(request)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalHttpResponse {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

fn register_cancellation(
    state: &ApiOriginState,
    request_id: &str,
) -> Result<CancellationToken, ApiHttpError> {
    if request_id.trim().is_empty() {
        return Err(ApiHttpError::new("INVALID_REQUEST_ID", "请求 ID 不能为空"));
    }
    let token = CancellationToken::new();
    let mut cancellations = state
        .cancellations
        .lock()
        .map_err(|_| ApiHttpError::new("CANCELLATION_STATE_UNAVAILABLE", "请求取消状态不可用"))?;
    if cancellations.contains_key(request_id) {
        return Err(ApiHttpError::new("INVALID_REQUEST_ID", "请求 ID 已在使用"));
    }
    cancellations.insert(request_id.to_owned(), token.clone());
    Ok(token)
}

fn cleanup_cancellation(state: &ApiOriginState, request_id: &str) {
    if let Ok(mut cancellations) = state.cancellations.lock() {
        cancellations.remove(request_id);
    }
}

fn register_stream_ack_window(
    state: &ApiOriginState,
    request_id: &str,
) -> Result<Arc<Semaphore>, ApiHttpError> {
    let window = Arc::new(Semaphore::new(STREAM_ACK_WINDOW));
    state
        .stream_acks
        .lock()
        .map_err(|_| ApiHttpError::new("STREAM_STATE_UNAVAILABLE", "流式响应状态不可用"))?
        .insert(request_id.to_owned(), window.clone());
    Ok(window)
}

fn cleanup_stream_ack_window(state: &ApiOriginState, request_id: &str) {
    if let Ok(mut streams) = state.stream_acks.lock() {
        streams.remove(request_id);
    }
}

#[tauri::command(rename_all = "camelCase")]
pub fn acknowledge_external_http_stream(
    state: State<'_, ApiOriginState>,
    request_id: String,
) -> Result<bool, ApiHttpError> {
    let streams = state
        .stream_acks
        .lock()
        .map_err(|_| ApiHttpError::new("STREAM_STATE_UNAVAILABLE", "流式响应状态不可用"))?;
    let Some(window) = streams.get(&request_id) else {
        return Ok(false);
    };
    if window.available_permits() < STREAM_ACK_WINDOW {
        window.add_permits(1);
    }
    Ok(true)
}

fn cancelled_error() -> ApiHttpError {
    ApiHttpError::new("REQUEST_CANCELLED", "请求已取消")
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum ExternalHttpStreamEvent {
    Start {
        status: u16,
        headers: Vec<(String, String)>,
    },
    Chunk {
        data: Vec<u8>,
    },
    End,
    Error {
        error: ApiHttpError,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizeApiOriginRequest {
    origin: String,
    persistence: OriginPersistence,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
enum OriginPersistence {
    Session,
    Permanent,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizedApiOrigin {
    origin: String,
    persistence: &'static str,
}

#[derive(Debug, Default, Deserialize, Serialize)]
struct PersistedApiOrigins {
    #[serde(default)]
    origins: Vec<String>,
}

fn grants_path(app: &AppHandle) -> Result<PathBuf, ApiHttpError> {
    app.path()
        .app_config_dir()
        .map(|path| path.join(API_ORIGIN_GRANTS_FILE))
        .map_err(|error| ApiHttpError::new("CONFIG_DIR_UNAVAILABLE", error.to_string()))
}

async fn ensure_loaded(app: &AppHandle, state: &ApiOriginState) -> Result<(), ApiHttpError> {
    if state.loaded.load(Ordering::Acquire) {
        return Ok(());
    }
    let _guard = state.load_lock.lock().await;
    if state.loaded.load(Ordering::Acquire) {
        return Ok(());
    }
    let path = grants_path(app)?;
    let persisted = tauri::async_runtime::spawn_blocking(
        move || -> Result<PersistedApiOrigins, ApiHttpError> {
            if !path.exists() {
                return Ok(PersistedApiOrigins::default());
            }
            let content = fs::read_to_string(path).map_err(|error| {
                ApiHttpError::new("ORIGIN_STORE_READ_FAILED", error.to_string())
            })?;
            serde_json::from_str(&content)
                .map_err(|error| ApiHttpError::new("ORIGIN_STORE_INVALID", error.to_string()))
        },
    )
    .await
    .map_err(|error| ApiHttpError::new("ORIGIN_STORE_READ_FAILED", error.to_string()))??;

    let mut permanent = state
        .permanent
        .lock()
        .map_err(|_| ApiHttpError::new("ORIGIN_STATE_UNAVAILABLE", "API 授权状态不可用"))?;
    permanent.extend(
        persisted
            .origins
            .into_iter()
            .filter_map(|origin| normalize_origin(&origin).ok()),
    );
    state.loaded.store(true, Ordering::Release);
    Ok(())
}

async fn persist_origins(app: &AppHandle, origins: Vec<String>) -> Result<(), ApiHttpError> {
    let path = grants_path(app)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<(), ApiHttpError> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                ApiHttpError::new("ORIGIN_STORE_WRITE_FAILED", error.to_string())
            })?;
        }
        let content = serde_json::to_vec_pretty(&PersistedApiOrigins { origins })
            .map_err(|error| ApiHttpError::new("ORIGIN_STORE_WRITE_FAILED", error.to_string()))?;
        fs::write(path, content)
            .map_err(|error| ApiHttpError::new("ORIGIN_STORE_WRITE_FAILED", error.to_string()))
    })
    .await
    .map_err(|error| ApiHttpError::new("ORIGIN_STORE_WRITE_FAILED", error.to_string()))?
}

fn normalize_origin(value: &str) -> Result<String, ApiHttpError> {
    let url =
        Url::parse(value).map_err(|_| ApiHttpError::new("INVALID_URL", "API 地址格式无效"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(ApiHttpError::new(
            "SCHEME_NOT_ALLOWED",
            "仅允许 HTTP 或 HTTPS",
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(ApiHttpError::new(
            "URL_CREDENTIALS_NOT_ALLOWED",
            "API 地址不得包含用户名或密码",
        ));
    }
    let host = url
        .host()
        .ok_or_else(|| ApiHttpError::new("INVALID_URL", "API 地址缺少主机名"))?;
    let host = match host {
        Host::Ipv6(ip) => format!("[{ip}]"),
        _ => host.to_string().to_ascii_lowercase(),
    };
    let port = url
        .port_or_known_default()
        .ok_or_else(|| ApiHttpError::new("INVALID_URL", "API 地址缺少端口"))?;
    Ok(format!("{}://{}:{}", url.scheme(), host, port))
}

fn parse_method(method: &str) -> Result<Method, ApiHttpError> {
    match method.to_ascii_uppercase().as_str() {
        "GET" => Ok(Method::GET),
        "POST" => Ok(Method::POST),
        _ => Err(ApiHttpError::new(
            "METHOD_NOT_ALLOWED",
            "仅允许 GET 或 POST 请求",
        )),
    }
}

fn is_blocked_header(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    matches!(
        name.as_str(),
        "host"
            | "cookie"
            | "origin"
            | "referer"
            | "content-length"
            | "transfer-encoding"
            | "connection"
            | "upgrade"
            | "proxy-authorization"
            | "proxy-connection"
            | "forwarded"
    ) || name.starts_with("x-forwarded-")
        || name.starts_with("sec-")
}

fn build_headers(headers: &[(String, String)]) -> Result<HeaderMap, ApiHttpError> {
    let mut output = HeaderMap::new();
    for (name, value) in headers {
        if is_blocked_header(name) {
            return Err(ApiHttpError::new(
                "HEADER_NOT_ALLOWED",
                format!("请求头不允许使用：{name}"),
            ));
        }
        let name = HeaderName::from_str(name)
            .map_err(|_| ApiHttpError::new("INVALID_HEADER", "请求头名称无效"))?;
        let value = HeaderValue::from_str(value)
            .map_err(|_| ApiHttpError::new("INVALID_HEADER", "请求头内容无效"))?;
        output.append(name, value);
    }
    Ok(output)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AddressKind {
    Loopback,
    Private,
    Public,
    Blocked,
}

fn classify_ip(ip: IpAddr) -> AddressKind {
    match ip {
        IpAddr::V4(ip) => {
            if ip.is_unspecified()
                || ip.is_link_local()
                || ip.is_multicast()
                || ip == Ipv4Addr::BROADCAST
            {
                AddressKind::Blocked
            } else if ip.is_loopback() {
                AddressKind::Loopback
            } else if ip.is_private() {
                AddressKind::Private
            } else {
                AddressKind::Public
            }
        }
        IpAddr::V6(ip) => {
            if let Some(v4) = ip.to_ipv4_mapped() {
                return classify_ip(IpAddr::V4(v4));
            }
            if ip.is_unspecified() || ip.is_multicast() || ip.is_unicast_link_local() {
                AddressKind::Blocked
            } else if ip.is_loopback() {
                AddressKind::Loopback
            } else if (ip.segments()[0] & 0xfe00) == 0xfc00 {
                AddressKind::Private
            } else {
                AddressKind::Public
            }
        }
    }
}

async fn resolve_target(url: &Url) -> Result<Vec<SocketAddr>, ApiHttpError> {
    let host = url
        .host_str()
        .ok_or_else(|| ApiHttpError::new("INVALID_URL", "API 地址缺少主机名"))?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| ApiHttpError::new("INVALID_URL", "API 地址缺少端口"))?;
    let addresses: Vec<_> = lookup_host((host, port))
        .await
        .map_err(|error| ApiHttpError::new("DNS_RESOLUTION_FAILED", error.to_string()))?
        .collect();
    if addresses.is_empty() {
        return Err(ApiHttpError::new(
            "DNS_RESOLUTION_FAILED",
            "API 地址未解析到可用 IP",
        ));
    }
    let kinds: Vec<_> = addresses
        .iter()
        .map(|address| classify_ip(address.ip()))
        .collect();
    validate_address_kinds(url.scheme(), &kinds)?;
    Ok(addresses)
}

fn validate_address_kinds(scheme: &str, kinds: &[AddressKind]) -> Result<(), ApiHttpError> {
    if kinds.contains(&AddressKind::Blocked) {
        return Err(ApiHttpError::new(
            "ADDRESS_NOT_ALLOWED",
            "目标地址属于永久禁止访问的网络范围",
        ));
    }
    if scheme == "http" && kinds.contains(&AddressKind::Public) {
        return Err(ApiHttpError::new(
            "PUBLIC_HTTP_NOT_ALLOWED",
            "公网 API 仅允许使用 HTTPS",
        ));
    }
    Ok(())
}

fn response_headers(response: &Response, secret: &str) -> Vec<(String, String)> {
    response
        .headers()
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .filter(|value| secret.is_empty() || !value.contains(secret))
                .filter(|_| {
                    !matches!(
                        name.as_str(),
                        "authorization" | "x-api-key" | "x-subscription-token" | "set-cookie"
                    )
                })
                .map(|value| (name.to_string(), value.to_string()))
        })
        .collect()
}

// Withhold a small suffix so a credential split across network chunks never reaches IPC.
struct CredentialResponseGuard {
    patterns: Vec<Vec<u8>>,
    pending: Vec<u8>,
}

impl CredentialResponseGuard {
    fn new(secret: &str) -> Self {
        let mut patterns = Vec::new();
        if !secret.is_empty() {
            patterns.push(secret.as_bytes().to_vec());
            if let Ok(encoded) = serde_json::to_string(secret) {
                patterns.push(encoded.as_bytes()[1..encoded.len() - 1].to_vec());
            }
        }
        Self {
            patterns,
            pending: Vec::new(),
        }
    }

    fn push(&mut self, bytes: &[u8], finished: bool) -> Result<Vec<u8>, ApiHttpError> {
        self.pending.extend_from_slice(bytes);
        if self.patterns.iter().any(|pattern| {
            self.pending
                .windows(pattern.len())
                .any(|part| part == pattern)
        }) {
            return Err(ApiHttpError::new(
                "CREDENTIAL_IN_RESPONSE",
                "服务响应包含敏感凭据，已拒绝返回",
            ));
        }
        let keep = if finished {
            0
        } else {
            self.patterns.iter().map(Vec::len).max().unwrap_or(1) - 1
        };
        let emit = self.pending.len().saturating_sub(keep);
        Ok(self.pending.drain(..emit).collect())
    }
}

fn is_authorized(state: &ApiOriginState, origin: &str) -> Result<bool, ApiHttpError> {
    if BUILTIN_ORIGINS.contains(&origin) {
        return Ok(true);
    }
    let session = state
        .session
        .lock()
        .map_err(|_| ApiHttpError::new("ORIGIN_STATE_UNAVAILABLE", "API 授权状态不可用"))?;
    if session.contains(origin) {
        return Ok(true);
    }
    drop(session);
    let permanent = state
        .permanent
        .lock()
        .map_err(|_| ApiHttpError::new("ORIGIN_STATE_UNAVAILABLE", "API 授权状态不可用"))?;
    Ok(permanent.contains(origin))
}

async fn send_request(
    state: &ApiOriginState,
    request: &ExternalHttpRequest,
    cancellation: &CancellationToken,
) -> Result<Response, ApiHttpError> {
    // Queued requests must not start after another response exhausts the session budget.
    state
        .usage
        .lock()
        .map_err(|_| ApiHttpError::new("USAGE_STATE_UNAVAILABLE", "API 使用计数不可用"))?
        .ensure_output_capacity()
        .map_err(usage_error)?;
    let method = parse_method(&request.method)?;
    let url = Url::parse(&request.url)
        .map_err(|_| ApiHttpError::new("INVALID_URL", "API 地址格式无效"))?;
    let origin = normalize_origin(&request.url)?;
    if !is_authorized(state, &origin)? {
        return Err(ApiHttpError::unauthorized(origin));
    }
    if request.body.as_ref().map_or(0, Vec::len) > MAX_REQUEST_BODY_BYTES {
        return Err(ApiHttpError::new(
            "REQUEST_BODY_TOO_LARGE",
            "请求体超过 2 MiB 限制",
        ));
    }
    let addresses = resolve_target(&url).await?;
    let host = url
        .host_str()
        .ok_or_else(|| ApiHttpError::new("INVALID_URL", "API 地址缺少主机名"))?;
    let timeout_ms = request
        .timeout_ms
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(1, MAX_TIMEOUT_MS);
    let mut builder = Client::builder()
        .redirect(Policy::none())
        .timeout(Duration::from_millis(timeout_ms));
    for address in addresses {
        builder = builder.resolve(host, address);
    }
    let client = builder
        .build()
        .map_err(|error| ApiHttpError::new("HTTP_CLIENT_FAILED", error.to_string()))?;
    let mut outgoing = client
        .request(method, url)
        .headers(build_headers(&request.headers)?);
    if let Some(body) = &request.body {
        outgoing = outgoing.body(body.clone());
    }
    tokio::select! {
        _ = cancellation.cancelled() => Err(cancelled_error()),
        response = outgoing.send() => response
            .map_err(|error| ApiHttpError::new("NETWORK_ERROR", error.to_string())),
    }
}

#[tauri::command(rename_all = "camelCase")]
pub fn cancel_external_http_request(
    state: State<'_, ApiOriginState>,
    request_id: String,
) -> Result<bool, ApiHttpError> {
    let token = state
        .cancellations
        .lock()
        .map_err(|_| ApiHttpError::new("CANCELLATION_STATE_UNAVAILABLE", "请求取消状态不可用"))?
        .get(&request_id)
        .cloned();
    if let Some(token) = token {
        token.cancel();
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tauri::command(rename_all = "camelCase")]
pub async fn authorize_api_origin(
    app: AppHandle,
    state: State<'_, ApiOriginState>,
    request: AuthorizeApiOriginRequest,
) -> Result<String, ApiHttpError> {
    ensure_loaded(&app, &state).await?;
    let origin = normalize_origin(&request.origin)?;
    let url =
        Url::parse(&origin).map_err(|_| ApiHttpError::new("INVALID_URL", "API 地址格式无效"))?;
    resolve_target(&url).await?;
    match request.persistence {
        OriginPersistence::Session => {
            state
                .session
                .lock()
                .map_err(|_| ApiHttpError::new("ORIGIN_STATE_UNAVAILABLE", "API 授权状态不可用"))?
                .insert(origin.clone());
        }
        OriginPersistence::Permanent => {
            let origins = {
                let permanent = state.permanent.lock().map_err(|_| {
                    ApiHttpError::new("ORIGIN_STATE_UNAVAILABLE", "API 授权状态不可用")
                })?;
                let mut values: Vec<_> = permanent.iter().cloned().collect();
                if !values.contains(&origin) {
                    values.push(origin.clone());
                }
                values.sort();
                values
            };
            persist_origins(&app, origins.clone()).await?;
            *state.permanent.lock().map_err(|_| {
                ApiHttpError::new("ORIGIN_STATE_UNAVAILABLE", "API 授权状态不可用")
            })? = origins.into_iter().collect();
        }
    }
    Ok(origin)
}

#[tauri::command]
pub async fn list_authorized_api_origins(
    app: AppHandle,
    state: State<'_, ApiOriginState>,
) -> Result<Vec<AuthorizedApiOrigin>, ApiHttpError> {
    ensure_loaded(&app, &state).await?;
    let permanent = state
        .permanent
        .lock()
        .map_err(|_| ApiHttpError::new("ORIGIN_STATE_UNAVAILABLE", "API 授权状态不可用"))?;
    let mut origins: Vec<_> = permanent
        .iter()
        .cloned()
        .map(|origin| AuthorizedApiOrigin {
            origin,
            persistence: "permanent",
        })
        .collect();
    let session = state
        .session
        .lock()
        .map_err(|_| ApiHttpError::new("ORIGIN_STATE_UNAVAILABLE", "API 授权状态不可用"))?;
    origins.extend(
        session
            .iter()
            .filter(|origin| !permanent.contains(*origin))
            .cloned()
            .map(|origin| AuthorizedApiOrigin {
                origin,
                persistence: "session",
            }),
    );
    origins.sort_by(|a, b| a.origin.cmp(&b.origin));
    Ok(origins)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn revoke_api_origin(
    app: AppHandle,
    state: State<'_, ApiOriginState>,
    origin: String,
) -> Result<(), ApiHttpError> {
    ensure_loaded(&app, &state).await?;
    let origin = normalize_origin(&origin)?;
    state
        .session
        .lock()
        .map_err(|_| ApiHttpError::new("ORIGIN_STATE_UNAVAILABLE", "API 授权状态不可用"))?
        .remove(&origin);
    let origins = {
        let permanent = state
            .permanent
            .lock()
            .map_err(|_| ApiHttpError::new("ORIGIN_STATE_UNAVAILABLE", "API 授权状态不可用"))?;
        let mut values: Vec<_> = permanent
            .iter()
            .filter(|value| value.as_str() != origin)
            .cloned()
            .collect();
        values.sort();
        values
    };
    persist_origins(&app, origins.clone()).await?;
    *state
        .permanent
        .lock()
        .map_err(|_| ApiHttpError::new("ORIGIN_STATE_UNAVAILABLE", "API 授权状态不可用"))? =
        origins.into_iter().collect();
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn external_http_request(
    app: AppHandle,
    state: State<'_, ApiOriginState>,
    request: ExternalHttpRequest,
) -> Result<ExternalHttpResponse, ApiHttpError> {
    ensure_loaded(&app, &state).await?;
    let request = prepare_request(&app, request)?;
    admit_request(&state, &request)?;
    let request_id = request.request_id.clone();
    let cancellation = register_cancellation(&state, &request_id)?;
    let result = tokio::time::timeout(request_timeout(&request), async {
        let _permit = tokio::select! {
            _ = cancellation.cancelled() => return Err(cancelled_error()),
            permit = state.concurrency.acquire() => permit
                .map_err(|_| ApiHttpError::new("CONCURRENCY_UNAVAILABLE", "请求并发控制不可用"))?,
        };
        let response = send_request(&state, &request, &cancellation).await?;
        let status = response.status().as_u16();
        let headers = response_headers(&response, &request.response_secret);
        let mut body = Vec::new();
        let mut stream = response.bytes_stream();
        loop {
            let chunk = tokio::select! {
                _ = cancellation.cancelled() => return Err(cancelled_error()),
                chunk = stream.next() => chunk,
            };
            let Some(chunk) = chunk else { break };
            let chunk = chunk
                .map_err(|error| ApiHttpError::new("RESPONSE_READ_FAILED", error.to_string()))?;
            count_response(&state, chunk.len())?;
            if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BODY_BYTES {
                return Err(ApiHttpError::new(
                    "RESPONSE_BODY_TOO_LARGE",
                    "响应体超过 16 MiB 限制",
                ));
            }
            body.extend_from_slice(&chunk);
        }
        CredentialResponseGuard::new(&request.response_secret).push(&body, true)?;
        Ok(ExternalHttpResponse {
            status,
            headers,
            body,
        })
    })
    .await
    .unwrap_or_else(|_| Err(ApiHttpError::new("REQUEST_TIMEOUT", "API 请求超时")));
    cleanup_cancellation(&state, &request_id);
    result
}

#[tauri::command(rename_all = "camelCase")]
pub async fn external_http_stream(
    app: AppHandle,
    state: State<'_, ApiOriginState>,
    request: ExternalHttpRequest,
    on_event: Channel<ExternalHttpStreamEvent>,
) -> Result<(), ApiHttpError> {
    ensure_loaded(&app, &state).await?;
    let request = prepare_request(&app, request)?;
    admit_request(&state, &request)?;
    let request_id = request.request_id.clone();
    let cancellation = register_cancellation(&state, &request_id)?;
    let ack_window = match register_stream_ack_window(&state, &request_id) {
        Ok(window) => window,
        Err(error) => {
            cleanup_cancellation(&state, &request_id);
            return Err(error);
        }
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<ApiOriginState>();
        let result = tokio::time::timeout(request_timeout(&request), async {
            let _permit = tokio::select! {
                _ = cancellation.cancelled() => return Err(cancelled_error()),
                permit = state.concurrency.acquire() => permit
                    .map_err(|_| ApiHttpError::new("CONCURRENCY_UNAVAILABLE", "请求并发控制不可用"))?,
            };
            let response = send_request(&state, &request, &cancellation).await?;
            let status = response.status().as_u16();
            let headers = response_headers(&response, &request.response_secret);
            if on_event
                .send(ExternalHttpStreamEvent::Start { status, headers })
                .is_err()
            {
                return Ok(());
            }
            let mut received = 0usize;
            let mut guard = CredentialResponseGuard::new(&request.response_secret);
            let mut stream = response.bytes_stream();
            loop {
                let chunk = tokio::select! {
                    _ = cancellation.cancelled() => return Err(cancelled_error()),
                    chunk = stream.next() => chunk,
                };
                let finished = chunk.is_none();
                let chunk = chunk.transpose().map_err(|error| {
                    ApiHttpError::new("RESPONSE_READ_FAILED", error.to_string())
                })?.unwrap_or_default();
                count_response(&state, chunk.len())?;
                received = received.saturating_add(chunk.len());
                if received > MAX_RESPONSE_BODY_BYTES {
                    return Err(ApiHttpError::new(
                        "RESPONSE_BODY_TOO_LARGE",
                        "响应体超过 16 MiB 限制",
                    ));
                }
                let safe = guard.push(&chunk, finished)?;
                for batch in safe.chunks(STREAM_BATCH_BYTES) {
                    let permit = tokio::select! {
                        _ = cancellation.cancelled() => return Err(cancelled_error()),
                        permit = ack_window.acquire() => permit
                            .map_err(|_| ApiHttpError::new("STREAM_STATE_UNAVAILABLE", "流式响应状态不可用"))?,
                    };
                    permit.forget();
                    if on_event
                        .send(ExternalHttpStreamEvent::Chunk {
                            data: batch.to_vec(),
                        })
                        .is_err()
                    {
                        return Ok(());
                    }
                }
                if finished { break; }
            }
            let _ = on_event.send(ExternalHttpStreamEvent::End);
            Ok(())
        }).await.unwrap_or_else(|_| Err(ApiHttpError::new("REQUEST_TIMEOUT", "API 请求超时")));
        if let Err(error) = result {
            let _ = on_event.send(ExternalHttpStreamEvent::Error { error });
        }
        cleanup_cancellation(&state, &request_id);
        cleanup_stream_ack_window(&state, &request_id);
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    #[test]
    fn ordinary_proxy_only_accepts_exact_update_endpoints() {
        let mut request = ExternalHttpRequest {
            request_id: "anonymous".into(),
            url: format!("{UPDATE_RELEASES_URL}latest"),
            method: "GET".into(),
            headers: vec![],
            body: None,
            timeout_ms: None,
            api: None,
            response_secret: String::new(),
        };
        validate_update_request(&request).unwrap();
        request.url = format!("{UPDATE_RELEASES_URL}tags/v1.2.3-beta.1%2Bbuild");
        validate_update_request(&request).unwrap();
        for url in [
            "https://api.github.com/user",
            "https://custom.example/v1/models",
            "https://api.github.com/repos/we-used-to-be/Guanmo-open/releases/latest?q=a",
            "https://api.github.com/repos/we-used-to-be/Guanmo-open/releases/tags/v1%2fother",
        ] {
            request.url = url.into();
            assert_eq!(
                validate_update_request(&request).unwrap_err().code,
                "OPERATION_NOT_ALLOWED"
            );
        }
        request.url = format!("{UPDATE_RELEASES_URL}latest");
        request.method = "POST".into();
        assert!(validate_update_request(&request).is_err());
        request.method = "GET".into();
        request.headers.push(("x-other".into(), "anonymous".into()));
        assert!(validate_update_request(&request).is_err());
    }

    #[test]
    fn bound_endpoints_reject_encoded_paths_and_mismatched_operations() {
        for base_url in [
            "https://custom.example/v1/%2fadmin",
            "https://custom.example/v1/../admin",
            "https://custom.example/v1/%252e",
        ] {
            let record = crate::api_credentials::StoredConnection {
                connection: crate::api_credentials::ApiConnection {
                    kind: "chat".into(),
                    protocol: "openai-chat".into(),
                    base_url: base_url.into(),
                },
                key: "synthetic-key".into(),
            };
            let api = BoundApiRequest {
                config_id: "anonymous".into(),
                operation: "chat".into(),
                query: None,
                count: None,
            };
            assert!(bound_target(&record, &api).is_err());
        }
    }

    #[test]
    fn usage_counts_authorized_requests_and_duplicate_ids_cannot_replace_active_cleanup() {
        let state = ApiOriginState::default();
        let mut request = ExternalHttpRequest {
            request_id: "anonymous".into(),
            url: "https://custom.example/v1/models".into(),
            method: "GET".into(),
            headers: vec![],
            body: None,
            timeout_ms: None,
            api: None,
            response_secret: String::new(),
        };
        assert_eq!(
            admit_request(&state, &request).unwrap_err().code,
            "ORIGIN_NOT_AUTHORIZED"
        );
        request.url = format!("{UPDATE_RELEASES_URL}latest");
        for _ in 0..crate::api_http_limits::CONFIG_REQUESTS_PER_MINUTE {
            admit_request(&state, &request).unwrap();
        }
        assert_eq!(
            admit_request(&state, &request).unwrap_err().code,
            "RATE_LIMIT_EXCEEDED"
        );
        let original = register_cancellation(&state, "anonymous").unwrap();
        assert_eq!(
            register_cancellation(&state, "anonymous").unwrap_err().code,
            "INVALID_REQUEST_ID"
        );
        assert!(!original.is_cancelled());
        cleanup_cancellation(&state, "anonymous");
        register_cancellation(&state, "anonymous").unwrap();
    }

    #[test]
    fn credential_target_and_authentication_are_derived_from_the_record() {
        let record = crate::api_credentials::StoredConnection {
            connection: crate::api_credentials::ApiConnection {
                kind: "search".into(),
                protocol: "serper".into(),
                base_url: "https://google.serper.dev/search".into(),
            },
            key: "synthetic-key".into(),
        };
        let api = BoundApiRequest {
            config_id: "opaque".into(),
            operation: "search".into(),
            query: None,
            count: None,
        };
        let (url, method, headers) = bound_target(&record, &api).unwrap();
        assert_eq!(url, "https://google.serper.dev/search");
        assert_eq!(method, "POST");
        assert!(headers.contains(&("x-api-key".into(), "synthetic-key".into())));
        let forged = BoundApiRequest {
            operation: "chat".into(),
            ..api
        };
        assert_eq!(
            bound_target(&record, &forged).unwrap_err().code,
            "OPERATION_NOT_ALLOWED"
        );
        assert!(
            serde_json::from_value::<BoundApiRequest>(serde_json::json!({
                "configId": "opaque", "operation": "search", "url": "https://other.example",
            }))
            .is_err()
        );
    }

    #[test]
    fn credential_response_guard_blocks_echo_across_chunk_boundaries() {
        let mut guard = CredentialResponseGuard::new("synthetic-key");
        assert!(guard.push(b"data: synthetic-", false).is_ok());
        assert_eq!(
            guard.push(b"key", false).unwrap_err().code,
            "CREDENTIAL_IN_RESPONSE"
        );
        let mut guard = CredentialResponseGuard::new("synthetic-key");
        let mut emitted = guard.push(b"data: anonymous", false).unwrap();
        emitted.extend(guard.push(b"\n\n", true).unwrap());
        assert_eq!(emitted, b"data: anonymous\n\n");
    }

    #[test]
    fn normalizes_origin_with_explicit_port() {
        assert_eq!(
            normalize_origin("https://API.OpenAI.com/v1").unwrap(),
            "https://api.openai.com:443"
        );
        assert_eq!(
            normalize_origin("http://[::1]:11434/v1").unwrap(),
            "http://[::1]:11434"
        );
    }

    #[test]
    fn rejects_unsafe_url_method_and_headers() {
        assert_eq!(
            normalize_origin("file:///tmp/a").unwrap_err().code,
            "SCHEME_NOT_ALLOWED"
        );
        assert_eq!(
            normalize_origin("https://user:pass@example.com")
                .unwrap_err()
                .code,
            "URL_CREDENTIALS_NOT_ALLOWED"
        );
        assert_eq!(parse_method("PUT").unwrap_err().code, "METHOD_NOT_ALLOWED");
        assert_eq!(
            build_headers(&[("Host".into(), "evil".into())])
                .unwrap_err()
                .code,
            "HEADER_NOT_ALLOWED"
        );
    }

    #[test]
    fn rejects_invalid_protocol_credentials_and_public_http() {
        assert_eq!(
            normalize_origin("ftp://example.com/resource")
                .unwrap_err()
                .code,
            "SCHEME_NOT_ALLOWED"
        );
        assert_eq!(
            normalize_origin("https://anonymous:secret@example.com/v1")
                .unwrap_err()
                .code,
            "URL_CREDENTIALS_NOT_ALLOWED"
        );
        assert_eq!(
            validate_address_kinds("http", &[AddressKind::Public])
                .unwrap_err()
                .code,
            "PUBLIC_HTTP_NOT_ALLOWED"
        );
    }

    #[test]
    fn blocks_sensitive_network_ranges_for_every_protocol() {
        for address in [
            "0.0.0.0",
            "169.254.169.254",
            "224.0.0.1",
            "255.255.255.255",
            "fe80::1",
        ] {
            let kind = classify_ip(address.parse().unwrap());
            assert_eq!(
                kind,
                AddressKind::Blocked,
                "address should be blocked: {address}"
            );
            assert_eq!(
                validate_address_kinds("https", &[kind]).unwrap_err().code,
                "ADDRESS_NOT_ALLOWED"
            );
        }
    }

    #[test]
    fn classifies_loopback_private_public_and_dangerous_addresses() {
        assert_eq!(
            classify_ip("127.0.0.1".parse().unwrap()),
            AddressKind::Loopback
        );
        assert_eq!(
            classify_ip("192.168.1.2".parse().unwrap()),
            AddressKind::Private
        );
        assert_eq!(classify_ip("8.8.8.8".parse().unwrap()), AddressKind::Public);
        assert_eq!(
            classify_ip("169.254.169.254".parse().unwrap()),
            AddressKind::Blocked
        );
        assert_eq!(
            classify_ip("224.0.0.1".parse().unwrap()),
            AddressKind::Blocked
        );
        assert_eq!(
            classify_ip("0.0.0.0".parse().unwrap()),
            AddressKind::Blocked
        );
        assert_eq!(
            classify_ip("255.255.255.255".parse().unwrap()),
            AddressKind::Blocked
        );
        assert!(validate_address_kinds("http", &[AddressKind::Loopback]).is_ok());
        assert!(validate_address_kinds("http", &[AddressKind::Private]).is_ok());
        assert_eq!(
            validate_address_kinds("http", &[AddressKind::Public])
                .unwrap_err()
                .code,
            "PUBLIC_HTTP_NOT_ALLOWED"
        );
        assert_eq!(
            validate_address_kinds("https", &[AddressKind::Blocked])
                .unwrap_err()
                .code,
            "ADDRESS_NOT_ALLOWED"
        );
    }

    #[test]
    fn builtin_origins_are_fixed_and_persisted_format_round_trips() {
        assert!(BUILTIN_ORIGINS.contains(&"https://ark.cn-beijing.volces.com:443"));
        let encoded = serde_json::to_string(&PersistedApiOrigins {
            origins: vec!["https://custom.example:443".into()],
        })
        .unwrap();
        let decoded: PersistedApiOrigins = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded.origins, vec!["https://custom.example:443"]);
    }

    #[tokio::test]
    async fn does_not_follow_redirects() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let origin = format!("http://127.0.0.1:{}", address.port());
        let state = ApiOriginState::default();
        state.session.lock().unwrap().insert(origin.clone());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = [0u8; 1024];
            let _ = socket.read(&mut buffer).await.unwrap();
            socket.write_all(
                b"HTTP/1.1 302 Found\r\nLocation: https://example.com/final\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            ).await.unwrap();
        });
        let response = send_request(
            &state,
            &ExternalHttpRequest {
                request_id: "redirect-test".into(),
                url: format!("{origin}/redirect"),
                method: "GET".into(),
                headers: vec![],
                body: None,
                timeout_ms: Some(5_000),
                api: None,
                response_secret: String::new(),
            },
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(response.status().as_u16(), 302);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn cancellation_stops_response_reading_and_registry_cleanup_is_idempotent() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let origin = format!("http://127.0.0.1:{}", address.port());
        let state = ApiOriginState::default();
        state.session.lock().unwrap().insert(origin.clone());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = [0u8; 1024];
            let _ = socket.read(&mut buffer).await.unwrap();
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nfirst\r\n")
                .await
                .unwrap();
            tokio::time::sleep(Duration::from_millis(100)).await;
            let _ = socket.write_all(b"6\r\nsecond\r\n0\r\n\r\n").await;
        });
        let request_id = "cancellation-test";
        let cancellation = register_cancellation(&state, request_id).unwrap();
        let response = send_request(
            &state,
            &ExternalHttpRequest {
                request_id: request_id.into(),
                url: format!("{origin}/slow"),
                method: "GET".into(),
                headers: vec![],
                body: None,
                timeout_ms: Some(5_000),
                api: None,
                response_secret: String::new(),
            },
            &cancellation,
        )
        .await
        .unwrap();
        let mut stream = response.bytes_stream();
        assert_eq!(stream.next().await.unwrap().unwrap().as_ref(), b"first");
        cancellation.cancel();
        let error = tokio::select! {
            _ = cancellation.cancelled() => cancelled_error(),
            _ = stream.next() => panic!("cancelled response should not continue reading"),
        };
        assert_eq!(error.code, "REQUEST_CANCELLED");
        cleanup_cancellation(&state, request_id);
        cleanup_cancellation(&state, request_id);
        assert!(state.cancellations.lock().unwrap().is_empty());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn stream_ack_window_is_bounded_and_cancellation_unblocks_waiter() {
        let state = ApiOriginState::default();
        let request_id = "backpressure-test";
        let cancellation = register_cancellation(&state, request_id).unwrap();
        let window = register_stream_ack_window(&state, request_id).unwrap();

        for _ in 0..STREAM_ACK_WINDOW {
            window.acquire().await.unwrap().forget();
        }
        assert_eq!(window.available_permits(), 0);

        let blocked_window = window.clone();
        let blocked_cancellation = cancellation.clone();
        let waiter = tokio::spawn(async move {
            tokio::select! {
                _ = blocked_cancellation.cancelled() => "cancelled",
                _ = blocked_window.acquire() => "acquired",
            }
        });
        tokio::task::yield_now().await;
        cancellation.cancel();
        assert_eq!(waiter.await.unwrap(), "cancelled");

        cleanup_stream_ack_window(&state, request_id);
        cleanup_cancellation(&state, request_id);
        assert!(state.stream_acks.lock().unwrap().is_empty());
    }
}
