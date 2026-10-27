use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

struct AnonymousBackend(AtomicUsize);

#[test]
fn old_server_config_defaults_to_no_write_tools() {
    let mut config: ServerConfig = serde_json::from_value(serde_json::json!({"paths":[],"artifactKeys":[],"readDocuments":true,"searchKnowledge":false,"readArtifacts":false})).unwrap();
    assert!(!config.write_documents);
    assert!(!tools(&config)
        .iter()
        .any(|t| t.name == "propose_document_edit"));
    config.write_documents = true;
    let list = tools(&config);
    assert!(list.iter().any(|t| t.name == "propose_document_edit"));
    assert!(!list
        .iter()
        .any(|t| t.name == "commit_document_edit" || t.name == "approve_document_edit"));
}
#[async_trait::async_trait]
impl Backend for AnonymousBackend {
    async fn call(&self, _: &str, arguments: Value) -> Result<Value> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(serde_json::json!({"content":"anonymous fixture", "arguments":arguments}))
    }
}

#[tokio::test]
async fn loopback_transport_authenticates_before_dispatch_and_stops_listener() {
    let backend = Arc::new(AnonymousBackend(AtomicUsize::new(0)));
    let config = ServerConfig {
        paths: vec![],
        artifact_keys: vec![],
        read_documents: true,
        search_knowledge: false,
        read_artifacts: false,
        write_documents: false,
    };
    let cancel = CancellationToken::new();
    let mut server = start(&config, backend.clone(), cancel.clone())
        .await
        .unwrap();
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    let mut meta = rmcp::model::RequestMetaObject::new();
    meta.set_protocol_version(rmcp::model::ProtocolVersion::V_2026_07_28);
    meta.set_client_info(Implementation::new("anonymous-external-client", "1"));
    meta.set_client_capabilities(rmcp::model::ClientCapabilities::default());
    let rpc = |method: &str, mut params: Value| {
        params["_meta"] = serde_json::to_value(&meta).unwrap();
        serde_json::json!({"jsonrpc":"2.0","id":1,"method":method,"params":params})
    };
    let post = |message: Value| {
        let request = client
            .post(&server.endpoint)
            .bearer_auth(&server.token)
            .header("accept", "application/json, text/event-stream")
            .header("mcp-protocol-version", "2026-07-28")
            .header("mcp-method", message["method"].as_str().unwrap())
            .json(&message);
        if let Some(name) = message["params"]["name"].as_str() {
            request.header("mcp-name", name)
        } else {
            request
        }
    };
    let discover = rpc("server/discover", serde_json::json!({}));
    assert_eq!(
        client
            .post(&server.endpoint)
            .json(&discover)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        post(discover.clone())
            .header("origin", "https://evil.example")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        post(discover.clone())
            .header("host", "evil.example")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(backend.0.load(Ordering::SeqCst), 0);
    let discovery: Value = post(discover).send().await.unwrap().json().await.unwrap();
    assert_eq!(
        discovery["result"]["_meta"]["io.modelcontextprotocol/serverInfo"]["name"], "guanmo",
        "{discovery}"
    );
    let catalog: Value = post(rpc("tools/list", serde_json::json!({})))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        catalog["result"]["tools"].as_array().unwrap().len(),
        1,
        "{catalog}"
    );
    let call: Value = post(rpc(
        "tools/call",
        serde_json::json!({"name":"read_document","arguments":{"path":"anonymous.md"}}),
    ))
    .send()
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    assert_eq!(
        call["result"]["structuredContent"]["content"], "anonymous fixture",
        "{call}"
    );
    assert_eq!(backend.0.load(Ordering::SeqCst), 1);
    let legacy: Value = client.post(&server.endpoint).bearer_auth(&server.token).header("accept", "application/json, text/event-stream").header("mcp-protocol-version", "2025-11-25").json(&serde_json::json!({"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"anonymous-legacy-client","version":"1"}}})).send().await.unwrap().json().await.unwrap();
    assert_eq!(
        legacy["result"]["protocolVersion"], "2025-11-25",
        "{legacy}"
    );
    let legacy_tools: Value = client
        .post(&server.endpoint)
        .bearer_auth(&server.token)
        .header("accept", "application/json, text/event-stream")
        .header("mcp-protocol-version", "2025-11-25")
        .json(&serde_json::json!({"jsonrpc":"2.0","id":3,"method":"tools/list","params":{}}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        legacy_tools["result"]["tools"].as_array().unwrap().len(),
        1,
        "{legacy_tools}"
    );
    assert_eq!(
        client
            .post(&server.endpoint)
            .bearer_auth(&server.token)
            .body(vec![b'x'; MAX_BODY + 1])
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
    cancel.cancel();
    (&mut server.task).await.unwrap();
    assert!(client.post(&server.endpoint).send().await.is_err());
}
