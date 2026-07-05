use serde::Serialize;
use std::fs::OpenOptions;
use std::{
    collections::{HashMap, HashSet},
    ffi::OsString,
    fs,
    path::{Component, Path, PathBuf},
    sync::Mutex,
};
use tauri::{Emitter, Manager, State};
use tauri_plugin_fs::FsExt;

const SECRET_FILE: &str = "secrets.json";
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

fn is_assets_dir_for_selected_markdown(selected_file: &Path, dir: &Path) -> bool {
    is_markdown_file_path(selected_file)
        && selected_file.parent().map(|parent| parent.join("assets")) == Some(dir.to_path_buf())
}

fn is_allowed_selected_assets_dir(state: &FsAccessState, path: &Path) -> Result<bool, String> {
    let selected_files = state
        .selected_files
        .lock()
        .map_err(|_| "selected file access state is poisoned".to_string())?;
    Ok(selected_files
        .iter()
        .any(|selected_file| is_assets_dir_for_selected_markdown(selected_file, path)))
}

fn ensure_allowed_read_file(state: &FsAccessState, path: &Path) -> Result<PathBuf, String> {
    ensure_allowed_text_file_path(path)?;
    let canonical = canonical_existing_file(path)?;
    if is_allowed_workspace_path(state, &canonical)? || is_allowed_selected_file(state, &canonical)?
    {
        Ok(canonical)
    } else {
        Err("file is outside the selected workspace".into())
    }
}

fn ensure_allowed_write_file(state: &FsAccessState, path: &Path) -> Result<PathBuf, String> {
    ensure_allowed_text_file_path(path)?;
    let normalized = normalized_target_path(path)?;
    if is_allowed_workspace_path(state, &normalized)?
        || is_allowed_selected_file(state, &normalized)?
    {
        Ok(normalized)
    } else {
        Err("file is outside the selected workspace".into())
    }
}

fn ensure_allowed_read_image_file(state: &FsAccessState, path: &Path) -> Result<PathBuf, String> {
    ensure_allowed_image_file_path(path)?;
    let canonical = canonical_existing_file(path)?;
    if is_allowed_workspace_path(state, &canonical)? || is_allowed_selected_file(state, &canonical)?
    {
        Ok(canonical)
    } else {
        Err("file is outside the selected workspace".into())
    }
}

fn ensure_allowed_write_image_file(state: &FsAccessState, path: &Path) -> Result<PathBuf, String> {
    ensure_allowed_image_file_path(path)?;
    let normalized = normalized_target_path(path)?;
    if is_allowed_workspace_path(state, &normalized)?
        || is_allowed_selected_file(state, &normalized)?
    {
        Ok(normalized)
    } else {
        Err("file is outside the selected workspace".into())
    }
}

fn ensure_allowed_dir(state: &FsAccessState, path: &Path) -> Result<PathBuf, String> {
    let canonical = canonical_dir(path)?;
    if is_allowed_workspace_path(state, &canonical)? {
        Ok(canonical)
    } else {
        Err("directory is outside the selected workspace".into())
    }
}

fn register_workspace(app: &tauri::AppHandle, path: PathBuf) -> Result<PathBuf, String> {
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
    Ok(canonical)
}

fn register_selected_file(app: &tauri::AppHandle, path: PathBuf) -> Result<PathBuf, String> {
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
    Ok(normalized)
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
    register_workspace(&app, PathBuf::from(path)).map(|_| ())
}

#[tauri::command]
fn authorize_selected_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    if path.exists() && path.is_dir() {
        register_workspace(&app, path).map(|_| ())
    } else {
        register_selected_file(&app, path).map(|_| ())
    }
}

#[tauri::command]
fn read_text_file_by_path(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let state = app.state::<FsAccessState>();
    let path = ensure_allowed_read_file(&state, &PathBuf::from(path))?;
    fs::read_to_string(path).map_err(|err| err.to_string())
}

#[tauri::command]
fn write_text_file_by_path(
    app: tauri::AppHandle,
    path: String,
    content: String,
) -> Result<(), String> {
    let state = app.state::<FsAccessState>();
    let path = ensure_allowed_write_file(&state, &PathBuf::from(path))?;
    fs::write(path, content).map_err(|err| err.to_string())
}

#[tauri::command]
fn read_binary_file_by_path(app: tauri::AppHandle, path: String) -> Result<Vec<u8>, String> {
    let state = app.state::<FsAccessState>();
    let path = ensure_allowed_read_image_file(&state, &PathBuf::from(path))?;
    fs::read(path).map_err(|err| err.to_string())
}

#[tauri::command]
fn write_binary_file_by_path(
    app: tauri::AppHandle,
    path: String,
    content: Vec<u8>,
) -> Result<(), String> {
    let state = app.state::<FsAccessState>();
    let path = ensure_allowed_write_image_file(&state, &PathBuf::from(path))?;
    fs::write(path, content).map_err(|err| err.to_string())
}

#[tauri::command]
fn create_text_file_by_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let state = app.state::<FsAccessState>();
    let path = ensure_allowed_write_file(&state, &PathBuf::from(path))?;
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map(|_| ())
        .map_err(|err| err.to_string())
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
    let is_selected_assets_dir = is_allowed_selected_assets_dir(&state, &path)?;
    let path = if is_selected_assets_dir {
        ensure_safe_path(&path)?;
        path
    } else {
        ensure_allowed_dir(&state, parent)?.join(dir_name)
    };
    if is_selected_assets_dir && path.is_dir() {
        return register_workspace(&app, path).map(|_| ());
    }
    fs::create_dir(&path).map_err(|err| err.to_string())?;
    register_workspace(&app, path).map(|_| ())
}

#[tauri::command]
fn prepare_markdown_assets_dir(app: tauri::AppHandle, markdown_path: String) -> Result<(), String> {
    let markdown_path = canonical_existing_file(&PathBuf::from(markdown_path))?;
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
    register_workspace(&app, assets_dir).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::is_assets_dir_for_selected_markdown;
    use std::path::Path;

    #[test]
    fn allows_only_assets_dir_next_to_selected_markdown() {
        let markdown = Path::new(r"C:\notes\draft.md");

        assert!(is_assets_dir_for_selected_markdown(
            markdown,
            Path::new(r"C:\notes\assets")
        ));
        assert!(!is_assets_dir_for_selected_markdown(
            markdown,
            Path::new(r"C:\notes\images")
        ));
        assert!(!is_assets_dir_for_selected_markdown(
            markdown,
            Path::new(r"C:\assets")
        ));
    }
}

#[tauri::command]
fn rename_text_file_by_path(
    app: tauri::AppHandle,
    old_path: String,
    new_path: String,
) -> Result<(), String> {
    let state = app.state::<FsAccessState>();
    let old_path = ensure_allowed_read_file(&state, &PathBuf::from(old_path))?;
    let new_path = ensure_allowed_write_file(&state, &PathBuf::from(new_path))?;
    if new_path.exists() {
        return Err("file already exists".into());
    }
    fs::rename(old_path, new_path).map_err(|err| err.to_string())
}

#[tauri::command]
fn read_dir_by_path(app: tauri::AppHandle, path: String) -> Result<Vec<DirectoryEntry>, String> {
    let state = app.state::<FsAccessState>();
    let path = PathBuf::from(path);
    let canonical = if state
        .workspaces
        .lock()
        .map_err(|_| "workspace access state is poisoned".to_string())?
        .is_empty()
    {
        register_workspace(&app, path)?
    } else {
        ensure_allowed_dir(&state, &path)?
    };
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
fn take_pending_open_files(state: State<'_, PendingOpenFiles>) -> Vec<String> {
    let mut pending = state.0.lock().expect("pending open files lock poisoned");
    std::mem::take(&mut *pending)
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
        .manage(pending_open_files);

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
        .invoke_handler(tauri::generate_handler![
            save_secret,
            load_secret,
            delete_secret,
            authorize_workspace_path,
            authorize_selected_path,
            prepare_markdown_assets_dir,
            read_text_file_by_path,
            write_text_file_by_path,
            read_binary_file_by_path,
            write_binary_file_by_path,
            create_text_file_by_path,
            create_dir_by_path,
            rename_text_file_by_path,
            read_dir_by_path,
            take_pending_open_files,
            has_pending_open_files,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
