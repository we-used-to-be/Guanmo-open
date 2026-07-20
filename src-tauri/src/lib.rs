use serde::{Deserialize, Serialize};
use std::fs::OpenOptions;
#[cfg(target_os = "windows")]
use std::process::Command;
use std::{
    collections::{HashMap, HashSet},
    ffi::OsString,
    fs,
    path::{Component, Path, PathBuf},
    sync::Mutex,
};
use tauri::{Emitter, Manager, State};
use tauri_plugin_fs::FsExt;

mod api_http;
mod database_transactions;
mod rag_index;
use api_http::ApiOriginState;

const SECRET_FILE: &str = "secrets.json";
const FILE_ACCESS_GRANTS_FILE: &str = "file-access-grants.json";
const MAX_LEGACY_WORKSPACES: usize = 16;
const MAX_LEGACY_FILES: usize = 10_000;
const ALLOWED_TEXT_FILE_EXTENSIONS: [&str; 11] = [
    "md", "markdown", "mdx", "txt", "json", "html", "css", "js", "ts", "jsx", "tsx",
];
const ALLOWED_IMAGE_FILE_EXTENSIONS: [&str; 7] =
    ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"];
const OPEN_FILES_EVENT: &str = "guanmo:open-files";

#[derive(Default)]
struct FsAccessState {
    workspaces: Mutex<HashSet<PathBuf>>,
    selected_files: Mutex<HashSet<PathBuf>>,
    markdown_asset_dirs: Mutex<HashSet<PathBuf>>,
    persistence: Mutex<()>,
    legacy_migration_completed: Mutex<bool>,
    legacy_migration: Mutex<()>,
    pending_legacy_workspaces: Mutex<HashSet<PathBuf>>,
    pending_legacy_files: Mutex<HashSet<PathBuf>>,
}

#[derive(Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
struct PersistedFileAccess {
    #[serde(default)]
    workspaces: Vec<PathBuf>,
    #[serde(default)]
    selected_files: Vec<PathBuf>,
    #[serde(default)]
    legacy_migration_completed: bool,
    #[serde(default)]
    pending_legacy_workspaces: Vec<PathBuf>,
    #[serde(default)]
    pending_legacy_files: Vec<PathBuf>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyFileAccessMigrationResult {
    status: &'static str,
    workspace_count: usize,
    file_count: usize,
    ignored_count: usize,
    pending_count: usize,
}

#[derive(Clone, Copy, Debug)]
enum FileAction {
    ReadText,
    WriteText,
    ReadBinary,
    WriteBinary,
    CreateFile,
    CreateDir,
    ReadDir,
    Exists,
    Remove,
    Reveal,
    RenameSource,
    RenameTarget,
}

impl FileAction {
    fn allows_selected_file(self) -> bool {
        !matches!(self, Self::CreateDir | Self::ReadDir)
    }

    fn allows_markdown_asset(self) -> bool {
        matches!(
            self,
            Self::ReadBinary | Self::WriteBinary | Self::Exists | Self::Remove | Self::Reveal
        )
    }
}

#[derive(Default)]
struct PendingOpenFiles(Mutex<Vec<String>>);

#[derive(Serialize)]
struct DirectoryEntry {
    name: String,
    #[serde(rename = "isDirectory")]
    is_directory: bool,
    #[serde(rename = "isFile")]
    is_file: bool,
}

fn ensure_allowed_secret_key(key: &str) -> Result<(), String> {
    let valid = !key.is_empty()
        && key.len() <= 128
        && key
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'));
    if !valid {
        return Err("secret key is not allowed".into());
    }
    Ok(())
}

fn ensure_allowed_text_file_path(path: &Path) -> Result<(), String> {
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .ok_or_else(|| "file extension is not allowed".to_string())?;

    if ALLOWED_TEXT_FILE_EXTENSIONS.contains(&extension.as_str()) {
        Ok(())
    } else {
        Err("file extension is not allowed".into())
    }
}

fn ensure_allowed_image_file_path(path: &Path) -> Result<(), String> {
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .ok_or_else(|| "file extension is not allowed".to_string())?;

    if ALLOWED_IMAGE_FILE_EXTENSIONS.contains(&extension.as_str()) {
        Ok(())
    } else {
        Err("file extension is not allowed".into())
    }
}

fn ensure_allowed_text_or_image_file_path(path: &Path) -> Result<(), String> {
    ensure_allowed_text_file_path(path).or_else(|_| ensure_allowed_image_file_path(path))
}

fn is_markdown_file_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("md"))
        .unwrap_or(false)
}

fn resolve_open_file_path(path: PathBuf, cwd: &Path) -> Option<String> {
    let path = if path.is_absolute() {
        path
    } else {
        cwd.join(path)
    };
    if !path.is_file() || !is_markdown_file_path(&path) {
        return None;
    }
    let path = path.canonicalize().unwrap_or(path);
    Some(path.to_string_lossy().to_string())
}

fn collect_open_file_paths<I>(args: I, cwd: &Path) -> Vec<String>
where
    I: IntoIterator<Item = OsString>,
{
    args.into_iter()
        .filter_map(|arg| resolve_open_file_path(PathBuf::from(arg), cwd))
        .collect()
}

fn enqueue_open_files(state: &PendingOpenFiles, paths: Vec<String>) {
    let mut pending = state.0.lock().expect("pending open files lock poisoned");
    for path in paths {
        if !pending.iter().any(|item| item.eq_ignore_ascii_case(&path)) {
            pending.push(path);
        }
    }
}

fn ensure_safe_path(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("path must be absolute".into());
    }
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("parent directory traversal is not allowed".into());
    }
    Ok(())
}

fn canonical_dir(path: &Path) -> Result<PathBuf, String> {
    ensure_safe_path(path)?;
    let canonical = path.canonicalize().map_err(|err| err.to_string())?;
    if canonical.is_dir() {
        Ok(canonical)
    } else {
        Err("path is not a directory".into())
    }
}

fn canonical_existing_file(path: &Path) -> Result<PathBuf, String> {
    ensure_safe_path(path)?;
    let canonical = path.canonicalize().map_err(|err| err.to_string())?;
    if canonical.is_file() {
        Ok(canonical)
    } else {
        Err("path is not a file".into())
    }
}

fn normalized_target_path(path: &Path) -> Result<PathBuf, String> {
    ensure_safe_path(path)?;
    if path.exists() {
        return path.canonicalize().map_err(|err| err.to_string());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "path parent is missing".to_string())?
        .canonicalize()
        .map_err(|err| err.to_string())?;
    let file_name = path
        .file_name()
        .ok_or_else(|| "file name is missing".to_string())?;
    Ok(parent.join(file_name))
}

fn is_inside(base: &Path, path: &Path) -> bool {
    path == base || path.starts_with(base)
}

fn is_allowed_workspace_path(state: &FsAccessState, path: &Path) -> Result<bool, String> {
    let workspaces = state
        .workspaces
        .lock()
        .map_err(|_| "workspace access state is poisoned".to_string())?;
    Ok(workspaces
        .iter()
        .any(|workspace| is_inside(workspace, path)))
}

fn is_allowed_selected_file(state: &FsAccessState, path: &Path) -> Result<bool, String> {
    let selected_files = state
        .selected_files
        .lock()
        .map_err(|_| "selected file access state is poisoned".to_string())?;
    Ok(selected_files.contains(path))
}

fn is_allowed_markdown_asset(state: &FsAccessState, path: &Path) -> Result<bool, String> {
    let asset_dirs = state
        .markdown_asset_dirs
        .lock()
        .map_err(|_| "Markdown asset access state is poisoned".to_string())?;
    Ok(asset_dirs.iter().any(|dir| is_inside(dir, path)))
}

fn is_authorized_for_action(
    state: &FsAccessState,
    path: &Path,
    action: FileAction,
) -> Result<bool, String> {
    if is_allowed_workspace_path(state, path)? {
        return Ok(true);
    }
    let selected_file_allowed = action
        .allows_selected_file()
        .then(|| is_allowed_selected_file(state, path))
        .transpose()
        .map(|allowed| allowed.unwrap_or(false))?;
    if selected_file_allowed {
        return Ok(true);
    }
    (action.allows_markdown_asset() && ensure_allowed_image_file_path(path).is_ok())
        .then(|| is_allowed_markdown_asset(state, path))
        .transpose()
        .map(|allowed| allowed.unwrap_or(false))
}

fn ensure_allowed_existing_text_file(
    state: &FsAccessState,
    path: &Path,
    action: FileAction,
) -> Result<PathBuf, String> {
    ensure_allowed_text_file_path(path)?;
    let canonical = canonical_existing_file(path)?;
    if is_authorized_for_action(state, &canonical, action)? {
        Ok(canonical)
    } else {
        Err("file is outside the selected workspace".into())
    }
}

fn ensure_allowed_target_text_file(
    state: &FsAccessState,
    path: &Path,
    action: FileAction,
) -> Result<PathBuf, String> {
    ensure_allowed_text_file_path(path)?;
    let normalized = normalized_target_path(path)?;
    if is_authorized_for_action(state, &normalized, action)? {
        Ok(normalized)
    } else {
        Err("file is outside the selected workspace".into())
    }
}

fn ensure_allowed_existing_image_file(
    state: &FsAccessState,
    path: &Path,
    action: FileAction,
) -> Result<PathBuf, String> {
    ensure_allowed_image_file_path(path)?;
    let canonical = canonical_existing_file(path)?;
    if is_authorized_for_action(state, &canonical, action)? {
        Ok(canonical)
    } else {
        Err("file is outside the selected workspace".into())
    }
}

fn ensure_allowed_target_image_file(
    state: &FsAccessState,
    path: &Path,
    action: FileAction,
) -> Result<PathBuf, String> {
    ensure_allowed_image_file_path(path)?;
    let normalized = normalized_target_path(path)?;
    if is_authorized_for_action(state, &normalized, action)? {
        Ok(normalized)
    } else {
        Err("file is outside the selected workspace".into())
    }
}

fn ensure_allowed_existing_supported_file(
    state: &FsAccessState,
    path: &Path,
    action: FileAction,
) -> Result<PathBuf, String> {
    ensure_allowed_text_or_image_file_path(path)?;
    let canonical = canonical_existing_file(path)?;
    if is_authorized_for_action(state, &canonical, action)? {
        Ok(canonical)
    } else {
        Err("file is outside the selected workspace".into())
    }
}

fn ensure_allowed_target_path(
    state: &FsAccessState,
    path: &Path,
    action: FileAction,
) -> Result<PathBuf, String> {
    let normalized = normalized_target_path(path)?;
    if is_authorized_for_action(state, &normalized, action)? {
        Ok(normalized)
    } else {
        Err("path is outside the selected workspace".into())
    }
}

fn ensure_allowed_dir(
    state: &FsAccessState,
    path: &Path,
    action: FileAction,
) -> Result<PathBuf, String> {
    let canonical = canonical_dir(path)?;
    if is_authorized_for_action(state, &canonical, action)? {
        Ok(canonical)
    } else {
        Err("directory is outside the selected workspace".into())
    }
}

fn snapshot_persisted_file_access(state: &FsAccessState) -> Result<PersistedFileAccess, String> {
    let mut workspaces = state
        .workspaces
        .lock()
        .map_err(|_| "workspace access state is poisoned".to_string())?
        .iter()
        .cloned()
        .collect::<Vec<_>>();
    let mut selected_files = state
        .selected_files
        .lock()
        .map_err(|_| "selected file access state is poisoned".to_string())?
        .iter()
        .cloned()
        .collect::<Vec<_>>();
    workspaces.sort();
    selected_files.sort();
    let legacy_migration_completed = *state
        .legacy_migration_completed
        .lock()
        .map_err(|_| "legacy migration state is poisoned".to_string())?;
    let mut pending_legacy_workspaces = state
        .pending_legacy_workspaces
        .lock()
        .map_err(|_| "pending legacy workspace state is poisoned".to_string())?
        .iter()
        .cloned()
        .collect::<Vec<_>>();
    let mut pending_legacy_files = state
        .pending_legacy_files
        .lock()
        .map_err(|_| "pending legacy file state is poisoned".to_string())?
        .iter()
        .cloned()
        .collect::<Vec<_>>();
    pending_legacy_workspaces.sort();
    pending_legacy_files.sort();
    Ok(PersistedFileAccess {
        workspaces,
        selected_files,
        legacy_migration_completed,
        pending_legacy_workspaces,
        pending_legacy_files,
    })
}

fn file_access_grants_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|err| err.to_string())?;
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir.join(FILE_ACCESS_GRANTS_FILE))
}

fn read_persisted_file_access(path: &Path) -> Result<PersistedFileAccess, String> {
    if !path.exists() {
        return Ok(PersistedFileAccess::default());
    }
    let text = fs::read_to_string(path).map_err(|err| err.to_string())?;
    serde_json::from_str(&text).map_err(|err| err.to_string())
}

fn persist_file_access(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<FsAccessState>();
    let _guard = state
        .persistence
        .lock()
        .map_err(|_| "file access persistence state is poisoned".to_string())?;
    let grants = snapshot_persisted_file_access(state.inner())?;
    let text = serde_json::to_string(&grants).map_err(|err| err.to_string())?;
    fs::write(file_access_grants_path(app)?, text).map_err(|err| err.to_string())
}

fn register_workspace_internal(
    app: &tauri::AppHandle,
    path: PathBuf,
    persist: bool,
) -> Result<PathBuf, String> {
    let canonical = canonical_dir(&path)?;
    app.fs_scope()
        .allow_directory(&canonical, true)
        .map_err(|err| err.to_string())?;
    app.asset_protocol_scope()
        .allow_directory(&canonical, true)
        .map_err(|err| err.to_string())?;
    let state = app.state::<FsAccessState>();
    state
        .workspaces
        .lock()
        .map_err(|_| "workspace access state is poisoned".to_string())?
        .insert(canonical.clone());
    if persist {
        persist_file_access(app)?;
    }
    Ok(canonical)
}

fn register_workspace(app: &tauri::AppHandle, path: PathBuf) -> Result<PathBuf, String> {
    register_workspace_internal(app, path, true)
}

fn register_markdown_assets_dir(app: &tauri::AppHandle, path: PathBuf) -> Result<PathBuf, String> {
    let canonical = canonical_dir(&path)?;
    app.asset_protocol_scope()
        .allow_directory(&canonical, true)
        .map_err(|err| err.to_string())?;
    let state = app.state::<FsAccessState>();
    state
        .markdown_asset_dirs
        .lock()
        .map_err(|_| "Markdown asset access state is poisoned".to_string())?
        .insert(canonical.clone());
    Ok(canonical)
}

fn register_selected_file_internal(
    app: &tauri::AppHandle,
    path: PathBuf,
    persist: bool,
) -> Result<PathBuf, String> {
    ensure_allowed_text_or_image_file_path(&path)?;
    let normalized = normalized_target_path(&path)?;
    app.fs_scope()
        .allow_file(&normalized)
        .map_err(|err| err.to_string())?;
    app.asset_protocol_scope()
        .allow_file(&normalized)
        .map_err(|err| err.to_string())?;
    let state = app.state::<FsAccessState>();
    state
        .selected_files
        .lock()
        .map_err(|_| "selected file access state is poisoned".to_string())?
        .insert(normalized.clone());
    if is_markdown_file_path(&normalized) {
        let assets_dir = normalized
            .parent()
            .ok_or_else(|| "path parent is missing".to_string())?
            .join("assets");
        if assets_dir.is_dir() {
            register_markdown_assets_dir(app, assets_dir)?;
        }
    }
    if persist {
        persist_file_access(app)?;
    }
    Ok(normalized)
}

fn register_selected_file(app: &tauri::AppHandle, path: PathBuf) -> Result<PathBuf, String> {
    register_selected_file_internal(app, path, true)
}

fn restore_persisted_file_access(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<FsAccessState>();
    let _migration_guard = state
        .legacy_migration
        .lock()
        .map_err(|_| "legacy migration lock is poisoned".to_string())?;
    let grants = read_persisted_file_access(&file_access_grants_path(app)?)?;
    let PersistedFileAccess {
        workspaces,
        selected_files,
        legacy_migration_completed,
        pending_legacy_workspaces,
        pending_legacy_files,
    } = grants;
    *state
        .legacy_migration_completed
        .lock()
        .map_err(|_| "legacy migration state is poisoned".to_string())? =
        legacy_migration_completed;
    state
        .pending_legacy_workspaces
        .lock()
        .map_err(|_| "pending legacy workspace state is poisoned".to_string())?
        .extend(pending_legacy_workspaces);
    state
        .pending_legacy_files
        .lock()
        .map_err(|_| "pending legacy file state is poisoned".to_string())?
        .extend(pending_legacy_files);
    for workspace in workspaces {
        if workspace.exists() {
            let _ = register_workspace_internal(app, workspace, false);
        } else if ensure_safe_path(&workspace).is_ok() {
            state
                .pending_legacy_workspaces
                .lock()
                .map_err(|_| "pending legacy workspace state is poisoned".to_string())?
                .insert(workspace);
        }
    }
    for file in selected_files {
        if file.is_file() {
            let _ = register_selected_file_internal(app, file, false);
        } else if !file.exists()
            && ensure_safe_path(&file).is_ok()
            && ensure_allowed_text_or_image_file_path(&file).is_ok()
        {
            state
                .pending_legacy_files
                .lock()
                .map_err(|_| "pending legacy file state is poisoned".to_string())?
                .insert(file);
        }
    }
    persist_file_access(app)
}

fn retry_pending_legacy_file_access(
    app: &tauri::AppHandle,
) -> Result<(usize, usize, usize), String> {
    let state = app.state::<FsAccessState>();
    let pending_workspaces = state
        .pending_legacy_workspaces
        .lock()
        .map_err(|_| "pending legacy workspace state is poisoned".to_string())?
        .iter()
        .cloned()
        .collect::<Vec<_>>();
    let pending_files = state
        .pending_legacy_files
        .lock()
        .map_err(|_| "pending legacy file state is poisoned".to_string())?
        .iter()
        .cloned()
        .collect::<Vec<_>>();
    let mut workspace_count = 0;
    let mut file_count = 0;
    let mut ignored_count = 0;

    for path in pending_workspaces {
        if ensure_safe_path(&path).is_err() {
            ignored_count += 1;
            state
                .pending_legacy_workspaces
                .lock()
                .map_err(|_| "pending legacy workspace state is poisoned".to_string())?
                .remove(&path);
            continue;
        }
        if !path.exists() {
            continue;
        }
        let remove_from_pending = match canonical_dir(&path) {
            Ok(path) => {
                register_workspace_internal(app, path, false)?;
                workspace_count += 1;
                true
            }
            Err(_) => {
                ignored_count += 1;
                true
            }
        };
        if remove_from_pending {
            state
                .pending_legacy_workspaces
                .lock()
                .map_err(|_| "pending legacy workspace state is poisoned".to_string())?
                .remove(&path);
        }
    }
    for path in pending_files {
        if ensure_safe_path(&path).is_err()
            || ensure_allowed_text_or_image_file_path(&path).is_err()
        {
            ignored_count += 1;
            state
                .pending_legacy_files
                .lock()
                .map_err(|_| "pending legacy file state is poisoned".to_string())?
                .remove(&path);
            continue;
        }
        if !path.exists() {
            continue;
        }
        let remove_from_pending = match canonical_existing_file(&path) {
            Ok(path) => {
                register_selected_file_internal(app, path, false)?;
                file_count += 1;
                true
            }
            Err(_) => {
                ignored_count += 1;
                true
            }
        };
        if remove_from_pending {
            state
                .pending_legacy_files
                .lock()
                .map_err(|_| "pending legacy file state is poisoned".to_string())?
                .remove(&path);
        }
    }
    Ok((workspace_count, file_count, ignored_count))
}

fn pending_legacy_path_count(state: &FsAccessState) -> Result<usize, String> {
    let workspace_count = state
        .pending_legacy_workspaces
        .lock()
        .map_err(|_| "pending legacy workspace state is poisoned".to_string())?
        .len();
    let file_count = state
        .pending_legacy_files
        .lock()
        .map_err(|_| "pending legacy file state is poisoned".to_string())?
        .len();
    Ok(workspace_count + file_count)
}

fn migrate_legacy_file_access_blocking(
    app: tauri::AppHandle,
    workspace_paths: Vec<String>,
    file_paths: Vec<String>,
) -> Result<LegacyFileAccessMigrationResult, String> {
    let state = app.state::<FsAccessState>();
    let _migration_guard = state
        .legacy_migration
        .lock()
        .map_err(|_| "legacy migration lock is poisoned".to_string())?;
    let already_migrated = *state
        .legacy_migration_completed
        .lock()
        .map_err(|_| "legacy migration state is poisoned".to_string())?;

    let mut ignored_count = if already_migrated {
        0
    } else {
        workspace_paths.len().saturating_sub(MAX_LEGACY_WORKSPACES)
            + file_paths.len().saturating_sub(MAX_LEGACY_FILES)
    };
    if !already_migrated {
        for path in workspace_paths.into_iter().take(MAX_LEGACY_WORKSPACES) {
            let path = PathBuf::from(path);
            if ensure_safe_path(&path).is_ok() {
                state
                    .pending_legacy_workspaces
                    .lock()
                    .map_err(|_| "pending legacy workspace state is poisoned".to_string())?
                    .insert(path);
            } else {
                ignored_count += 1;
            }
        }
        for path in file_paths.into_iter().take(MAX_LEGACY_FILES) {
            let path = PathBuf::from(path);
            if ensure_safe_path(&path).is_ok()
                && ensure_allowed_text_or_image_file_path(&path).is_ok()
            {
                state
                    .pending_legacy_files
                    .lock()
                    .map_err(|_| "pending legacy file state is poisoned".to_string())?
                    .insert(path);
            } else {
                ignored_count += 1;
            }
        }
        *state
            .legacy_migration_completed
            .lock()
            .map_err(|_| "legacy migration state is poisoned".to_string())? = true;
    }
    let (workspace_count, file_count, retry_ignored_count) =
        retry_pending_legacy_file_access(&app)?;
    ignored_count += retry_ignored_count;
    if let Err(err) = persist_file_access(&app) {
        if !already_migrated {
            *state
                .legacy_migration_completed
                .lock()
                .map_err(|_| "legacy migration state is poisoned".to_string())? = false;
        }
        return Err(err);
    }

    Ok(LegacyFileAccessMigrationResult {
        status: if already_migrated {
            "already_migrated"
        } else {
            "migrated"
        },
        workspace_count,
        file_count,
        ignored_count,
        pending_count: pending_legacy_path_count(state.inner())?,
    })
}

#[tauri::command]
async fn migrate_legacy_file_access(
    app: tauri::AppHandle,
    workspace_paths: Vec<String>,
    file_paths: Vec<String>,
) -> Result<LegacyFileAccessMigrationResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        migrate_legacy_file_access_blocking(app, workspace_paths, file_paths)
    })
    .await
    .map_err(|err| format!("file access migration task failed: {err}"))?
}

fn secret_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|err| err.to_string())?;
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir.join(SECRET_FILE))
}

fn read_secret_map(path: &PathBuf) -> Result<HashMap<String, Vec<u8>>, String> {
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let text = fs::read_to_string(path).map_err(|err| err.to_string())?;
    serde_json::from_str(&text).map_err(|err| err.to_string())
}

fn write_secret_map(path: &PathBuf, secrets: &HashMap<String, Vec<u8>>) -> Result<(), String> {
    let text = serde_json::to_string(secrets).map_err(|err| err.to_string())?;
    fs::write(path, text).map_err(|err| err.to_string())
}

#[cfg(target_os = "windows")]
fn protect_secret(value: &str) -> Result<Vec<u8>, String> {
    use std::ptr::null;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB};

    let bytes = value.as_bytes();
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };

    let ok = unsafe { CryptProtectData(&input, null(), null(), null(), null(), 0, &mut output) };
    if ok == 0 {
        return Err("failed to encrypt secret with Windows DPAPI".into());
    }

    let encrypted =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        LocalFree(output.pbData as _);
    }
    Ok(encrypted)
}

#[cfg(target_os = "windows")]
fn unprotect_secret(value: &[u8]) -> Result<String, String> {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};

    let input = CRYPT_INTEGER_BLOB {
        cbData: value.len() as u32,
        pbData: value.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };

    let ok =
        unsafe { CryptUnprotectData(&input, null_mut(), null(), null(), null(), 0, &mut output) };
    if ok == 0 {
        return Err("failed to decrypt secret with Windows DPAPI".into());
    }

    let decrypted =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        LocalFree(output.pbData as _);
    }
    String::from_utf8(decrypted).map_err(|err| err.to_string())
}

#[cfg(not(target_os = "windows"))]
fn protect_secret(value: &str) -> Result<Vec<u8>, String> {
    Ok(value.as_bytes().to_vec())
}

#[cfg(not(target_os = "windows"))]
fn unprotect_secret(value: &[u8]) -> Result<String, String> {
    String::from_utf8(value.to_vec()).map_err(|err| err.to_string())
}

#[tauri::command]
fn save_secret(app: tauri::AppHandle, key: String, value: String) -> Result<(), String> {
    ensure_allowed_secret_key(&key)?;
    let path = secret_file_path(&app)?;
    let mut secrets = read_secret_map(&path)?;
    if value.is_empty() {
        secrets.remove(&key);
    } else {
        secrets.insert(key, protect_secret(&value)?);
    }
    write_secret_map(&path, &secrets)
}

#[tauri::command]
fn load_secret(app: tauri::AppHandle, key: String) -> Result<Option<String>, String> {
    ensure_allowed_secret_key(&key)?;
    let path = secret_file_path(&app)?;
    let secrets = read_secret_map(&path)?;
    secrets
        .get(&key)
        .map(|value| unprotect_secret(value))
        .transpose()
}

#[tauri::command]
fn delete_secret(app: tauri::AppHandle, key: String) -> Result<(), String> {
    ensure_allowed_secret_key(&key)?;
    let path = secret_file_path(&app)?;
    let mut secrets = read_secret_map(&path)?;
    secrets.remove(&key);
    write_secret_map(&path, &secrets)
}

#[tauri::command]
fn authorize_workspace_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let path = canonical_dir(&PathBuf::from(path))?;
    if !app.fs_scope().is_allowed(&path) {
        return Err("workspace was not selected by the user".into());
    }
    register_workspace(&app, path).map(|_| ())
}

#[tauri::command]
fn authorize_selected_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    ensure_allowed_text_or_image_file_path(&path)?;
    let normalized = normalized_target_path(&path)?;
    if !app.fs_scope().is_allowed(&normalized) {
        return Err("file was not selected by the user".into());
    }
    register_selected_file(&app, normalized).map(|_| ())
}

#[tauri::command]
fn read_text_file_by_path(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let state = app.state::<FsAccessState>();
    let path =
        ensure_allowed_existing_text_file(&state, &PathBuf::from(path), FileAction::ReadText)?;
    fs::read_to_string(path).map_err(|err| err.to_string())
}

#[tauri::command]
fn write_text_file_by_path(
    app: tauri::AppHandle,
    path: String,
    content: String,
) -> Result<(), String> {
    let state = app.state::<FsAccessState>();
    let path =
        ensure_allowed_target_text_file(&state, &PathBuf::from(path), FileAction::WriteText)?;
    fs::write(path, content).map_err(|err| err.to_string())
}

#[tauri::command]
fn read_binary_file_by_path(app: tauri::AppHandle, path: String) -> Result<Vec<u8>, String> {
    let state = app.state::<FsAccessState>();
    let path =
        ensure_allowed_existing_image_file(&state, &PathBuf::from(path), FileAction::ReadBinary)?;
    fs::read(path).map_err(|err| err.to_string())
}

#[tauri::command]
fn write_binary_file_by_path(
    app: tauri::AppHandle,
    path: String,
    content: Vec<u8>,
) -> Result<(), String> {
    let state = app.state::<FsAccessState>();
    let path =
        ensure_allowed_target_image_file(&state, &PathBuf::from(path), FileAction::WriteBinary)?;
    fs::write(path, content).map_err(|err| err.to_string())
}

#[tauri::command]
fn create_text_file_by_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let state = app.state::<FsAccessState>();
    let path =
        ensure_allowed_target_text_file(&state, &PathBuf::from(path), FileAction::CreateFile)?;
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map(|_| ())
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn path_exists(app: tauri::AppHandle, path: String) -> Result<bool, String> {
    let state = app.state::<FsAccessState>();
    let path = ensure_allowed_target_path(&state, &PathBuf::from(path), FileAction::Exists)?;
    Ok(path.exists())
}

#[tauri::command]
fn remove_file_by_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let state = app.state::<FsAccessState>();
    let path =
        ensure_allowed_existing_supported_file(&state, &PathBuf::from(path), FileAction::Remove)?;
    fs::remove_file(&path).map_err(|err| err.to_string())?;
    let removed_selected_grant = state
        .selected_files
        .lock()
        .map_err(|_| "selected file access state is poisoned".to_string())?
        .remove(&path);
    if removed_selected_grant {
        persist_file_access(&app)?;
    }
    Ok(())
}

#[tauri::command]
fn create_dir_by_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let state = app.state::<FsAccessState>();
    let path = PathBuf::from(path);
    let parent = path
        .parent()
        .ok_or_else(|| "path parent is missing".to_string())?;
    let dir_name = path
        .file_name()
        .ok_or_else(|| "directory name is missing".to_string())?;
    let path = ensure_allowed_dir(&state, parent, FileAction::CreateDir)?.join(dir_name);
    fs::create_dir(&path).map_err(|err| err.to_string())?;
    register_workspace(&app, path).map(|_| ())
}

#[tauri::command]
fn prepare_markdown_assets_dir(app: tauri::AppHandle, markdown_path: String) -> Result<(), String> {
    let state = app.state::<FsAccessState>();
    let markdown_path = ensure_allowed_existing_text_file(
        &state,
        &PathBuf::from(markdown_path),
        FileAction::ReadText,
    )?;
    if !is_markdown_file_path(&markdown_path) {
        return Err("path is not a Markdown file".into());
    }
    let assets_dir = markdown_path
        .parent()
        .ok_or_else(|| "path parent is missing".to_string())?
        .join("assets");
    if !assets_dir.exists() {
        fs::create_dir(&assets_dir).map_err(|err| err.to_string())?;
    }
    register_markdown_assets_dir(&app, assets_dir).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::{
        is_authorized_for_action, snapshot_persisted_file_access, FileAction, FsAccessState,
        PersistedFileAccess,
    };
    use std::path::{Path, PathBuf};

    #[test]
    fn rejects_every_file_action_for_unauthorized_paths() {
        let state = FsAccessState::default();
        let path = Path::new("outside/secret.md");
        let actions = [
            FileAction::ReadText,
            FileAction::WriteText,
            FileAction::ReadBinary,
            FileAction::WriteBinary,
            FileAction::CreateFile,
            FileAction::CreateDir,
            FileAction::ReadDir,
            FileAction::Exists,
            FileAction::Remove,
            FileAction::Reveal,
            FileAction::RenameSource,
            FileAction::RenameTarget,
        ];

        for action in actions {
            assert!(!is_authorized_for_action(&state, path, action).unwrap());
        }
    }

    #[test]
    fn workspace_authorizes_all_file_actions_for_descendants() {
        let state = FsAccessState::default();
        state
            .workspaces
            .lock()
            .unwrap()
            .insert(PathBuf::from("workspace"));
        let path = Path::new("workspace/notes/draft.md");
        let actions = [
            FileAction::ReadText,
            FileAction::WriteText,
            FileAction::ReadBinary,
            FileAction::WriteBinary,
            FileAction::CreateFile,
            FileAction::CreateDir,
            FileAction::ReadDir,
            FileAction::Exists,
            FileAction::Remove,
            FileAction::Reveal,
            FileAction::RenameSource,
            FileAction::RenameTarget,
        ];

        for action in actions {
            assert!(is_authorized_for_action(&state, path, action).unwrap());
        }
    }

    #[test]
    fn selected_file_authorizes_only_exact_file_actions() {
        let state = FsAccessState::default();
        state
            .selected_files
            .lock()
            .unwrap()
            .insert(PathBuf::from("selected/draft.md"));

        assert!(is_authorized_for_action(
            &state,
            Path::new("selected/draft.md"),
            FileAction::ReadText,
        )
        .unwrap());
        assert!(!is_authorized_for_action(
            &state,
            Path::new("selected/sibling.md"),
            FileAction::ReadText,
        )
        .unwrap());
        assert!(!is_authorized_for_action(
            &state,
            Path::new("selected/draft.md"),
            FileAction::ReadDir,
        )
        .unwrap());
    }

    #[test]
    fn markdown_assets_allow_only_asset_actions() {
        let state = FsAccessState::default();
        state
            .markdown_asset_dirs
            .lock()
            .unwrap()
            .insert(PathBuf::from("notes/assets"));
        let image = Path::new("notes/assets/figure.png");

        assert!(is_authorized_for_action(&state, image, FileAction::ReadBinary).unwrap());
        assert!(is_authorized_for_action(&state, image, FileAction::WriteBinary).unwrap());
        assert!(!is_authorized_for_action(&state, image, FileAction::ReadText).unwrap());
        assert!(!is_authorized_for_action(&state, image, FileAction::ReadDir).unwrap());
        assert!(!is_authorized_for_action(
            &state,
            Path::new("notes/assets/secret.txt"),
            FileAction::Remove,
        )
        .unwrap());
    }

    #[test]
    fn persisted_access_snapshot_round_trips_workspaces_and_selected_files() {
        let state = FsAccessState::default();
        state
            .workspaces
            .lock()
            .unwrap()
            .insert(PathBuf::from("workspace"));
        state
            .selected_files
            .lock()
            .unwrap()
            .insert(PathBuf::from("selected/draft.md"));
        *state.legacy_migration_completed.lock().unwrap() = true;
        state
            .pending_legacy_files
            .lock()
            .unwrap()
            .insert(PathBuf::from(r"D:\offline\draft.md"));

        let snapshot = snapshot_persisted_file_access(&state).unwrap();
        let encoded = serde_json::to_string(&snapshot).unwrap();
        let decoded: PersistedFileAccess = serde_json::from_str(&encoded).unwrap();

        assert_eq!(decoded, snapshot);
        assert_eq!(decoded.workspaces, vec![PathBuf::from("workspace")]);
        assert_eq!(
            decoded.selected_files,
            vec![PathBuf::from("selected/draft.md")]
        );
        assert!(decoded.legacy_migration_completed);
        assert_eq!(
            decoded.pending_legacy_files,
            vec![PathBuf::from(r"D:\offline\draft.md")]
        );
    }

    #[test]
    fn persisted_access_without_migration_marker_defaults_to_false() {
        let decoded: PersistedFileAccess =
            serde_json::from_str(r#"{"workspaces":[],"selected_files":[]}"#).unwrap();

        assert!(!decoded.legacy_migration_completed);
        assert!(decoded.pending_legacy_workspaces.is_empty());
        assert!(decoded.pending_legacy_files.is_empty());
    }
}

#[tauri::command]
fn rename_text_file_by_path(
    app: tauri::AppHandle,
    old_path: String,
    new_path: String,
) -> Result<(), String> {
    let state = app.state::<FsAccessState>();
    let old_path = ensure_allowed_existing_text_file(
        &state,
        &PathBuf::from(old_path),
        FileAction::RenameSource,
    )?;
    let new_path = ensure_allowed_target_text_file(
        &state,
        &PathBuf::from(new_path),
        FileAction::RenameTarget,
    )?;
    if new_path.exists() {
        return Err("file already exists".into());
    }
    fs::rename(&old_path, &new_path).map_err(|err| err.to_string())?;
    let mut selected_files = state
        .selected_files
        .lock()
        .map_err(|_| "selected file access state is poisoned".to_string())?;
    let moved_selected_grant = selected_files.remove(&old_path);
    if moved_selected_grant {
        selected_files.insert(new_path);
    }
    drop(selected_files);
    if moved_selected_grant {
        persist_file_access(&app)?;
    }
    Ok(())
}

#[tauri::command]
fn read_dir_by_path(app: tauri::AppHandle, path: String) -> Result<Vec<DirectoryEntry>, String> {
    let state = app.state::<FsAccessState>();
    let canonical = ensure_allowed_dir(&state, &PathBuf::from(path), FileAction::ReadDir)?;
    let entries = fs::read_dir(canonical).map_err(|err| err.to_string())?;
    entries
        .map(|entry| {
            let entry = entry.map_err(|err| err.to_string())?;
            let file_type = entry.file_type().map_err(|err| err.to_string())?;
            Ok(DirectoryEntry {
                name: entry.file_name().to_string_lossy().to_string(),
                is_directory: file_type.is_dir(),
                is_file: file_type.is_file(),
            })
        })
        .collect()
}

#[tauri::command]
fn reveal_file_in_folder(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let state = app.state::<FsAccessState>();
    let path =
        ensure_allowed_existing_supported_file(&state, &PathBuf::from(path), FileAction::Reveal)?;

    #[cfg(target_os = "windows")]
    {
        Command::new("explorer.exe")
            .arg("/select,")
            .arg(path)
            .spawn()
            .map(|_| ())
            .map_err(|err| err.to_string())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        Err("当前平台暂不支持打开文件位置".into())
    }
}

#[tauri::command]
fn take_pending_open_files(
    app: tauri::AppHandle,
    state: State<'_, PendingOpenFiles>,
) -> Vec<String> {
    let mut pending = state.0.lock().expect("pending open files lock poisoned");
    std::mem::take(&mut *pending)
        .into_iter()
        .filter_map(|path| {
            register_selected_file(&app, PathBuf::from(&path))
                .ok()
                .map(|_| path)
        })
        .collect()
}

#[tauri::command]
fn has_pending_open_files(state: State<'_, PendingOpenFiles>) -> bool {
    let pending = state.0.lock().expect("pending open files lock poisoned");
    !pending.is_empty()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let initial_cwd = std::env::current_dir().unwrap_or_default();
    let initial_paths = collect_open_file_paths(std::env::args_os().skip(1), &initial_cwd);
    let pending_open_files = PendingOpenFiles::default();
    enqueue_open_files(&pending_open_files, initial_paths);

    let mut builder = tauri::Builder::default()
        .manage(FsAccessState::default())
        .manage(ApiOriginState::default())
        .manage(rag_index::RagIndexService::default())
        .manage(pending_open_files)
        .on_webview_event(|webview, event| {
            if let tauri::WebviewEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                for path in paths {
                    let _ = register_selected_file(webview.app_handle(), path.clone());
                }
            }
        });

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            let paths = collect_open_file_paths(
                args.into_iter().skip(1).map(OsString::from),
                Path::new(&cwd),
            );
            if !paths.is_empty() {
                enqueue_open_files(app.state::<PendingOpenFiles>().inner(), paths);
                let _ = app.emit(OPEN_FILES_EVENT, ());
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }));
    }

    builder
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                if let Err(err) = restore_persisted_file_access(&app_handle) {
                    eprintln!("failed to restore persisted file access: {err}");
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            save_secret,
            load_secret,
            delete_secret,
            authorize_workspace_path,
            authorize_selected_path,
            migrate_legacy_file_access,
            prepare_markdown_assets_dir,
            read_text_file_by_path,
            write_text_file_by_path,
            read_binary_file_by_path,
            write_binary_file_by_path,
            create_text_file_by_path,
            path_exists,
            remove_file_by_path,
            create_dir_by_path,
            rename_text_file_by_path,
            read_dir_by_path,
            reveal_file_in_folder,
            take_pending_open_files,
            has_pending_open_files,
            api_http::authorize_api_origin,
            api_http::list_authorized_api_origins,
            api_http::revoke_api_origin,
            api_http::external_http_request,
            api_http::external_http_stream,
            database_transactions::persist_document_transaction,
            database_transactions::confirm_memory_candidate_transaction,
            database_transactions::import_backup_transaction,
            rag_index::get_rag_index_state,
            rag_index::initialize_rag_index,
            rag_index::search_rag_index,
            rag_index::refresh_rag_index_document,
            rag_index::remove_rag_index_document,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
