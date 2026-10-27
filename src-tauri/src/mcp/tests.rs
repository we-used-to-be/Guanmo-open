use super::*;
use serde_json::json;

pub(super) fn fixture(mode: &str) -> StdioConfig {
    StdioConfig {
        server_id: new_id("fixture"),
        executable: std::env::var("MCP_TEST_NODE")
            .expect("Set MCP_TEST_NODE to an absolute installed node executable"),
        args: vec![
            "-e".into(),
            include_str!("stdio-fixture.cjs").into(),
            mode.into(),
        ],
        cwd: std::env::temp_dir().to_string_lossy().into_owned(),
    }
}

async fn open(mode: &str) -> Arc<Session> {
    let config = fixture(mode);
    config.validate().unwrap();
    RUNTIME
        .lock()
        .unwrap()
        .configs
        .insert(config.server_id.clone(), config.clone());
    start(
        reserve(&config, &new_id("request")).unwrap(),
        &config,
        &Default::default(),
    )
    .await
    .unwrap()
}

pub(super) fn prepare(s: &Session, catalog: &Catalog, name: &str, args: Value) -> String {
    mcp_prepare_call(PrepareCall {
        connection_id: s.id.clone(),
        catalog_revision: catalog.catalog_revision.clone(),
        tool_name: name.into(),
        arguments: args,
    })
    .unwrap()
    .proposal_id
}

pub(super) fn text(result: Value) -> Value {
    serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap()
}

#[cfg(windows)]
pub(super) fn alive(pid: u32) -> bool {
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
    };
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut code = 0;
        let success = GetExitCodeProcess(handle, &mut code);
        CloseHandle(handle);
        success != 0 && code == 259
    }
}

#[tokio::test]
async fn mcp_stdio_lifecycle_and_authorization_invariants() {
    // One sequential test owns the static MCP runtime. UI confirmation is deliberately
    // not mocked: execute is tested below the dialog, real Tauri consent remains separate.
    http::tests::verify().await;
    oauth_http::quiet(oauth_http::tests::verify()).await;
    config::tests::verify();
    config::tests::verify_oauth_storage();
    config::tests::verify_environment_and_revoke().await;
    let s = open("modern").await;
    let catalog = list_catalog(&s).await.unwrap();
    assert_eq!(catalog.protocol_version, "2026-07-28");
    assert_eq!(catalog.tools.len(), 5);
    assert_eq!(
        catalog.tools[0]["inputSchema"]["properties"]["nested"]["items"]["properties"]["value"]
            ["enum"],
        json!(["a", "b"])
    );
    let resources = list_remote_resources(&s).await.unwrap();
    assert_eq!(resources.resources[0]["uri"], "anon://fixture/one");
    ensure_resource_selected(&s, &resources.catalog_revision, "anon://fixture/one").unwrap();
    assert_eq!(
        request_resource(&s, "anon://fixture/one".into())
            .await
            .unwrap()["contents"][0]["text"],
        "anonymous fixture content"
    );
    assert_eq!(
        ensure_resource_selected(&s, &resources.catalog_revision, "file:///private/user.md").err(),
        Some("MCP_RESOURCE_CATALOG_CHANGED")
    );
    let prompts = list_remote_prompts(&s).await.unwrap();
    assert_eq!(prompts.prompts[0]["name"], "anonymous-prompt");
    ensure_prompt_selected(&s, &prompts.catalog_revision, "anonymous-prompt").unwrap();
    assert_eq!(
        request_prompt(&s, "anonymous-prompt".into(), json!({"topic":"sample"}))
            .await
            .unwrap()["messages"][0]["content"]["text"],
        "fixture:sample"
    );
    s.resource_epoch.fetch_add(1, Ordering::SeqCst);
    s.prompt_epoch.fetch_add(1, Ordering::SeqCst);
    assert_eq!(
        ensure_resource_selected(&s, &resources.catalog_revision, "anon://fixture/one").err(),
        Some("MCP_RESOURCE_CATALOG_CHANGED")
    );
    assert_eq!(
        ensure_prompt_selected(&s, &prompts.catalog_revision, "anonymous-prompt").err(),
        Some("MCP_PROMPT_CATALOG_CHANGED")
    );
    let config = RUNTIME.lock().unwrap().configs[&s.server_id].clone();
    assert!(reserve(&config, &new_id("request")).is_err());
    let args = json!({"nested": [{"value": "b"}], "literal": "$(echo injection); & |"});
    let id = prepare(&s, &catalog, "echo", args.clone());
    let p = claim(&id).unwrap();
    assert_eq!(claim(&id).err(), Some("MCP_PROPOSAL_USED"));
    let output = text(execute(&p).await.unwrap());
    assert_eq!(output["args"], args);
    assert_eq!(output["calls"], 1);
    assert_eq!(output["injected"], false);
    assert_eq!(output["nodeOptions"], false);
    let pid = output["pid"].as_u64().unwrap() as u32;
    let descendant = output["descendantPid"].as_u64().unwrap() as u32;

    let id = prepare(&s, &catalog, "error", json!({}));
    let p = claim(&id).unwrap();
    assert_eq!(execute(&p).await.unwrap()["isError"], true);
    let id = prepare(&s, &catalog, "schema_error", json!({}));
    assert_eq!(
        execute(&claim(&id).unwrap()).await.err(),
        Some("MCP_CALL_FAILED_OUTCOME_UNKNOWN")
    );

    let id = prepare(&s, &catalog, "echo", json!({}));
    let stale = claim(&id).unwrap();
    let refreshed = list_catalog(&s).await.unwrap();
    assert_ne!(catalog.catalog_revision, refreshed.catalog_revision);
    assert_eq!(execute(&stale).await.err(), Some("MCP_CATALOG_CHANGED"));

    let id = prepare(&s, &refreshed, "slow", json!({}));
    let p = claim(&id).unwrap();
    let cancellation = async {
        tokio::time::sleep(Duration::from_millis(50)).await;
        mcp_cancel_call(id.clone()).unwrap();
    };
    let (result, _) = tokio::join!(execute(&p), cancellation);
    assert_eq!(result.err(), Some("MCP_CANCELLED_OUTCOME_UNKNOWN"));
    // Give the cancelled request time to return late; a later request must not take its result.
    tokio::time::sleep(Duration::from_millis(600)).await;
    let id = prepare(&s, &refreshed, "echo", json!({"afterCancel": true}));
    let output = text(execute(&claim(&id).unwrap()).await.unwrap());
    assert_eq!(output["args"]["afterCancel"], true);
    assert_eq!(output["cancelled"], 1);

    let id = prepare(&s, &refreshed, "change", json!({}));
    assert_eq!(
        execute(&claim(&id).unwrap()).await.err(),
        Some("MCP_CATALOG_CHANGED")
    );
    let final_catalog = list_catalog(&s).await.unwrap();
    let id = prepare(&s, &final_catalog, "echo", json!({}));
    let disconnected = claim(&id).unwrap();
    disconnect(&s.id).unwrap();
    assert_eq!(execute(&disconnected).await.err(), Some("MCP_CANCELLED"));
    #[cfg(windows)]
    {
        tokio::time::timeout(Duration::from_secs(5), async {
            while alive(pid) || alive(descendant) {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("MCP process tree leaked on disconnect");
    }
    #[cfg(not(windows))]
    let _ = (pid, descendant);

    let legacy = open("legacy").await;
    assert_eq!(
        list_catalog(&legacy).await.unwrap().protocol_version,
        "2025-11-25"
    );
    disconnect(&legacy.id).unwrap();
    for (mode, expected) in [
        ("cycle", "MCP_CURSOR_INVALID"),
        ("duplicate", "MCP_CATALOG_INVALID"),
    ] {
        let bad = open(mode).await;
        assert_eq!(list_catalog(&bad).await.err(), Some(expected));
        disconnect(&bad.id).unwrap();
    }
    let mut invalid = fixture("modern");
    invalid.executable = "node".into();
    assert_eq!(invalid.validate().err(), Some("MCP_CONFIG_INVALID"));
    invalid = fixture("modern");
    invalid.args = vec!["a\0b".into()];
    assert_eq!(invalid.validate().err(), Some("MCP_CONFIG_INVALID"));
    let config = fixture("silent");
    RUNTIME
        .lock()
        .unwrap()
        .configs
        .insert(config.server_id.clone(), config.clone());
    let old_request = new_id("request");
    let pending = reserve(&config, &old_request).unwrap();
    mcp_cancel_connect(old_request.clone()).unwrap();
    assert_eq!(
        start(pending, &config, &Default::default())
            .await
            .err()
            .map(|_| "cancelled"),
        Some("cancelled")
    );
    let new_request = new_id("request");
    let pending = reserve(&config, &new_request).unwrap();
    mcp_cancel_connect(old_request).unwrap();
    assert!(
        !pending.cancel.is_cancelled(),
        "old cancel must not cancel a new generation"
    );
    let cancellation = async {
        tokio::time::sleep(Duration::from_millis(50)).await;
        mcp_cancel_connect(new_request.clone()).unwrap();
    };
    let env = Default::default();
    let (result, _) = tokio::join!(start(pending, &config, &env), cancellation);
    assert!(result.is_err());

    let crashed = open("crash").await;
    let catalog = list_catalog(&crashed).await.unwrap();
    let id = prepare(&crashed, &catalog, "echo", json!({}));
    let output = text(execute(&claim(&id).unwrap()).await.unwrap());
    let crash_pid = output["pid"].as_u64().unwrap() as u32;
    let crash_descendant = output["descendantPid"].as_u64().unwrap() as u32;
    let id = prepare(&crashed, &catalog, "slow", json!({}));
    assert_eq!(
        execute(&claim(&id).unwrap()).await.err(),
        Some("MCP_CALL_FAILED_OUTCOME_UNKNOWN")
    );
    #[cfg(windows)]
    tokio::time::timeout(Duration::from_secs(5), async {
        while alive(crash_pid) || alive(crash_descendant) {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("MCP process tree leaked after unexpected server exit");
    #[cfg(not(windows))]
    let _ = (crash_pid, crash_descendant);
    disconnect(&crashed.id).unwrap();

    let timed = open("timeout").await;
    let catalog = list_catalog(&timed).await.unwrap();
    let id = prepare(&timed, &catalog, "slow", json!({}));
    assert_eq!(
        execute(&claim(&id).unwrap()).await.err(),
        Some("MCP_CALL_TIMEOUT_OUTCOME_UNKNOWN")
    );
    let id = prepare(&timed, &catalog, "echo", json!({"afterTimeout": true}));
    let output = text(execute(&claim(&id).unwrap()).await.unwrap());
    assert_eq!(output["args"]["afterTimeout"], true);
    assert_eq!(output["calls"], 2, "timed-out calls must not be retried");
    let shutdown_pid = output["pid"].as_u64().unwrap() as u32;
    let shutdown_descendant = output["descendantPid"].as_u64().unwrap() as u32;
    shutdown();
    assert!(RUNTIME.lock().unwrap().sessions.is_empty());
    assert!(RUNTIME.lock().unwrap().proposals.is_empty());
    #[cfg(windows)]
    tokio::time::timeout(Duration::from_secs(5), async {
        while alive(shutdown_pid) || alive(shutdown_descendant) {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("MCP process tree leaked on runtime shutdown");
    #[cfg(not(windows))]
    let _ = (shutdown_pid, shutdown_descendant);
}
