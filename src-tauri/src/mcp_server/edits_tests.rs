use super::*;

#[test]
fn proposal_requires_exact_hash_unique_snippet_and_bounded_result() {
    let args = |old: &str, new: &str| ProposalArgs {
        path: "unused.md".into(),
        expected_hash: content_hash("A😀BC"),
        old_text: old.into(),
        new_text: new.into(),
    };
    assert_eq!(
        replacement("A😀BC", &args("😀", "匿名")).unwrap(),
        "A匿名BC"
    );
    assert_eq!(
        replacement("changed", &args("😀", "new")).err(),
        Some("MCP_SERVER_EDIT_CONFLICT")
    );
    let duplicate = ProposalArgs {
        expected_hash: content_hash("abab"),
        ..args("ab", "new")
    };
    assert_eq!(
        replacement("abab", &duplicate).err(),
        Some("MCP_SERVER_EDIT_CONFLICT")
    );
    let overlapping = ProposalArgs {
        expected_hash: content_hash("aaa"),
        ..args("aa", "new")
    };
    assert_eq!(
        replacement("aaa", &overlapping).err(),
        Some("MCP_SERVER_EDIT_CONFLICT")
    );
    assert_eq!(
        replacement("A😀BC", &args("", "new")).err(),
        Some("MCP_SERVER_ARGUMENTS_INVALID")
    );
    assert_eq!(
        replacement("A😀BC", &args("😀", &"x".repeat(32769))).err(),
        Some("MCP_SERVER_ARGUMENTS_INVALID")
    );
}

#[test]
fn sealed_write_needs_approval_and_checks_current_file_scope_and_cancellation() {
    let root = std::env::temp_dir().join(format!("guanmo-mcp-edit-{}", id()));
    fs::create_dir_all(&root).unwrap();
    let root = root.canonicalize().unwrap();
    let path = root.join("anonymous.md");
    fs::write(&path, "before 😀").unwrap();
    let state = crate::FsAccessState::default();
    state.workspaces.lock().unwrap().insert(root.clone());
    let mut edit = Edit {
        id: id(),
        generation: "anonymous".into(),
        path: path.to_string_lossy().into_owned(),
        scopes: vec![Scope {
            path: root.to_string_lossy().into_owned(),
            directory: true,
        }],
        before: "before 😀".into(),
        after: "after 😀".into(),
        old_text: "before".into(),
        new_text: "after".into(),
        state: "pending",
        created: Instant::now(),
        cancel: CancellationToken::new(),
        recovery_files: vec![],
        undo_of: None,
    };
    assert_eq!(
        consume(&state, &mut edit).err(),
        Some("MCP_SERVER_EDIT_STATE_INVALID")
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), "before 😀");
    edit.state = "approved";
    consume(&state, &mut edit).unwrap();
    assert_eq!(edit.state, "written");
    assert_eq!(fs::read_to_string(&path).unwrap(), "after 😀");
    assert!(edit.recovery_files.is_empty());
    assert_eq!(
        consume(&state, &mut edit).err(),
        Some("MCP_SERVER_EDIT_STATE_INVALID")
    );
    edit.state = "approved";
    assert_eq!(
        consume(&state, &mut edit).err(),
        Some("MCP_SERVER_EDIT_CONFLICT")
    );
    assert_eq!(edit.state, "conflict");
    assert_eq!(fs::read_to_string(&path).unwrap(), "after 😀");
    fs::write(&path, &edit.before).unwrap();
    edit.state = "approved";
    state.workspaces.lock().unwrap().clear();
    assert_eq!(
        consume(&state, &mut edit).err(),
        Some("MCP_SERVER_SCOPE_REJECTED")
    );
    state.workspaces.lock().unwrap().insert(root.clone());
    edit.state = "approved";
    edit.cancel.cancel();
    assert_eq!(
        consume(&state, &mut edit).err(),
        Some("MCP_SERVER_EDIT_STATE_INVALID")
    );
    edit.cancel = CancellationToken::new();
    edit.created = Instant::now() - TTL;
    assert_eq!(
        consume(&state, &mut edit).err(),
        Some("MCP_SERVER_EDIT_STATE_INVALID")
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), "before 😀");
}

#[cfg(windows)]
#[test]
fn failed_os_replacement_keeps_recovery_files_and_is_never_claimed_written() {
    let root = std::env::temp_dir().join(format!("guanmo-mcp-edit-failure-{}", id()));
    fs::create_dir_all(&root).unwrap();
    let path = root.join("readonly.md");
    fs::write(&path, "original").unwrap();
    let mut permissions = fs::metadata(&path).unwrap().permissions();
    permissions.set_readonly(true);
    fs::set_permissions(&path, permissions.clone()).unwrap();
    let mut recovery = Vec::new();
    let outcome = replace_file(&path, "original", "replacement", &mut recovery);
    permissions.set_readonly(false);
    fs::set_permissions(&path, permissions).unwrap();
    assert_eq!(outcome.err(), Some("MCP_SERVER_EDIT_OUTCOME_UNKNOWN"));
    assert_eq!(fs::read_to_string(&path).unwrap(), "original");
    assert!(recovery.iter().any(|p| Path::new(p).exists()));
}
