use super::*;

#[test]
fn file_reads_intersect_current_fsa_with_independent_scope_and_page_unicode() {
    let root = std::env::temp_dir().join(format!(
        "guanmo-mcp-server-read-{}-{}",
        std::process::id(),
        id()
    ));
    std::fs::create_dir_all(root.join("shared")).unwrap();
    std::fs::write(root.join("shared/note.MD"), "A😀BC").unwrap();
    std::fs::write(root.join("private.md"), "anonymous private fixture").unwrap();
    let root = root.canonicalize().unwrap();
    let state = crate::FsAccessState::default();
    state.workspaces.lock().unwrap().insert(root.clone());
    let shared = root.join("shared").canonicalize().unwrap();
    let scopes = vec![Scope {
        path: shared.to_string_lossy().into_owned(),
        directory: true,
    }];
    let cancel = CancellationToken::new();
    let args = || ReadDocument {
        path: shared.join("note.MD").to_string_lossy().into_owned(),
        offset: 1,
        max_chars: 1,
    };
    let content = read_document(&state, &scopes, args(), &cancel).unwrap();
    assert_eq!(content["content"], "😀");
    assert_eq!(content["totalChars"], 4);
    assert_eq!(content["nextOffset"], 2);
    assert_eq!(
        allowed_path_in_state(&state, &scopes, &root.join("private.md").to_string_lossy()).err(),
        Some("MCP_SERVER_SCOPE_REJECTED")
    );
    assert_eq!(
        allowed_path_in_state(
            &state,
            &scopes,
            &shared.join("../private.md").to_string_lossy()
        )
        .err(),
        Some("MCP_SERVER_SCOPE_REJECTED")
    );
    let no_scope = Vec::new();
    assert_eq!(
        read_document(&state, &no_scope, args(), &cancel).err(),
        Some("MCP_SERVER_SCOPE_REJECTED")
    );
    std::fs::write(
        shared.join("large.md"),
        vec![b'x'; MAX_DOCUMENT_BYTES as usize + 1],
    )
    .unwrap();
    assert_eq!(
        read_document(
            &state,
            &scopes,
            ReadDocument {
                path: shared.join("large.md").to_string_lossy().into_owned(),
                offset: 0,
                max_chars: 10
            },
            &cancel
        )
        .err(),
        Some("MCP_SERVER_FILE_READ_FAILED")
    );
    state.workspaces.lock().unwrap().clear();
    assert_eq!(
        read_document(&state, &scopes, args(), &cancel).err(),
        Some("MCP_SERVER_SCOPE_REJECTED")
    );
    cancel.cancel();
    assert_eq!(
        read_document(&state, &scopes, args(), &cancel).err(),
        Some("MCP_SERVER_STOPPED")
    );
}

#[tokio::test]
async fn stale_stop_and_query_cleanup_cannot_cancel_a_new_generation() {
    shutdown();
    let cancel = CancellationToken::new();
    let (sender, receiver) = oneshot::channel();
    {
        let mut runtime = RUNTIME.lock().unwrap();
        runtime.starting = Some(("new-generation".into(), cancel.clone()));
        runtime.queries.insert(
            "same-request".into(),
            PendingQuery {
                generation: "new-generation".into(),
                name: "search_knowledge".into(),
                arguments: json!({}),
                scopes: vec![],
                keys: vec![],
                sender,
            },
        );
    }
    let guard = PendingGuard {
        request_id: "same-request".into(),
        generation: "old-generation".into(),
    };
    drop(guard);
    mcp_server_stop(Some("old-generation".into()))
        .await
        .unwrap();
    assert!(!cancel.is_cancelled());
    assert_eq!(RUNTIME.lock().unwrap().queries.len(), 1);
    mcp_server_stop(Some("new-generation".into()))
        .await
        .unwrap();
    assert!(cancel.is_cancelled());
    assert_eq!(receiver.await.unwrap().err(), Some("MCP_SERVER_STOPPED"));
    let status = serde_json::to_value(mcp_server_status().unwrap()).unwrap();
    assert_eq!(status["running"], false);
    assert_eq!(status["starting"], false);
    assert!(status.get("token").is_none());
}
