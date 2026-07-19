use futures_util::StreamExt;
use reqwest::{
    header::{HeaderMap, HeaderName, HeaderValue},
    redirect::Policy,
    Client, Method, Response,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
    str::FromStr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{ipc::Channel, AppHandle, Manager, State};
use tokio::{
    net::lookup_host,
    sync::{Mutex as AsyncMutex, Semaphore},
};
use url::{Host, Url};

const API_ORIGIN_GRANTS_FILE: &str = "api-origin-grants.json";
const MAX_REQUEST_BODY_BYTES: usize = 2 * 1024 * 1024;
const MAX_RESPONSE_BODY_BYTES: usize = 16 * 1024 * 1024;
const MAX_TIMEOUT_MS: u64 = 120_000;
const DEFAULT_TIMEOUT_MS: u64 = 60_000;
const MAX_CONCURRENT_REQUESTS: usize = 8;

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
    "https://lite.duckduckgo.com:443",
    "https://api.github.com:443",
];

pub struct ApiOriginState {
    session: Mutex<HashSet<String>>,
    permanent: Mutex<HashSet<String>>,
    loaded: AtomicBool,
    load_lock: AsyncMutex<()>,
    concurrency: Semaphore,
}

impl Default for ApiOriginState {
    fn default() -> Self {
        Self {
            session: Mutex::new(HashSet::new()),
            permanent: Mutex::new(HashSet::new()),
            loaded: AtomicBool::new(false),
            load_lock: AsyncMutex::new(()),
            concurrency: Semaphore::new(MAX_CONCURRENT_REQUESTS),
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalHttpRequest {
    url: String,
    method: String,
    #[serde(default)]
    headers: Vec<(String, String)>,
    body: Option<Vec<u8>>,
    timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalHttpResponse {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
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
    if kinds.iter().any(|kind| *kind == AddressKind::Blocked) {
        return Err(ApiHttpError::new(
            "ADDRESS_NOT_ALLOWED",
            "目标地址属于永久禁止访问的网络范围",
        ));
    }
    if scheme == "http" && kinds.iter().any(|kind| *kind == AddressKind::Public) {
        return Err(ApiHttpError::new(
            "PUBLIC_HTTP_NOT_ALLOWED",
            "公网 API 仅允许使用 HTTPS",
        ));
    }
    Ok(())
}

fn response_headers(response: &Response) -> Vec<(String, String)> {
    response
        .headers()
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.to_string(), value.to_string()))
        })
        .collect()
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
    request: ExternalHttpRequest,
) -> Result<Response, ApiHttpError> {
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
    if let Some(body) = request.body {
        outgoing = outgoing.body(body);
    }
    outgoing
        .send()
        .await
        .map_err(|error| ApiHttpError::new("NETWORK_ERROR", error.to_string()))
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
    let _permit = state
        .concurrency
        .acquire()
        .await
        .map_err(|_| ApiHttpError::new("CONCURRENCY_UNAVAILABLE", "请求并发控制不可用"))?;
    let response = send_request(&state, request).await?;
    let status = response.status().as_u16();
    let headers = response_headers(&response);
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk =
            chunk.map_err(|error| ApiHttpError::new("RESPONSE_READ_FAILED", error.to_string()))?;
        if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BODY_BYTES {
            return Err(ApiHttpError::new(
                "RESPONSE_BODY_TOO_LARGE",
                "响应体超过 16 MiB 限制",
            ));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(ExternalHttpResponse {
        status,
        headers,
        body,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub async fn external_http_stream(
    app: AppHandle,
    state: State<'_, ApiOriginState>,
    request: ExternalHttpRequest,
    on_event: Channel<ExternalHttpStreamEvent>,
) -> Result<(), ApiHttpError> {
    ensure_loaded(&app, &state).await?;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<ApiOriginState>();
        let result = async {
            let _permit =
                state.concurrency.acquire().await.map_err(|_| {
                    ApiHttpError::new("CONCURRENCY_UNAVAILABLE", "请求并发控制不可用")
                })?;
            let response = send_request(&state, request).await?;
            let status = response.status().as_u16();
            let headers = response_headers(&response);
            if on_event
                .send(ExternalHttpStreamEvent::Start { status, headers })
                .is_err()
            {
                return Ok(());
            }
            let mut received = 0usize;
            let mut stream = response.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|error| {
                    ApiHttpError::new("RESPONSE_READ_FAILED", error.to_string())
                })?;
                received = received.saturating_add(chunk.len());
                if received > MAX_RESPONSE_BODY_BYTES {
                    return Err(ApiHttpError::new(
                        "RESPONSE_BODY_TOO_LARGE",
                        "响应体超过 16 MiB 限制",
                    ));
                }
                if on_event
                    .send(ExternalHttpStreamEvent::Chunk {
                        data: chunk.to_vec(),
                    })
                    .is_err()
                {
                    return Ok(());
                }
            }
            let _ = on_event.send(ExternalHttpStreamEvent::End);
            Ok(())
        }
        .await;
        if let Err(error) = result {
            let _ = on_event.send(ExternalHttpStreamEvent::Error { error });
        }
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
            ExternalHttpRequest {
                url: format!("{origin}/redirect"),
                method: "GET".into(),
                headers: vec![],
                body: None,
                timeout_ms: Some(5_000),
            },
        )
        .await
        .unwrap();
        assert_eq!(response.status().as_u16(), 302);
        server.await.unwrap();
    }
}
