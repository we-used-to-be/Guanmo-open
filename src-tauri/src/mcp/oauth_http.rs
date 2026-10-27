//! SDK OAuth network adapter. No default SDK HTTP client may send OAuth traffic.
//!
//! This module is the network foundation of 4B, not an authorization flow or IPC.
use super::*;
use rmcp::transport::auth::{OAuthHttpClient, OAuthHttpClientFuture, OAuthHttpRequest};
use url::Url;

/// The upstream auth implementation logs authorization codes/token responses at
/// debug level. Poll every SDK auth future without an application subscriber.
pub(super) async fn quiet<T>(future: impl std::future::Future<Output = T>) -> T {
    use tracing::instrument::WithSubscriber;
    future
        .with_subscriber(tracing::subscriber::NoSubscriber::default())
        .await
}

/// One authorization attempt owns these exact-target DNS pins and cancellation.
/// Each new discovered target needs native consent before any DNS or HTTP work.
pub(super) struct ControlledOAuthClient {
    approve: Arc<dyn Fn(Url) -> futures_util::future::BoxFuture<'static, Result<()>> + Send + Sync>,
    cancel: CancellationToken,
    targets: tokio::sync::Mutex<HashMap<String, http::ControlledClient>>,
}

impl ControlledOAuthClient {
    pub(super) fn new(app: tauri::AppHandle, cancel: CancellationToken) -> Self {
        let consent_cancel = cancel.clone();
        Self {
            approve: Arc::new(move |url| {
                let app = app.clone();
                let cancel = consent_cancel.clone();
                Box::pin(async move {
                    confirm(&app, format!("允许 MCP OAuth 请求此精确目标？\n\n{url}\n\n用于授权发现、客户端注册或令牌交换。此授权包含该目标解析出的本机/私网地址；公网仅 HTTPS。不跟随重定向，不使用系统代理，DNS 地址变化后终止授权。"), &cancel).await
                })
            }),
            cancel,
            targets: Default::default(),
        }
    }

    async fn execute_request(
        &self,
        request: ::http::Request<Vec<u8>>,
    ) -> Result<::http::Response<Vec<u8>>> {
        tokio::time::timeout(TIMEOUT, async {
            if self.cancel.is_cancelled() {
                return Err("MCP_CANCELLED");
            }
            let url = http::endpoint(&request.uri().to_string())?;
            // Reject before consent/DNS, rather than relying on the final sender.
            if !matches!(
                *request.method(),
                ::http::Method::GET | ::http::Method::POST
            ) || request.headers().iter().any(|(name, value)| {
                !matches!(name.as_str(), "accept" | "content-type")
                    && !(name == "mcp-protocol-version" && value == "2024-11-05")
            }) || request.body().len() > 1024 * 1024
            {
                return Err("MCP_OAUTH_REQUEST_REJECTED");
            }
            let mut targets = self.targets.try_lock().map_err(|_| "MCP_BUSY")?;
            if !targets.contains_key(url.as_str()) {
                if targets.len() >= 16 {
                    return Err("MCP_OAUTH_TARGET_LIMIT");
                }
                (self.approve)(url.clone()).await?;
                let client = http::ControlledClient::new(url.clone(), self.cancel.clone()).await?;
                targets.insert(url.to_string(), client);
            }
            let client = targets.get(url.as_str()).ok_or("MCP_STATE_ERROR")?;
            client.oauth_request(request).await
        })
        .await
        .unwrap_or(Err("MCP_OAUTH_TIMEOUT"))
    }
}

impl OAuthHttpClient for ControlledOAuthClient {
    fn execute(&self, request: OAuthHttpRequest) -> OAuthHttpClientFuture<'_> {
        // Always stop redirects, including when the SDK permits following them.
        // Raw statuses/body are needed for SDK discovery fallbacks and OAuth errors.
        Box::pin(async move {
            self.execute_request(request.request).await.map_err(|code| {
                Box::new(std::io::Error::other(code)) as rmcp::transport::auth::OAuthHttpClientError
            })
        })
    }
}

#[cfg(test)]
#[path = "oauth_http_tests.rs"]
pub(super) mod tests;
