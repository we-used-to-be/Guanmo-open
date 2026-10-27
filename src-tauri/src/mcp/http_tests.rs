use super::*;
use serde_json::json;
use tokio::io::{AsyncBufReadExt, BufReader};

async fn fixture(mode: &str) -> (tokio::process::Child, Url) {
    let mut command = tokio::process::Command::new(
        std::env::var("MCP_TEST_NODE").expect("MCP_TEST_NODE required"),
    );
    command
        .args(["-e", include_str!("http-fixture.cjs"), mode])
        .env_clear();
    for name in ["SystemRoot", "WINDIR", "TEMP", "TMP"] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
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
    (child, endpoint(line.trim()).unwrap())
}

fn reserve_http(url: &Url) -> Arc<Session> {
    reserve_session(
        &mut RUNTIME.lock().unwrap(),
        &new_id("http"),
        &new_id("request"),
        url.as_str(),
    )
    .unwrap()
}

pub(crate) async fn verify() {
    let (mut persisted, persisted_url) = fixture("json").await;
    config::tests::verify_http_persistence(persisted_url.as_str()).await;
    persisted.kill().await.unwrap();
    assert!(
        crate::network_target::resolve_target(&Url::parse("http://[::1]:1234/mcp").unwrap())
            .await
            .unwrap()[0]
            .ip()
            .is_loopback()
    );
    for url in [
        "file:///tmp/a",
        "https://user:pass@example.com/mcp",
        "https://example.com/mcp?token=x",
        "https://example.com/#x",
        "http://example.com/\n",
        "http:\\example.com",
    ] {
        assert!(endpoint(url).is_err(), "{url}");
    }
    for url in [
        "http://0.0.0.0/mcp",
        "http://169.254.169.254/mcp",
        "http://[::]/mcp",
        "http://8.8.8.8/mcp",
    ] {
        assert!(
            ControlledClient::new(endpoint(url).unwrap(), CancellationToken::new())
                .await
                .is_err()
        );
    }
    for mode in ["json", "sse", "legacy"] {
        let (mut child, url) = fixture(mode).await;
        let s = start_http(reserve_http(&url), url.clone(), None)
            .await
            .unwrap();
        let catalog = list_catalog(&s).await.unwrap();
        assert_eq!(
            catalog.protocol_version,
            if mode == "legacy" {
                "2025-11-25"
            } else {
                "2026-07-28"
            }
        );
        assert_eq!(catalog.tools.len(), 4);
        let call = |name, args| super::super::tests::prepare(&s, &catalog, name, args);
        let p = claim(&call("echo", json!({"literal": "untrusted"}))).unwrap();
        let output = super::super::tests::text(execute(&p).await.unwrap());
        assert_eq!(output["calls"], 1);
        assert_eq!(output["authorization"], false);
        assert_eq!(output["args"]["literal"], "untrusted");
        if mode == "legacy" {
            assert_eq!(output["session"], "anonymous-session");
        }
        assert_eq!(
            execute(&claim(&call("error", json!({}))).unwrap())
                .await
                .unwrap()["isError"],
            true
        );
        let p = claim(&call("expire", json!({}))).unwrap();
        assert_eq!(
            execute(&p).await.err(),
            Some("MCP_CALL_FAILED_OUTCOME_UNKNOWN")
        );
        let output = super::super::tests::text(
            execute(&claim(&call("echo", json!({}))).unwrap())
                .await
                .unwrap(),
        );
        assert_eq!(
            output["calls"], 4,
            "404 must not reinitialize or replay tools/call"
        );
        let id = call("slow", json!({}));
        let p = claim(&id).unwrap();
        let cancel = async {
            tokio::time::sleep(Duration::from_millis(30)).await;
            mcp_cancel_call(id.clone()).unwrap();
        };
        let (result, _) = tokio::join!(execute(&p), cancel);
        assert_eq!(result.err(), Some("MCP_CANCELLED_OUTCOME_UNKNOWN"));
        tokio::time::sleep(Duration::from_millis(600)).await;
        let output = super::super::tests::text(
            execute(&claim(&call("echo", json!({"afterCancel": true}))).unwrap())
                .await
                .unwrap(),
        );
        assert_eq!(output["calls"], 6);
        assert_eq!(output["args"]["afterCancel"], true);
        let id = call("echo", json!({}));
        let p = claim(&id).unwrap();
        disconnect(&s.id).unwrap();
        assert!(s.cancel.is_cancelled());
        assert!(execute(&p).await.is_err());

        let client = ControlledClient::new(url.clone(), CancellationToken::new())
            .await
            .unwrap();
        let cleanup = ControlledClient::new(url.clone(), CancellationToken::new())
            .await
            .unwrap();
        cleanup.cancel.cancel();
        assert_eq!(
            cleanup
                .send(
                    url.as_str(),
                    Method::POST,
                    None,
                    None,
                    HashMap::new(),
                    Some(b"{}".to_vec())
                )
                .await
                .err()
                .unwrap()
                .to_string(),
            "Client error: MCP_CANCELLED"
        );
        cleanup
            .delete_session(
                url.as_str().into(),
                "anonymous-session".into(),
                None,
                HashMap::new(),
            )
            .await
            .unwrap();
        for (path, expected) in [
            ("/redirect", "MCP_HTTP_REDIRECT_REJECTED"),
            ("/auth", "MCP_HTTP_AUTH_REQUIRED"),
        ] {
            let mut target = url.clone();
            target.set_path(path);
            let c = ControlledClient::new(target.clone(), CancellationToken::new())
                .await
                .unwrap();
            assert_eq!(
                c.send(
                    target.as_str(),
                    Method::POST,
                    None,
                    None,
                    HashMap::new(),
                    Some(b"{}".to_vec())
                )
                .await
                .err()
                .unwrap()
                .to_string(),
                format!("Client error: {expected}")
            );
        }
        assert_eq!(
            client
                .send(
                    "http://elsewhere.invalid",
                    Method::POST,
                    None,
                    None,
                    HashMap::new(),
                    None
                )
                .await
                .err()
                .unwrap()
                .to_string(),
            "Client error: MCP_HTTP_TARGET_MISMATCH"
        );
        let mut changed = client.clone();
        changed.addresses = vec![];
        assert_eq!(
            changed
                .send(url.as_str(), Method::POST, None, None, HashMap::new(), None)
                .await
                .err()
                .unwrap()
                .to_string(),
            "Client error: MCP_HTTP_DNS_CHANGED"
        );
        let mut headers = HashMap::new();
        headers.insert(
            HeaderName::from_static("authorization"),
            HeaderValue::from_static("secret"),
        );
        assert_eq!(
            client
                .send(url.as_str(), Method::POST, None, None, headers, None)
                .await
                .err()
                .unwrap()
                .to_string(),
            "Client error: MCP_HTTP_HEADER_REJECTED"
        );
        client.requests.store(MAX_REQUESTS, Ordering::SeqCst);
        assert_eq!(
            client
                .send(url.as_str(), Method::POST, None, None, HashMap::new(), None)
                .await
                .err()
                .unwrap()
                .to_string(),
            "Client error: MCP_HTTP_SESSION_LIMIT"
        );
        assert_eq!(
            client
                .get_stream(url.as_str().into(), None, None, None, HashMap::new())
                .await
                .err()
                .unwrap()
                .to_string(),
            "Client error: MCP_HTTP_RESUME_DISABLED"
        );
        child.kill().await.unwrap();
        child.wait().await.unwrap();
    }
    for mode in ["cycle", "oversized", "oversized_sse"] {
        let (mut child, url) = fixture(mode).await;
        let s = start_http(reserve_http(&url), url, None).await.unwrap();
        assert!(list_catalog(&s).await.is_err());
        disconnect(&s.id).unwrap();
        child.kill().await.unwrap();
        child.wait().await.unwrap();
    }
    let (mut child, url) = fixture("json").await;
    let s = reserve_http(&url);
    s.cancel.cancel();
    assert!(start_http(s.clone(), url, None).await.is_err());
    assert!(!RUNTIME.lock().unwrap().sessions.contains_key(&s.id));
    child.kill().await.unwrap();
    child.wait().await.unwrap();
}
