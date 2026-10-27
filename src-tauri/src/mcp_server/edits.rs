//! Sealed, one-shot edits. The external transport can propose/cancel/query only.
use super::*;
use sha2::{Digest, Sha256};
use std::{fs, io::Write, time::Instant};

const TTL: Duration = Duration::from_secs(300);
const MAX_EDITS: usize = 8;
static EDITS: LazyLock<Mutex<HashMap<String, Edit>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Clone)]
struct Edit {
    id: String,
    generation: String,
    path: String,
    scopes: Vec<Scope>,
    before: String,
    after: String,
    old_text: String,
    new_text: String,
    state: &'static str,
    created: Instant,
    cancel: CancellationToken,
    recovery_files: Vec<String>,
    undo_of: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProposalArgs {
    path: String,
    expected_hash: String,
    old_text: String,
    new_text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProposalId {
    proposal_id: String,
}

pub(super) fn content_hash(content: &str) -> String {
    format!("{:x}", Sha256::digest(content.as_bytes()))
}

fn prune(edits: &mut HashMap<String, Edit>) {
    for edit in edits.values_mut() {
        if edit.created.elapsed() >= TTL
            && matches!(
                edit.state,
                "preparing" | "pending" | "confirming" | "approved"
            )
        {
            edit.state = "expired";
            edit.cancel.cancel();
        }
    }
    edits.retain(|_, edit| edit.created.elapsed() < TTL * 2 || edit.state == "committing");
}

fn live(edit: &Edit) -> Result<()> {
    let runtime = RUNTIME.lock().map_err(|_| "MCP_SERVER_STATE_ERROR")?;
    if !runtime.active.as_ref().is_some_and(|a| {
        a.generation == edit.generation
            && a.config.write_documents
            && !a.network.cancel.is_cancelled()
    }) || edit.cancel.is_cancelled()
    {
        return Err("MCP_SERVER_STOPPED");
    }
    Ok(())
}

fn get(proposal_id: &str) -> Result<Edit> {
    let mut edits = EDITS.lock().map_err(|_| "MCP_SERVER_STATE_ERROR")?;
    prune(&mut edits);
    edits
        .get(proposal_id)
        .cloned()
        .ok_or("MCP_SERVER_PROPOSAL_MISSING_OR_EXPIRED")
}

fn summary(edit: &Edit) -> Value {
    json!({"proposalId":edit.id,"path":edit.path,"state":edit.state,"beforeHash":content_hash(&edit.before),"afterHash":content_hash(&edit.after)})
}

fn write_path(state: &crate::FsAccessState, scopes: &[Scope], path: &str) -> Result<PathBuf> {
    let canonical = allowed_path_in_state(state, scopes, path)?;
    crate::ensure_allowed_existing_text_file(state, &canonical, crate::FileAction::WriteText)
        .map_err(|_| "MCP_SERVER_SCOPE_REJECTED")
}

fn replacement(before: &str, args: &ProposalArgs) -> Result<String> {
    if args.old_text.is_empty()
        || args.old_text.len() > 32768
        || args.new_text.len() > 32768
        || args.old_text == args.new_text
        || args.expected_hash.len() != 64
    {
        return Err("MCP_SERVER_ARGUMENTS_INVALID");
    }
    if content_hash(before) != args.expected_hash
        || before.find(&args.old_text).is_none()
        || before.find(&args.old_text) != before.rfind(&args.old_text)
    {
        return Err("MCP_SERVER_EDIT_CONFLICT");
    }
    let after = before.replacen(&args.old_text, &args.new_text, 1);
    if after.len() as u64 > MAX_DOCUMENT_BYTES {
        return Err("MCP_SERVER_ARGUMENTS_INVALID");
    }
    Ok(after)
}

async fn publish(backend: &AppBackend, mut edit: Edit) -> Result<Value> {
    live(&edit)?;
    {
        let mut edits = EDITS.lock().map_err(|_| "MCP_SERVER_STATE_ERROR")?;
        prune(&mut edits);
        if edits.len() >= MAX_EDITS {
            return Err("MCP_SERVER_BUSY");
        }
        if edit.undo_of.as_ref().is_some_and(|parent| {
            edits.values().any(|e| {
                e.undo_of.as_ref() == Some(parent)
                    && matches!(
                        e.state,
                        "preparing"
                            | "pending"
                            | "confirming"
                            | "approved"
                            | "committing"
                            | "written"
                    )
            })
        }) {
            return Err("MCP_SERVER_EDIT_STATE_INVALID");
        }
        edits.insert(edit.id.clone(), edit.clone());
    }
    // Capture the editor lifetime before reporting a pending proposal externally.
    let captured = backend
        .query(
            "capture_document_edit",
            json!({"proposalId":edit.id,"path":edit.path,"content":edit.before}),
        )
        .await;
    let mut edits = EDITS.lock().map_err(|_| "MCP_SERVER_STATE_ERROR")?;
    let stored = edits
        .get_mut(&edit.id)
        .ok_or("MCP_SERVER_PROPOSAL_MISSING_OR_EXPIRED")?;
    if stored.state != "preparing" || stored.cancel.is_cancelled() {
        return Err("MCP_SERVER_CANCELLED");
    }
    match captured {
        Ok(_) => {
            stored.state = "pending";
            edit.state = "pending";
            Ok(summary(&edit))
        }
        Err(code) => {
            stored.state = "conflict";
            Err(code)
        }
    }
}

pub(super) async fn call(backend: &AppBackend, name: &str, arguments: Value) -> Result<Value> {
    if !backend.config.write_documents {
        return Err("MCP_SERVER_SCOPE_REJECTED");
    }
    if name == "propose_document_edit" {
        let args: ProposalArgs =
            serde_json::from_value(arguments).map_err(|_| "MCP_SERVER_ARGUMENTS_INVALID")?;
        let source = backend.clone();
        let edit = tauri::async_runtime::spawn_blocking(move || {
            let state = source.app.state::<crate::FsAccessState>();
            let path = write_path(&state, &source.scopes, &args.path)?;
            let before = crate::read_text_file_with_limit(&path, Some(MAX_DOCUMENT_BYTES))
                .map_err(|_| "MCP_SERVER_FILE_READ_FAILED")?;
            let after = replacement(&before, &args)?;
            Ok::<_, &'static str>(Edit {
                id: id(),
                generation: source.generation,
                path: path.to_string_lossy().into_owned(),
                scopes: source.scopes,
                before,
                after,
                old_text: args.old_text,
                new_text: args.new_text,
                state: "preparing",
                created: Instant::now(),
                cancel: source.cancel.child_token(),
                recovery_files: vec![],
                undo_of: None,
            })
        })
        .await
        .map_err(|_| "MCP_SERVER_EDIT_FAILED")??;
        return publish(backend, edit).await;
    }
    let args: ProposalId =
        serde_json::from_value(arguments).map_err(|_| "MCP_SERVER_ARGUMENTS_INVALID")?;
    let edit = get(&args.proposal_id)?;
    if edit.generation != backend.generation {
        return Err("MCP_SERVER_PROPOSAL_MISSING_OR_EXPIRED");
    }
    if name == "cancel_document_edit" {
        cancel(&args.proposal_id)?;
    }
    Ok(summary(&get(&args.proposal_id)?))
}

fn cancel(proposal_id: &str) -> Result<()> {
    let mut edits = EDITS.lock().map_err(|_| "MCP_SERVER_STATE_ERROR")?;
    prune(&mut edits);
    let edit = edits
        .get_mut(proposal_id)
        .ok_or("MCP_SERVER_PROPOSAL_MISSING_OR_EXPIRED")?;
    if matches!(
        edit.state,
        "preparing" | "pending" | "confirming" | "approved"
    ) {
        edit.cancel.cancel();
        edit.state = "cancelled";
    }
    // An already dispatched write is not described as rolled back.
    Ok(())
}

pub(super) fn stop(generation: Option<&str>) {
    if let Ok(mut edits) = EDITS.lock() {
        for edit in edits
            .values_mut()
            .filter(|e| generation.is_none_or(|g| g == e.generation))
        {
            edit.cancel.cancel();
            if matches!(
                edit.state,
                "preparing" | "pending" | "confirming" | "approved"
            ) {
                edit.state = "stopped";
            }
        }
    }
}

#[tauri::command]
pub fn mcp_server_edits() -> Result<Vec<Value>> {
    let mut edits = EDITS.lock().map_err(|_| "MCP_SERVER_STATE_ERROR")?;
    prune(&mut edits);
    let mut values: Vec<_> = edits.values().collect();
    values.sort_by_key(|e| e.created);
    Ok(values.into_iter().map(summary).collect())
}

#[tauri::command]
pub fn mcp_server_edit_detail(proposal_id: String) -> Result<Value> {
    let edit = get(&proposal_id)?;
    let mut value = summary(&edit);
    value["before"] = json!(edit.before);
    value["after"] = json!(edit.after);
    value["oldText"] = json!(edit.old_text);
    value["newText"] = json!(edit.new_text);
    value["recoveryFiles"] = json!(edit.recovery_files);
    Ok(value)
}

#[tauri::command]
pub fn mcp_server_cancel_edit(proposal_id: String) -> Result<()> {
    cancel(&proposal_id)
}

#[tauri::command]
pub async fn mcp_server_revert_edit(app: tauri::AppHandle, proposal_id: String) -> Result<Value> {
    let original = get(&proposal_id)?;
    live(&original)?;
    if original.state != "written" {
        return Err("MCP_SERVER_EDIT_STATE_INVALID");
    }
    let backend = {
        let runtime = RUNTIME.lock().map_err(|_| "MCP_SERVER_STATE_ERROR")?;
        let active = runtime.active.as_ref().ok_or("MCP_SERVER_STOPPED")?;
        if active.generation != original.generation {
            return Err("MCP_SERVER_STOPPED");
        }
        AppBackend {
            app,
            config: active.config.clone(),
            scopes: original.scopes.clone(),
            generation: original.generation.clone(),
            cancel: active.network.cancel.clone(),
        }
    };
    let edit = Edit {
        id: id(),
        generation: original.generation,
        path: original.path,
        scopes: original.scopes,
        before: original.after,
        after: original.before,
        old_text: original.new_text,
        new_text: original.old_text,
        state: "preparing",
        created: Instant::now(),
        cancel: backend.cancel.child_token(),
        recovery_files: vec![],
        undo_of: Some(original.id),
    };
    let source = backend.app.clone();
    let checked = edit.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = source.state::<crate::FsAccessState>();
        let path = write_path(&state, &checked.scopes, &checked.path)?;
        let content = crate::read_text_file_with_limit(&path, Some(MAX_DOCUMENT_BYTES))
            .map_err(|_| "MCP_SERVER_EDIT_CONFLICT")?;
        if content != checked.before {
            return Err("MCP_SERVER_EDIT_CONFLICT");
        }
        Ok(())
    })
    .await
    .map_err(|_| "MCP_SERVER_EDIT_FAILED")??;
    publish(&backend, edit).await
}

#[tauri::command]
pub async fn mcp_server_approve_edit(app: tauri::AppHandle, proposal_id: String) -> Result<()> {
    let edit = get(&proposal_id)?;
    live(&edit)?;
    {
        let mut edits = EDITS.lock().map_err(|_| "MCP_SERVER_STATE_ERROR")?;
        let stored = edits
            .get_mut(&proposal_id)
            .ok_or("MCP_SERVER_PROPOSAL_MISSING_OR_EXPIRED")?;
        if stored.state != "pending" {
            return Err("MCP_SERVER_EDIT_STATE_INVALID");
        }
        stored.state = "confirming";
    }
    let confirmed = crate::mcp::confirm(&app, format!("应用外部客户端的文档修改？\n\n文件：{}\n提案：{}\n原文hash：{}\n新文hash：{}\n\n删除片段：\n{}\n\n替换为：\n{}\n\n仅本次快照有效，冲突时拒绝；此确认不授权后续修改。", edit.path, edit.id, content_hash(&edit.before), content_hash(&edit.after), edit.old_text, edit.new_text), &edit.cancel).await;
    let valid = live(&edit).is_ok();
    let mut edits = EDITS.lock().map_err(|_| "MCP_SERVER_STATE_ERROR")?;
    prune(&mut edits);
    let stored = edits
        .get_mut(&proposal_id)
        .ok_or("MCP_SERVER_PROPOSAL_MISSING_OR_EXPIRED")?;
    if stored.state != "confirming" || !valid {
        return Err("MCP_SERVER_EDIT_STATE_INVALID");
    }
    match confirmed {
        Ok(()) => {
            stored.state = "approved";
            Ok(())
        }
        Err(code) => {
            stored.state = "rejected";
            Err(code)
        }
    }
}

// Replacement keeps a separate original backup until success. On an OS failure
// both recovery names are retained and reported locally; never retry/claim rollback.
fn replace_file(path: &Path, before: &str, after: &str, recovery: &mut Vec<String>) -> Result<()> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_DELETE, FILE_SHARE_READ};
        options.share_mode(FILE_SHARE_READ | FILE_SHARE_DELETE);
    }
    let guard = options.open(path).map_err(|_| "MCP_SERVER_EDIT_CONFLICT")?;
    let bytes = crate::read_bytes_with_limit(
        guard.try_clone().map_err(|_| "MCP_SERVER_EDIT_FAILED")?,
        MAX_DOCUMENT_BYTES,
    )
    .map_err(|_| "MCP_SERVER_EDIT_CONFLICT")?;
    if bytes != before.as_bytes() {
        return Err("MCP_SERVER_EDIT_CONFLICT");
    }
    let parent = path.parent().ok_or("MCP_SERVER_SCOPE_REJECTED")?;
    let temporary = parent.join(format!(".guanmo-mcp-{}.tmp", id()));
    let backup = parent.join(format!(".guanmo-mcp-{}.original", id()));
    let prepared = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| "MCP_SERVER_EDIT_FAILED")?;
        file.write_all(after.as_bytes())
            .map_err(|_| "MCP_SERVER_EDIT_FAILED")?;
        file.sync_all().map_err(|_| "MCP_SERVER_EDIT_FAILED")
    })();
    if let Err(code) = prepared {
        let _ = fs::remove_file(&temporary);
        return Err(code);
    }
    recovery.extend([
        temporary.to_string_lossy().into_owned(),
        backup.to_string_lossy().into_owned(),
    ]);
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let wide = |p: &Path| {
            p.as_os_str()
                .encode_wide()
                .chain(Some(0))
                .collect::<Vec<u16>>()
        };
        let target = wide(path);
        let replacement = wide(&temporary);
        let original = wide(&backup);
        let result = unsafe {
            windows_sys::Win32::Storage::FileSystem::ReplaceFileW(
                target.as_ptr(),
                replacement.as_ptr(),
                original.as_ptr(),
                0,
                std::ptr::null(),
                std::ptr::null(),
            )
        };
        if result == 0 {
            return Err("MCP_SERVER_EDIT_OUTCOME_UNKNOWN");
        }
    }
    #[cfg(not(windows))]
    {
        fs::copy(path, &backup).map_err(|_| "MCP_SERVER_EDIT_FAILED")?;
        fs::rename(&temporary, path).map_err(|_| "MCP_SERVER_EDIT_OUTCOME_UNKNOWN")?;
    }
    let _ = fs::remove_file(&backup);
    recovery.retain(|p| Path::new(p).exists());
    Ok(())
}

fn consume(state: &crate::FsAccessState, edit: &mut Edit) -> Result<()> {
    if edit.state != "approved" || edit.cancel.is_cancelled() || edit.created.elapsed() >= TTL {
        return Err("MCP_SERVER_EDIT_STATE_INVALID");
    }
    edit.state = "committing";
    let result = (|| {
        let path = write_path(state, &edit.scopes, &edit.path)?;
        replace_file(&path, &edit.before, &edit.after, &mut edit.recovery_files)
    })();
    edit.state = match result {
        Ok(()) => "written",
        Err("MCP_SERVER_EDIT_OUTCOME_UNKNOWN") => "unknown",
        Err("MCP_SERVER_EDIT_CONFLICT") => "conflict",
        Err(_) => "failed",
    };
    result
}

#[tauri::command]
pub async fn mcp_server_commit_edit(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    proposal_id: String,
) -> Result<()> {
    if window.label() != "main" {
        return Err("MCP_SERVER_SCOPE_REJECTED");
    }
    tauri::async_runtime::spawn_blocking(move || {
        // This short lock linearizes stop/revoke against the actual file commit.
        let runtime = RUNTIME.lock().map_err(|_| "MCP_SERVER_STATE_ERROR")?;
        let mut edits = EDITS.lock().map_err(|_| "MCP_SERVER_STATE_ERROR")?;
        prune(&mut edits);
        let edit = edits
            .get_mut(&proposal_id)
            .ok_or("MCP_SERVER_PROPOSAL_MISSING_OR_EXPIRED")?;
        if edit.state != "approved" || edit.cancel.is_cancelled() {
            return Err("MCP_SERVER_EDIT_STATE_INVALID");
        }
        if !runtime.active.as_ref().is_some_and(|a| {
            a.generation == edit.generation
                && a.config.write_documents
                && !a.network.cancel.is_cancelled()
        }) {
            return Err("MCP_SERVER_STOPPED");
        }
        let state = app.state::<crate::FsAccessState>();
        let result = consume(&state, edit);
        let undo_of = edit.undo_of.clone();
        if result.is_ok() {
            if let Some(parent) = undo_of.and_then(|id| edits.get_mut(&id)) {
                parent.state = "reverted";
            }
        }
        result
    })
    .await
    .map_err(|_| "MCP_SERVER_EDIT_OUTCOME_UNKNOWN")?
}

#[cfg(test)]
#[path = "edits_tests.rs"]
mod tests;
