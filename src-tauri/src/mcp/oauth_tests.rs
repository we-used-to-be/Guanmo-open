use super::*;

async fn verify_callback(query: &str, created_at: u64) -> AuthResult<Callback> {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let address = listener.local_addr().unwrap();
    let states = FlowStateStore::default();
    states.save("csrf", serde_json::from_value(serde_json::json!({
        "pkce_verifier": "anonymous-verifier", "csrf_token": "csrf",
        "expected_issuer": "https://auth.example", "require_issuer": true, "created_at": created_at
    })).unwrap()).await.unwrap();
    let query = query.to_owned();
    let client = async move {
        let mut stream = TcpStream::connect(address).await.unwrap();
        stream
            .write_all(
                format!(
                    "GET /oauth/callback/random?{query} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n\r\n",
                    address.port()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).await.unwrap();
        assert!(!String::from_utf8_lossy(&response).contains("anonymous-code"));
    };
    let (result, _) = tokio::join!(
        accept_callback(
            listener,
            "/oauth/callback/random".into(),
            states,
            "https://auth.example".into(),
            CancellationToken::new()
        ),
        client
    );
    result
}

#[tokio::test]
async fn callback_validates_issuer_state_and_expiry_even_for_provider_errors() {
    for query in [
        "code=anonymous-code&state=csrf",
        "error=denied&state=csrf",
        "code=anonymous-code&state=other&iss=https%3A%2F%2Fauth.example",
        "error=denied&state=csrf&iss=https%3A%2F%2Fevil.example",
    ] {
        assert_eq!(
            verify_callback(query, oauth_epoch()).await.err(),
            Some("MCP_OAUTH_CALLBACK_INVALID")
        );
    }
    assert_eq!(
        verify_callback(
            "code=anonymous-code&state=csrf&iss=https%3A%2F%2Fauth.example",
            oauth_epoch().saturating_sub(301)
        )
        .await
        .err(),
        Some("MCP_OAUTH_CALLBACK_INVALID")
    );
    assert_eq!(
        verify_callback(
            "error=denied&state=csrf&iss=https%3A%2F%2Fauth.example",
            oauth_epoch()
        )
        .await
        .err(),
        Some("MCP_OAUTH_PROVIDER_ERROR")
    );
    assert!(verify_callback(
        "code=anonymous-code&state=csrf&iss=https%3A%2F%2Fauth.example",
        oauth_epoch()
    )
    .await
    .is_ok());
}

async fn parse_request(
    method: &str,
    target: &str,
    host_override: Option<&str>,
) -> AuthResult<Callback> {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let address = listener.local_addr().unwrap();
    let host = host_override
        .map(str::to_owned)
        .unwrap_or_else(|| format!("127.0.0.1:{}", address.port()));
    let method = method.to_owned();
    let target = target.to_owned();
    let client = tokio::spawn(async move {
        let mut stream = TcpStream::connect(address).await.unwrap();
        stream
            .write_all(format!("{method} {target} HTTP/1.1\r\nHost: {host}\r\n\r\n").as_bytes())
            .await
            .unwrap();
    });
    let (mut stream, _) = listener.accept().await.unwrap();
    let route = "/oauth/callback/random";
    let result = read_callback(&mut stream, route, &format!("127.0.0.1:{}", address.port())).await;
    client.await.unwrap();
    result
}

#[tokio::test]
async fn callback_accepts_single_code_state_and_issuer() {
    let parsed = parse_request(
        "GET",
        "/oauth/callback/random?code=one-time&state=csrf&iss=https%3A%2F%2Fauth.example",
        None,
    )
    .await
    .unwrap();
    assert_eq!(parsed.code, "one-time");
    assert_eq!(parsed.state, "csrf");
    assert_eq!(parsed.issuer.as_deref(), Some("https://auth.example"));
    assert!(!parsed.is_error);
}

#[tokio::test]
async fn callback_rejects_duplicate_parameters_and_wrong_host() {
    assert_eq!(
        parse_request(
            "GET",
            "/oauth/callback/random?code=a&state=x&state=y&iss=https%3A%2F%2Fauth.example",
            None
        )
        .await
        .err(),
        Some("MCP_OAUTH_CALLBACK_INVALID"),
    );
    assert_eq!(
        parse_request(
            "GET",
            "/oauth/callback/random?code=a&state=x&iss=https%3A%2F%2Fauth.example",
            Some("evil.example")
        )
        .await
        .err(),
        Some("MCP_OAUTH_CALLBACK_INVALID"),
    );
}

#[tokio::test]
async fn callback_parser_preserves_missing_issuer_for_sdk_state_validation() {
    assert_eq!(
        parse_request("GET", "/oauth/callback/random?code=a&state=x", None)
            .await
            .unwrap()
            .issuer,
        None,
    );
    assert_eq!(
        parse_request(
            "POST",
            "/oauth/callback/random?code=a&state=x&iss=https%3A%2F%2Fauth.example",
            None
        )
        .await
        .err(),
        Some("MCP_OAUTH_CALLBACK_INVALID"),
    );
    assert_eq!(
        parse_request(
            "GET",
            "/oauth/callback/other?code=a&state=x&iss=https%3A%2F%2Fauth.example",
            None
        )
        .await
        .err(),
        Some("MCP_OAUTH_CALLBACK_INVALID"),
    );
}
