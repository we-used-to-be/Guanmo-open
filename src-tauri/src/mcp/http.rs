//! Controlled HTTP transport. OAuth is a separate client step.
use super::*;
use ::http::{HeaderName, HeaderValue};
use futures_util::{stream::BoxStream, StreamExt};
use reqwest::{Client, Method, Response, Url};
use rmcp::transport::auth::AuthorizationManager;
use rmcp::{
    model::{ClientJsonRpcMessage, ClientRequest, ErrorData, ServerJsonRpcMessage},
    transport::{
        common::client_side_sse::SseRetryPolicy,
        streamable_http_client::{
            StreamableHttpClient, StreamableHttpClientTransportConfig, StreamableHttpError,
            StreamableHttpPostResponse,
        },
        StreamableHttpClientTransport,
    },
};
use sse_stream::{Sse, SseStream};
use std::{io, net::SocketAddr};

const MAX_BODY: usize = 1024 * 1024;
const MAX_SESSION_BYTES: u64 = 64 * 1024 * 1024;
const MAX_REQUESTS: u64 = 1000;
// Separate MCP accounting, using the existing policy. Reconnect never resets it.
static USAGE: LazyLock<Mutex<crate::api_http_limits::ApiUsage>> =
    LazyLock::new(|| Mutex::new(Default::default()));
static NETWORK_SLOTS: LazyLock<Arc<tokio::sync::Semaphore>> =
    LazyLock::new(|| Arc::new(tokio::sync::Semaphore::new(8)));
type HttpResult<T> = std::result::Result<T, StreamableHttpError<io::Error>>;

struct LeasedResponse {
    inner: Response,
    slot: tokio::sync::OwnedSemaphorePermit,
}
impl std::ops::Deref for LeasedResponse {
    type Target = Response;
    fn deref(&self) -> &Response {
        &self.inner
    }
}

fn failure(code: &'static str) -> StreamableHttpError<io::Error> {
    StreamableHttpError::Client(io::Error::other(code))
}

pub(super) fn endpoint(value: &str) -> Result<Url> {
    if value.len() > 4096 || value.chars().any(char::is_control) || value.contains('\\') {
        return Err("MCP_HTTP_URL_INVALID");
    }
    let url = Url::parse(value).map_err(|_| "MCP_HTTP_URL_INVALID")?;
    if !matches!(url.scheme(), "https" | "http")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("MCP_HTTP_URL_INVALID");
    }
    Ok(url)
}

#[derive(Clone)]
pub(super) struct ControlledClient {
    url: Url,
    addresses: Vec<SocketAddr>,
    cancel: CancellationToken,
    requests: Arc<AtomicU64>,
    bytes: Arc<AtomicU64>,
    stream_started: Arc<std::sync::atomic::AtomicBool>,
    authorization: Option<Arc<AuthorizationManager>>,
}

impl ControlledClient {
    pub(super) async fn new(url: Url, cancel: CancellationToken) -> Result<Self> {
        let mut addresses = crate::network_target::resolve_target(&url)
            .await
            .map_err(|_| "MCP_HTTP_TARGET_REJECTED")?;
        addresses.sort_unstable();
        addresses.dedup();
        Ok(Self {
            url,
            addresses,
            cancel,
            requests: Arc::new(AtomicU64::new(0)),
            bytes: Arc::new(AtomicU64::new(0)),
            stream_started: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            authorization: None,
        })
    }

    pub(super) async fn new_authorized(
        url: Url,
        cancel: CancellationToken,
        authorization: Arc<AuthorizationManager>,
    ) -> Result<Self> {
        let mut client = Self::new(url, cancel).await?;
        client.authorization = Some(authorization);
        Ok(client)
    }

    async fn send(
        &self,
        uri: &str,
        method: Method,
        session: Option<&str>,
        auth: Option<String>,
        headers: HashMap<HeaderName, HeaderValue>,
        body: Option<Vec<u8>>,
    ) -> HttpResult<LeasedResponse> {
        let bearer = if let Some(manager) = &self.authorization {
            Some(
                oauth_http::quiet(manager.get_access_token())
                    .await
                    .map_err(|_| failure("MCP_OAUTH_REFRESH_FAILED"))?,
            )
        } else {
            None
        };
        self.send_inner(uri, method, session, auth, headers, body, false, bearer)
            .await
    }

    // Only the SDK OAuth adapter calls this path; it is not an IPC HTTP proxy.
    pub(super) async fn oauth_request(
        &self,
        request: ::http::Request<Vec<u8>>,
    ) -> Result<::http::Response<Vec<u8>>> {
        let (parts, body) = request.into_parts();
        if !matches!(parts.method, Method::GET | Method::POST) {
            return Err("MCP_OAUTH_METHOD_REJECTED");
        }
        let mut headers = HashMap::new();
        for (name, value) in &parts.headers {
            if !matches!(name.as_str(), "accept" | "content-type")
                && !(name == "mcp-protocol-version" && value == "2024-11-05")
            {
                return Err("MCP_OAUTH_HEADER_REJECTED");
            }
            headers.insert(name.clone(), value.clone());
        }
        let response = self
            .send_inner(
                &parts.uri.to_string(),
                parts.method,
                None,
                None,
                headers,
                (!body.is_empty()).then_some(body),
                true,
                None,
            )
            .await
            .map_err(|_| "MCP_OAUTH_NETWORK_FAILED")?;
        let status = response.status();
        let headers = response.headers().clone();
        let body = self
            .body(response)
            .await
            .map_err(|_| "MCP_OAUTH_RESPONSE_REJECTED")?;
        if status.is_redirection() {
            return Err("MCP_HTTP_REDIRECT_REJECTED");
        }
        let mut output = ::http::Response::builder().status(status);
        *output.headers_mut().ok_or("MCP_STATE_ERROR")? = headers;
        output.body(body).map_err(|_| "MCP_OAUTH_RESPONSE_REJECTED")
    }

    #[allow(clippy::too_many_arguments)]
    async fn send_inner(
        &self,
        uri: &str,
        method: Method,
        session: Option<&str>,
        auth: Option<String>,
        headers: HashMap<HeaderName, HeaderValue>,
        body: Option<Vec<u8>>,
        oauth: bool,
        bearer: Option<String>,
    ) -> HttpResult<LeasedResponse> {
        // SDK shutdown may delete its remote session after local revocation.
        // It may not send another protocol POST after that revocation.
        let cleanup = method == Method::DELETE;
        if uri != self.url.as_str() || auth.is_some() {
            return Err(failure("MCP_HTTP_TARGET_MISMATCH"));
        }
        if self.cancel.is_cancelled() && !cleanup {
            return Err(failure("MCP_CANCELLED"));
        }
        if body.as_ref().is_some_and(|v| v.len() > MAX_BODY) {
            return Err(failure("MCP_HTTP_REQUEST_LIMIT"));
        }
        if self.requests.fetch_add(1, Ordering::SeqCst) >= MAX_REQUESTS
            || self.bytes.load(Ordering::SeqCst) >= MAX_SESSION_BYTES
        {
            return Err(failure("MCP_HTTP_SESSION_LIMIT"));
        }
        let slot = NETWORK_SLOTS
            .clone()
            .try_acquire_owned()
            .map_err(|_| failure("MCP_HTTP_BUSY"))?;
        USAGE
            .lock()
            .map_err(|_| failure("MCP_STATE_ERROR"))?
            .admit(&self.url.origin().ascii_serialization(), Instant::now())
            .map_err(|code| {
                failure(if code == "RATE_LIMIT_EXCEEDED" {
                    "MCP_HTTP_RATE_LIMIT"
                } else {
                    "MCP_HTTP_SESSION_LIMIT"
                })
            })?;
        let mut addresses = crate::network_target::resolve_target(&self.url)
            .await
            .map_err(|_| failure("MCP_HTTP_TARGET_REJECTED"))?;
        addresses.sort_unstable();
        addresses.dedup();
        if addresses != self.addresses {
            return Err(failure("MCP_HTTP_DNS_CHANGED"));
        }
        let host = self
            .url
            .host_str()
            .ok_or_else(|| failure("MCP_HTTP_URL_INVALID"))?
            .trim_matches(['[', ']']);
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .timeout(TIMEOUT)
            .resolve_to_addrs(host, &self.addresses)
            .build()
            .map_err(|_| failure("MCP_HTTP_CLIENT_FAILED"))?;
        let mut request = client
            .request(method, self.url.clone())
            .header("Accept", "application/json, text/event-stream");
        for (name, value) in headers {
            if !oauth && (!name.as_str().starts_with("mcp-") || name == "mcp-session-id") {
                return Err(failure("MCP_HTTP_HEADER_REJECTED"));
            }
            request = request.header(name, value);
        }
        if let Some(session) = session {
            if session.is_empty() || session.len() > 1024 {
                return Err(failure("MCP_HTTP_SESSION_INVALID"));
            }
            request = request.header("Mcp-Session-Id", session);
        }
        if let Some(token) = bearer {
            request = request.bearer_auth(token);
        }
        if let Some(body) = body {
            if !oauth {
                request = request.header("Content-Type", "application/json");
            }
            request = request.body(body);
        }
        let response = tokio::select! {
            _ = self.cancel.cancelled(), if !cleanup => return Err(failure("MCP_CANCELLED")),
            result = request.send() => result.map_err(|_| failure("MCP_HTTP_NETWORK_FAILED"))?,
        };
        if !oauth && response.status().is_redirection() {
            return Err(failure("MCP_HTTP_REDIRECT_REJECTED"));
        }
        if !oauth && matches!(response.status().as_u16(), 401 | 403) {
            return Err(failure(if self.authorization.is_some() {
                "MCP_OAUTH_AUTHORIZATION_REQUIRED"
            } else {
                "MCP_HTTP_AUTH_REQUIRED"
            }));
        }
        Ok(LeasedResponse {
            inner: response,
            slot,
        })
    }

    fn stream(
        &self,
        response: LeasedResponse,
    ) -> BoxStream<'static, std::result::Result<bytes::Bytes, io::Error>> {
        let bytes = self.bytes.clone();
        let cancel = self.cancel.clone();
        futures_util::stream::unfold((response.inner.bytes_stream(), 0usize, false, response.slot), move |(mut stream, mut received, failed, slot)| {
            let bytes = bytes.clone(); let cancel = cancel.clone();
            async move {
                if failed { return None; }
                let result = tokio::select! {
                    _ = cancel.cancelled() => Some(Err(io::Error::other("MCP_CANCELLED"))),
                    next = stream.next() => next.map(|chunk| chunk.map_err(|_| io::Error::other("MCP_HTTP_BODY_FAILED"))),
                }?;
                let result = result.and_then(|chunk| {
                    received = received.saturating_add(chunk.len());
                    let total = bytes.fetch_add(chunk.len() as u64, Ordering::SeqCst).saturating_add(chunk.len() as u64);
                    USAGE.lock().map_err(|_| io::Error::other("MCP_STATE_ERROR"))?.receive(chunk.len()).map_err(|_| io::Error::other("MCP_HTTP_SESSION_LIMIT"))?;
                    if received > MAX_BODY || total > MAX_SESSION_BYTES { Err(io::Error::other("MCP_HTTP_RESPONSE_LIMIT")) } else { Ok(chunk) }
                });
                let failed = result.is_err();
                Some((result, (stream, received, failed, slot)))
            }
        }).boxed()
    }

    async fn body(&self, response: LeasedResponse) -> HttpResult<Vec<u8>> {
        let mut output = Vec::new();
        let mut stream = self.stream(response);
        while let Some(chunk) = stream.next().await {
            output.extend_from_slice(&chunk.map_err(StreamableHttpError::Client)?);
        }
        Ok(output)
    }
}

impl StreamableHttpClient for ControlledClient {
    type Error = io::Error;
    async fn post_message(
        &self,
        uri: Arc<str>,
        message: ClientJsonRpcMessage,
        session: Option<Arc<str>>,
        auth: Option<String>,
        headers: HashMap<HeaderName, HeaderValue>,
    ) -> HttpResult<StreamableHttpPostResponse> {
        let body = serde_json::to_vec(&message).map_err(|_| failure("MCP_HTTP_REQUEST_INVALID"))?;
        let response = self
            .send(
                &uri,
                Method::POST,
                session.as_deref(),
                auth,
                headers,
                Some(body),
            )
            .await?;
        let status = response.status();
        if status.as_u16() == 202 {
            return Ok(StreamableHttpPostResponse::Accepted);
        }
        let sid = response
            .headers()
            .get("mcp-session-id")
            .map(|v| v.to_str().map(str::to_owned))
            .transpose()
            .map_err(|_| failure("MCP_HTTP_SESSION_INVALID"))?;
        if sid.as_ref().is_some_and(|s| s.is_empty() || s.len() > 1024) {
            return Err(failure("MCP_HTTP_SESSION_INVALID"));
        }
        let mime = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if status.is_success() && mime == "text/event-stream" {
            // Total raw response <= 1 MiB also bounds every raw SSE event, including comments.
            return Ok(StreamableHttpPostResponse::Sse(
                SseStream::from_bytes_stream(self.stream(response)).boxed(),
                sid,
            ));
        }
        let body = self.body(response).await?;
        if !status.is_success() {
            // Only discovery 4xx can trigger legacy negotiation. Never re-send a tool call.
            if session.is_none()
                && status.is_client_error()
                && matches!(&message, ClientJsonRpcMessage::Request(r) if matches!(r.request, ClientRequest::DiscoverRequest(_)))
            {
                let ClientJsonRpcMessage::Request(request) = message else {
                    unreachable!()
                };
                let error = match serde_json::from_slice::<ServerJsonRpcMessage>(&body) {
                    Ok(ServerJsonRpcMessage::Error(e)) => e.error,
                    _ => ErrorData::invalid_request("Discovery unsupported", None),
                };
                return Ok(StreamableHttpPostResponse::Json(
                    ServerJsonRpcMessage::error(error, Some(request.id)),
                    None,
                ));
            }
            return Err(failure("MCP_HTTP_STATUS_REJECTED"));
        }
        if body.is_empty() && matches!(message, ClientJsonRpcMessage::Notification(_)) {
            return Ok(StreamableHttpPostResponse::Accepted);
        }
        if mime != "application/json" {
            return Err(failure("MCP_HTTP_CONTENT_TYPE_REJECTED"));
        }
        let parsed =
            serde_json::from_slice(&body).map_err(|_| failure("MCP_HTTP_RESPONSE_INVALID"))?;
        Ok(StreamableHttpPostResponse::Json(parsed, sid))
    }

    async fn delete_session(
        &self,
        uri: Arc<str>,
        session: Arc<str>,
        auth: Option<String>,
        headers: HashMap<HeaderName, HeaderValue>,
    ) -> HttpResult<()> {
        let response = self
            .send(&uri, Method::DELETE, Some(&session), auth, headers, None)
            .await?;
        if response.status().is_success() || matches!(response.status().as_u16(), 404 | 405) {
            Ok(())
        } else {
            Err(failure("MCP_HTTP_STATUS_REJECTED"))
        }
    }

    async fn get_stream(
        &self,
        uri: Arc<str>,
        session: Option<Arc<str>>,
        last_event: Option<String>,
        auth: Option<String>,
        headers: HashMap<HeaderName, HeaderValue>,
    ) -> HttpResult<BoxStream<'static, std::result::Result<Sse, sse_stream::Error>>> {
        if session.is_none()
            || last_event.is_some()
            || self.stream_started.swap(true, Ordering::SeqCst)
        {
            return Err(failure("MCP_HTTP_RESUME_DISABLED"));
        }
        let response = self
            .send(&uri, Method::GET, session.as_deref(), auth, headers, None)
            .await?;
        if response.status().as_u16() == 405 {
            return Err(StreamableHttpError::ServerDoesNotSupportSse);
        }
        if !response.status().is_success()
            || !response
                .headers()
                .get("content-type")
                .is_some_and(|v| v.as_bytes().starts_with(b"text/event-stream"))
        {
            return Err(failure("MCP_HTTP_STREAM_REJECTED"));
        }
        Ok(SseStream::from_bytes_stream(self.stream(response)).boxed())
    }
}

#[derive(Debug)]
struct NoRetry;
impl SseRetryPolicy for NoRetry {
    fn retry(&self, _: usize) -> Option<Duration> {
        None
    }
}

pub(super) async fn start_http(
    s: Arc<Session>,
    url: Url,
    authorization: Option<Arc<AuthorizationManager>>,
) -> Result<Arc<Session>> {
    let result = tokio::time::timeout(TIMEOUT, async {
        let client = match authorization {
            Some(manager) => {
                ControlledClient::new_authorized(url.clone(), s.cancel.clone(), manager).await?
            }
            None => ControlledClient::new(url.clone(), s.cancel.clone()).await?,
        };
        let mut config = StreamableHttpClientTransportConfig::with_uri(url.as_str())
            .max_concurrent_requests(1)
            .reinit_on_expired_session(false)
            .max_sse_event_size(MAX_BODY);
        config.retry_config = Arc::new(NoRetry);
        let transport = StreamableHttpClientTransport::with_client(client, config);
        let running = rmcp::service::serve_client_with_lifecycle_and_ct(
            Handler {
                epoch: s.epoch.clone(),
                resource_epoch: s.resource_epoch.clone(),
                prompt_epoch: s.prompt_epoch.clone(),
            },
            transport,
            rmcp::service::ClientLifecycleMode::Auto {
                preferred_versions: vec![
                    ProtocolVersion::V_2026_07_28,
                    ProtocolVersion::V_2025_11_25,
                ],
                legacy_version: Some(ProtocolVersion::V_2025_11_25),
            },
            s.cancel.clone(),
        )
        .await
        .map_err(|_| "MCP_INITIALIZE_FAILED")?;
        if s.cancel.is_cancelled() {
            return Err("MCP_CANCELLED");
        }
        *s.client.lock().map_err(|_| "MCP_STATE_ERROR")? = Some(Arc::new(running));
        Ok(())
    })
    .await
    .unwrap_or(Err("MCP_CONNECT_TIMEOUT"));
    if let Err(error) = result {
        let _ = disconnect(&s.id);
        return Err(error);
    }
    Ok(s)
}

/// Ephemeral 4A transport API. No headers/credentials, no persistence, no browser proxy.
#[tauri::command]
pub async fn mcp_connect_http(
    app: tauri::AppHandle,
    url: String,
    request_id: String,
) -> Result<Catalog> {
    let url = endpoint(&url)?;
    let app_config = app.clone();
    let target = url.as_str().to_owned();
    let s = tauri::async_runtime::spawn_blocking(move || {
        let _guard = config::CONFIG_LOCK.lock().map_err(|_| "MCP_STATE_ERROR")?;
        config::reserve_http(&config::path(&app_config)?, &request_id, &target)
    })
    .await
    .map_err(|_| "MCP_CONFIG_READ_FAILED")??;
    let result = async {
        confirm(&app, format!("连接外部 MCP 服务（本次运行有效）？\n\n端点：{url}\n\n将向此精确端点发送 MCP 协议请求。该授权也适用于端点解析出的本机/私网地址；公网仅允许 HTTPS。无凭据，不跟随重定向，DNS 地址变化后需重新连接。工具调用仍逐项确认；断线或未知结果不会自动重试。"), &s.cancel).await?;
        let s = start_http(s.clone(), url, None).await?;
        list_catalog(&s).await
    }.await;
    if result.is_err() {
        let _ = disconnect(&s.id);
    }
    result
}

#[cfg(test)]
#[path = "http_tests.rs"]
pub(super) mod tests;
