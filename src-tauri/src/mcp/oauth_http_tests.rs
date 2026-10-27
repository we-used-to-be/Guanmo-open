use super::*;
use rmcp::transport::auth::{AuthorizationManager, AuthorizationRequest, AuthorizationSession};
use tokio::io::{AsyncBufReadExt, BufReader};

fn request(url: &str) -> ::http::Request<Vec<u8>> {
    ::http::Request::builder().uri(url).body(vec![]).unwrap()
}

pub(crate) async fn verify() {
    let mut command = tokio::process::Command::new(std::env::var("MCP_TEST_NODE").unwrap());
    command
        .args(["-e", include_str!("oauth-fixture.cjs")])
        .env_clear();
    for key in ["SystemRoot", "WINDIR", "TEMP", "TMP"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut line = String::new();
    tokio::time::timeout(
        Duration::from_secs(5),
        BufReader::new(child.stdout.take().unwrap()).read_line(&mut line),
    )
    .await
    .unwrap()
    .unwrap();
    let resource = line.trim();
    let base = resource.trim_end_matches("/mcp");
    let cancel = CancellationToken::new();
    let adapter = Arc::new(ControlledOAuthClient {
        approve: Arc::new(|_| Box::pin(async { Ok(()) })),
        cancel: cancel.clone(),
        targets: Default::default(),
    });
    let mut manager = AuthorizationManager::new_with_oauth_http_client(resource, adapter.clone())
        .await
        .unwrap();
    let resolution = manager.resolve_metadata().await.unwrap();
    assert!(matches!(
        resolution.source,
        rmcp::transport::auth::AuthorizationMetadataSource::ProtectedResourceMetadata
    ));
    assert_eq!(resolution.metadata.issuer.as_deref(), Some(base));
    manager.set_metadata(resolution.metadata);
    let wrong = AuthorizationManager::new_with_oauth_http_client(
        format!("{base}/wrong-resource"),
        adapter.clone(),
    )
    .await
    .unwrap();
    assert!(wrong.resolve_metadata().await.is_err());
    let flow = AuthorizationSession::new(
        manager,
        AuthorizationRequest::new("http://127.0.0.1:54321/callback")
            .with_preregistered_client("anonymous-public")
            .with_initial_scope_selection(),
    )
    .await
    .unwrap_or_else(|_| panic!("anonymous OAuth initialization failed"));
    let url = Url::parse(&flow.auth_url).unwrap();
    let params: HashMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(params["resource"], resource);
    assert_eq!(params["code_challenge_method"], "S256");
    assert_eq!(params["redirect_uri"], "http://127.0.0.1:54321/callback");
    assert_eq!(params["scope"], "read");
    assert!(flow
        .handle_callback_with_issuer("anonymous-code", "wrong-state", Some(base))
        .await
        .is_err());
    assert!(flow
        .handle_callback_with_issuer(
            "anonymous-code",
            &params["state"],
            Some("https://wrong.example")
        )
        .await
        .is_err());
    assert!(flow
        .handle_callback_with_issuer("anonymous-code", &params["state"], None)
        .await
        .is_err());
    let stats = adapter
        .execute_request(request(&format!("{base}/stats")))
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(stats.body()).unwrap()["tokenCalls"],
        0
    );
    let token = flow
        .handle_callback_with_issuer("anonymous-code", &params["state"], Some(base))
        .await
        .unwrap();
    let token = serde_json::to_value(token).unwrap();
    assert_eq!(token["fixture_challenge"], params["code_challenge"]);
    assert!(flow
        .handle_callback_with_issuer("anonymous-code", &params["state"], Some(base))
        .await
        .is_err());
    let refreshed = serde_json::to_value(flow.auth_manager.refresh_token().await.unwrap()).unwrap();
    assert_eq!(refreshed["refresh_token"], "anonymous-refresh");
    assert_eq!(refreshed["access_token"], "anonymous-refreshed");
    let mut dynamic_manager =
        AuthorizationManager::new_with_oauth_http_client(resource, adapter.clone())
            .await
            .unwrap();
    let metadata = dynamic_manager.resolve_metadata().await.unwrap().metadata;
    dynamic_manager.set_metadata(metadata);
    let dynamic = AuthorizationSession::new(
        dynamic_manager,
        AuthorizationRequest::new("http://127.0.0.1:54321/callback")
            .with_client_name("Anonymous native fixture"),
    )
    .await
    .unwrap_or_else(|_| panic!("anonymous OAuth dynamic registration failed"));
    let dynamic_url = Url::parse(&dynamic.auth_url).unwrap();
    let dynamic_params: HashMap<_, _> = dynamic_url.query_pairs().into_owned().collect();
    assert_eq!(dynamic_params["client_id"], "anonymous-public");
    dynamic
        .handle_callback_with_issuer("anonymous-code", &dynamic_params["state"], Some(base))
        .await
        .unwrap();
    let stats = adapter
        .execute_request(request(&format!("{base}/stats")))
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(stats.body()).unwrap()["registrationCalls"],
        1
    );
    assert!(adapter
        .execute_request(request(&format!("{base}/redirect")))
        .await
        .is_err());
    assert!(adapter
        .execute_request(request(&format!("{base}/large")))
        .await
        .is_err());
    let mut headers = request(&format!("{base}/stats"));
    headers
        .headers_mut()
        .insert("authorization", "Bearer forbidden".parse().unwrap());
    assert_eq!(
        adapter.execute_request(headers).await.unwrap_err(),
        "MCP_OAUTH_REQUEST_REJECTED"
    );
    for target in [
        "http://169.254.169.254/token",
        "http://8.8.8.8/token",
        "https://example.com/token?secret=x",
    ] {
        assert!(adapter.execute_request(request(target)).await.is_err());
    }
    let pending = adapter.execute_request(request(&format!("{base}/wait")));
    let abort = async {
        tokio::time::sleep(Duration::from_millis(50)).await;
        cancel.cancel();
    };
    let (result, _) = tokio::join!(pending, abort);
    assert!(result.is_err());
    assert_eq!(
        adapter
            .execute_request(request(resource))
            .await
            .unwrap_err(),
        "MCP_CANCELLED"
    );
    child.kill().await.unwrap();
}
